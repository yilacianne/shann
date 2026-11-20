const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { HttpError, MAX_ROOM_IMAGE_BYTES, createApi } = require("./api");
const {
  PASSWORD_MAX,
  dummyHashHex,
  dummySaltHex,
  findAccountByUsername,
  isUniqueError,
  openStore,
  publicUser,
  verifyPassword
} = require("./store");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const sessionCookie = "dms_session";
const maxBodyBytes = 16 * 1024;
const maxRoomPhotoBodyBytes = Math.ceil(MAX_ROOM_IMAGE_BYTES * 4 / 3) + 4096;
const maxPaymentProofBodyBytes = maxRoomPhotoBodyBytes;
const publicDir = path.join(__dirname, "public");
const db = openStore();
const api = createApi(db);
const failedLogins = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml"
};
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};

function sendJson(res, status, value) {
  res.writeHead(status, { ...securityHeaders, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function redirect(res, location) {
  res.writeHead(303, { ...securityHeaders, Location: location, "Cache-Control": "no-store" });
  res.end();
}

// Mutating requests must come from this same site (the page that was served by this server).
function allowSameOrigin(req) {
  const origin = req.headers.origin;
  const requestHost = req.headers.host;
  if (!origin || !requestHost) return false;
  try {
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

async function readJson(req, bodyLimit = maxBodyBytes) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send the request as JSON.");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > bodyLimit) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value;
}

const useSecureCookie = (req) => Boolean(req.socket.encrypted) || process.env.DMS_COOKIE_SECURE === "true";
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

function sessionToken(req) {
  for (const cookie of String(req.headers.cookie || "").split(";")) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name === sessionCookie) return parts.join("=");
  }
  return "";
}

function getSessionUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  return db.prepare(`
    SELECT accounts.* FROM sessions JOIN accounts ON accounts.id = sessions.account_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashToken(token), Date.now()) || null;
}

function issueSession(req, res, account, remember) {
  const now = Date.now();
  const maxAgeSeconds = remember ? 30 * 24 * 60 * 60 : 12 * 60 * 60;
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), account.id, now + maxAgeSeconds * 1000, now);
  const attributes = [`${sessionCookie}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (remember) attributes.push(`Max-Age=${maxAgeSeconds}`);
  if (useSecureCookie(req)) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(req, res) {
  const attributes = [`${sessionCookie}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (useSecureCookie(req)) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

// Only failed sign-ins count toward the limit; a successful sign-in clears it.
function loginKey(req) {
  return req.socket.remoteAddress || "unknown";
}
function isLockedOut(req) {
  const now = Date.now();
  for (const [key, entry] of failedLogins) if (entry.expiresAt <= now) failedLogins.delete(key);
  const entry = failedLogins.get(loginKey(req));
  return Boolean(entry && entry.count >= 10);
}
function recordFailure(req) {
  const key = loginKey(req);
  const entry = failedLogins.get(key) || { count: 0, expiresAt: Date.now() + 15 * 60 * 1000 };
  entry.count += 1;
  failedLogins.set(key, entry);
}

api.add("GET", "/api/auth/me", "any", ({ user }) => ({ user: publicUser(user) }));

api.add("POST", "/api/auth/login", "public", ({ req, res, body }) => {
  if (isLockedOut(req)) throw new HttpError(429, "Too many sign-in attempts. Please wait a few minutes and try again.");
  const name = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name || name.length > 64 || !password || password.length > PASSWORD_MAX) {
    throw new HttpError(400, "Enter your username and password.");
  }
  const account = findAccountByUsername(db, name);
  const matches = verifyPassword(
    password,
    account ? account.password_salt : dummySaltHex,
    account ? account.password_hash : dummyHashHex
  );
  if (!account || !["admin", "resident"].includes(account.role) || !matches) {
    recordFailure(req);
    throw new HttpError(401, "Incorrect username or password.");
  }
  failedLogins.delete(loginKey(req));
  issueSession(req, res, account, Boolean(body.remember));
  return { user: publicUser(account) };
});

api.add("POST", "/api/auth/register", "public", () => {
  throw new HttpError(403, "Resident registration is closed. Please contact the administrator.");
});

api.add("POST", "/api/auth/logout", "public", ({ req, res }) => {
  const token = sessionToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  clearSessionCookie(req, res);
  return { ok: true };
});

async function handleApi(req, res, url) {
  let route = null;
  let params = {};
  let pathMatched = false;
  for (const candidate of api.routes) {
    const match = candidate.regex.exec(url.pathname);
    if (!match) continue;
    pathMatched = true;
    if (candidate.method === req.method) {
      route = candidate;
      params = match.groups || {};
      break;
    }
  }
  if (!route) return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? "Method not allowed." : "Not found." });
  if (req.method !== "GET" && !allowSameOrigin(req)) return sendJson(res, 403, { error: "Request origin was not accepted." });

  const user = getSessionUser(req);
  if (route.access !== "public") {
    if (!user) return sendJson(res, 401, { error: "Please sign in to continue." });
    if (route.access === "admin" && user.role !== "admin") return sendJson(res, 403, { error: "Administrator access is required." });
    if (route.access === "resident" && user.role !== "resident") return sendJson(res, 403, { error: "Resident access is required." });
  }

  const roomWrite = /^\/api\/admin\/rooms(?:\/\d+)?$/.test(url.pathname);
  const paymentProofWrite = /^\/api\/me\/payments\/(?:\d+\/or|deposit|monthly)$/.test(url.pathname);
  const body = ["POST", "PATCH", "PUT"].includes(req.method)
    ? await readJson(req, roomWrite || paymentProofWrite ? maxPaymentProofBodyBytes : maxBodyBytes)
    : undefined;
  const result = await route.handler({ req, res, user, body, params, query: url.searchParams });
  if (result && typeof result === "object" && typeof result.status === "number" && "data" in result) {
    return sendJson(res, result.status, result.data);
  }
  return sendJson(res, 200, result);
}

const homeFor = (account) => (account.role === "admin" ? "/index.html" : "/resident.html");

function handleStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed." });

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }
  if (pathname === "/") return redirect(res, "/login.html");

  const account = getSessionUser(req);
  if (pathname === "/index.html") {
    if (!account) return redirect(res, "/login.html");
    if (account.role !== "admin") return redirect(res, "/resident.html");
  }
  if (pathname === "/resident.html") {
    if (!account) return redirect(res, "/login.html");
    if (account.role !== "resident") return redirect(res, "/index.html");
  }
  if (pathname === "/login.html" && account) return redirect(res, homeFor(account));

  const filePath = path.join(publicDir, pathname);
  const contentType = mimeTypes[path.extname(filePath).toLowerCase()];
  if (!contentType || pathname.includes("\0") || !filePath.startsWith(publicDir + path.sep)) {
    return sendJson(res, 404, { error: "Not found." });
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) return sendJson(res, error.code === "ENOENT" || error.code === "EISDIR" ? 404 : 500, { error: "Not found." });
    res.writeHead(200, { ...securityHeaders, "Cache-Control": "no-cache", "Content-Type": contentType });
    res.end(req.method === "HEAD" ? undefined : contents);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return handleStatic(req, res, url);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
    if (isUniqueError(error, "accounts.username")) return sendJson(res, 409, { error: "That username is already taken." });
    console.error("Request failed:", error);
    return sendJson(res, 500, { error: "Something went wrong on the server." });
  }
});

server.listen(port, host, () => {
  console.log(`Dormitory Management System listening on http://${host}:${server.address().port}`);
  if (process.env.DMS_COOKIE_SECURE !== "true") {
    console.log("Local HTTP mode: use HTTPS and set DMS_COOKIE_SECURE=true for deployment.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
