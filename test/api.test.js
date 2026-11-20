const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { after, before, test } = require("node:test");

let child;
let base;
let tempDir;
const adminPassword = "admin-test-password";
const residentPassword = "resident-test-password";

function startServer(dbPath) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DMS_DB_PATH: dbPath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    });
    child.on("exit", (code) => reject(new Error(`Server exited early (${code})`)));
  });
}

class Client {
  constructor() { this.cookie = ""; }
  async request(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      redirect: "manual",
      headers: {
        Origin: base,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.startsWith("dms_session=;") ? "" : setCookie.split(";")[0];
    const type = res.headers.get("content-type") || "";
    return { status: res.status, headers: res.headers, data: type.includes("json") ? await res.json() : await res.text() };
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-test-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  // Create the admin directly in the database the server will use.
  const store = require("../store");
  const db = store.openStore(dbPath);
  store.createAccount(db, { username: "boss", name: "The Boss", password: adminPassword, role: "admin" });
  db.close();
  base = await startServer(dbPath);
});

after(async () => {
  child.removeAllListeners("exit");
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await stopped;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("static pages are served and protected", async () => {
  const anon = new Client();
  const login = await anon.request("GET", "/login.html");
  assert.equal(login.status, 200);
  assert.match(login.data, /Dormitory/);
  assert.equal((await anon.request("GET", "/register.html")).status, 200);
  const logo = await anon.request("GET", "/assets/logo.jpg");
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/jpeg");
  assert.equal((await anon.request("GET", "/index.html")).status, 303);
  assert.equal((await anon.request("GET", "/resident.html")).status, 303);
  assert.equal((await anon.request("GET", "/server.js")).status, 404);
  assert.equal((await anon.request("GET", "/..%2fserver.js")).status, 404);
  assert.equal((await anon.request("GET", "/api/admin/residents")).status, 401);
});

test("existing databases gain room photos, visitor status and payment verification fields", () => {
  const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-migration-"));
  const dbPath = path.join(migrationDir, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY);
      CREATE TABLE rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, capacity INTEGER NOT NULL,
        rent INTEGER NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE visitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_name TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), visited_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, amount INTEGER NOT NULL,
        status TEXT NOT NULL, due_date TEXT NOT NULL, paid_date TEXT, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
      );
      INSERT INTO accounts (id) VALUES ('legacy-resident');
      INSERT INTO rooms (number, capacity, rent, status) VALUES ('old-room', 1, 0, 'available');
      INSERT INTO visitors (visitor_name, account_id, visited_at, created_at)
      VALUES ('Old visitor', 'legacy-resident', 1700000000000, 1700000000000);
    `);
    legacy.close();

    const upgraded = require("../store").openStore(dbPath);
    assert.equal(upgraded.prepare("SELECT photo_data FROM rooms WHERE number = 'old-room'").get().photo_data, "");
    assert.equal(upgraded.prepare("SELECT status FROM visitors WHERE visitor_name = 'Old visitor'").get().status, "approved");
    const accountColumns = upgraded.prepare("PRAGMA table_info(accounts)").all().map((column) => column.name);
    assert.ok(accountColumns.includes("parent_name"));
    assert.ok(accountColumns.includes("parent_phone"));
    assert.ok(accountColumns.includes("status"));
    assert.ok(accountColumns.includes("move_in_date"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "or_number"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "payment_type"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "recorded_by"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "paid_amount"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "billing_frequency"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "or_image_data"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "or_verification_status"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "is_security_deposit"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "is_downpayment"));
    assert.ok(upgraded.prepare("PRAGMA table_info(payments)").all().some((column) => column.name === "or_submitted_amount"));
    const migratedPaymentId = Number(upgraded.prepare("INSERT INTO payments (account_id, amount, status, due_date, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-resident", 100, "pending", "2026-01-01", Date.now()).lastInsertRowid);
    assert.equal(upgraded.prepare("SELECT or_verification_status, or_image_data FROM payments WHERE id = ?").get(migratedPaymentId).or_verification_status, "none");
    const legacyOrPaymentId = Number(upgraded.prepare(`INSERT INTO payments
      (account_id, amount, paid_amount, status, due_date, paid_date, or_number, recorded_by, created_at)
      VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?)`)
      .run("legacy-resident", 100, 100, "2026-01-01", "2026-01-01", "OR-LEGACY", "legacy-resident", Date.now()).lastInsertRowid);
    assert.equal(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get().name, "notifications");
    upgraded.close();

    const pendingDb = require("../store").openStore(dbPath);
    const reopenedOr = pendingDb.prepare("SELECT status, paid_amount, paid_date, or_number, recorded_by, or_verification_status FROM payments WHERE id = ?").get(legacyOrPaymentId);
    assert.equal(reopenedOr.status, "pending");
    assert.equal(reopenedOr.paid_amount, null);
    assert.equal(reopenedOr.paid_date, null);
    assert.equal(reopenedOr.or_number, "OR-LEGACY");
    assert.equal(reopenedOr.recorded_by, null);
    assert.equal(reopenedOr.or_verification_status, "none");
    const visitorId = Number(pendingDb.prepare("INSERT INTO visitors (visitor_name, account_id, visited_at, created_at, status) VALUES (?, ?, ?, ?, 'pending')")
      .run("Pending visitor", "legacy-resident", 1700000000000, 1700000000000).lastInsertRowid);
    pendingDb.prepare("INSERT INTO notifications (account_id, visitor_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-resident", visitorId, "New visitor log submission", "Review this entry.", 1700000000000);
    pendingDb.close();

    const migrated = require("../store").openStore(dbPath);
    assert.equal(migrated.prepare("SELECT status FROM visitors WHERE id = ?").get(visitorId).status, "approved");
    assert.ok(migrated.prepare("SELECT read_at FROM notifications WHERE visitor_id = ?").get(visitorId).read_at);
    migrated.close();
  } finally {
    fs.rmSync(migrationDir, { recursive: true, force: true });
  }
});

test("login detects the account role and rejects wrong credentials", async () => {
  const c = new Client();
  assert.equal((await c.request("POST", "/api/auth/login", { username: "boss", password: "nope-nope-nope" })).status, 401);
  const login = await c.request("POST", "/api/auth/login", { username: "boss", password: adminPassword, role: "resident" });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, "admin");
  const foreign = await new Client().request("POST", "/api/auth/login", { username: "boss", password: adminPassword }, { Origin: "http://evil.example" });
  assert.equal(foreign.status, 403);
});

test("public resident registration is disabled", async () => {
  const anonymous = new Client();
  const page = await anonymous.request("GET", "/register.html");
  assert.equal(page.status, 200);
  assert.match(page.data, /registration closed/i);
  const attempt = await anonymous.request("POST", "/api/auth/register", {
    name: "New Resident", username: "new.resident", password: residentPassword
  });
  assert.equal(attempt.status, 403);
});

test("admin manages rooms, residents, payments, notices, visitors and curfew; resident sees own data", async () => {
  const admin = new Client();
  const login = await admin.request("POST", "/api/auth/login", { username: "BOSS", password: adminPassword, remember: true });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, "admin");
  assert.equal((await admin.request("GET", "/index.html")).status, 200);
  assert.equal((await admin.request("GET", "/resident.html")).status, 303);

  // Admin accounts
  const accounts = await admin.request("GET", "/api/admin/accounts");
  assert.equal(accounts.status, 200);
  assert.equal(accounts.data.accounts.length, 1);
  const createdAdmin = await admin.request("POST", "/api/admin/accounts", {
    name: "Second Admin", username: "second.admin", password: "second-admin-password", email: "second@example.com"
  });
  assert.equal(createdAdmin.status, 201);
  assert.equal((await admin.request("POST", "/api/admin/accounts", {
    name: "Missing Email", username: "missing.email", password: "another-admin-password"
  })).status, 400);
  const secondAdmin = createdAdmin.data.account;
  const updatedAdmin = await admin.request("PATCH", `/api/admin/accounts/${secondAdmin.id}`, {
    name: "Updated Admin", username: "updated.admin", phone: "09170000000"
  });
  assert.equal(updatedAdmin.data.account.name, "Updated Admin");
  assert.equal(updatedAdmin.data.account.username, "updated.admin");
  assert.equal(updatedAdmin.data.account.email, "second@example.com");
  assert.equal(updatedAdmin.data.account.phone, "09170000000");
  assert.equal((await admin.request("PATCH", `/api/admin/accounts/${secondAdmin.id}`, { username: "boss" })).status, 409);
  assert.equal((await admin.request("PATCH", `/api/admin/accounts/${secondAdmin.id}`, { email: "invalid" })).status, 400);
  assert.equal((await admin.request("PATCH", `/api/admin/accounts/${secondAdmin.id}`, { email: "" })).status, 400);
  assert.equal((await admin.request("PATCH", `/api/admin/accounts/${secondAdmin.id}`, { password: "short" })).status, 400);
  const secondAdminSession = new Client();
  assert.equal((await secondAdminSession.request("POST", "/api/auth/login", {
    role: "admin", username: "updated.admin", password: "second-admin-password"
  })).status, 200);
  assert.equal((await admin.request("PATCH", `/api/admin/accounts/${secondAdmin.id}`, {
    password: "second-admin-new-password"
  })).status, 200);
  assert.equal((await secondAdminSession.request("GET", "/api/auth/me")).status, 401);
  assert.equal((await new Client().request("POST", "/api/auth/login", {
    role: "admin", username: "updated.admin", password: "second-admin-password"
  })).status, 401);
  assert.equal((await new Client().request("POST", "/api/auth/login", {
    role: "admin", username: "updated.admin", password: "second-admin-new-password"
  })).status, 200);
  assert.equal((await admin.request("PATCH", `/api/admin/accounts/not-found`, { name: "Nobody" })).status, 404);

  // Rooms
  const roomPhoto = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lE8AAAAASUVORK5CYII=";
  const room = (await admin.request("POST", "/api/admin/rooms", {
    number: "101", capacity: 1, rent: 1500, photoData: roomPhoto
  })).data.room;
  assert.equal(room.status, "available");
  assert.equal(room.photoData, roomPhoto);
  assert.equal((await admin.request("POST", "/api/admin/rooms", { number: "101", capacity: 2 })).status, 409);
  assert.equal((await admin.request("POST", "/api/admin/rooms", { number: "X", capacity: 0 })).status, 400);
  assert.equal((await admin.request("POST", "/api/admin/rooms", {
    number: "bad-photo", capacity: 1, photoData: "data:image/png;base64,SGVsbG8="
  })).status, 400);

  // Residents
  const bad = await admin.request("POST", "/api/admin/residents", { name: "Maria Santos", username: "maria", password: "short" });
  assert.equal(bad.status, 400);
  const created = await admin.request("POST", "/api/admin/residents", {
    name: "Maria Santos", username: "maria", password: residentPassword, email: "maria@example.com", phone: "09171234567",
    parentName: "Ana Santos", parentPhone: "09179876543", roomId: room.id
  });
  assert.equal(created.status, 201);
  const maria = created.data.resident;
  assert.equal(maria.roomNumber, "101");
  assert.equal(maria.parentName, "Ana Santos");
  assert.equal(maria.parentPhone, "09179876543");
  assert.equal((await admin.request("POST", "/api/admin/residents", { name: "Missing contacts", username: "missing.contacts", password: residentPassword })).status, 400);
  assert.equal((await admin.request("POST", "/api/admin/residents", {
    name: "Dup", username: "MARIA", password: residentPassword, email: "dup@example.com", phone: "09170000000",
    parentName: "Parent", parentPhone: "09170000001"
  })).status, 409);
  const full = await admin.request("POST", "/api/admin/residents", {
    name: "Juan", username: "juan", password: residentPassword, email: "juan@example.com", phone: "09171111111",
    parentName: "Parent Cruz", parentPhone: "09172222222", roomId: room.id
  });
  assert.equal(full.status, 409);
  const juan = (await admin.request("POST", "/api/admin/residents", {
    name: "Juan Dela Cruz", username: "juan", password: residentPassword, email: "juan@example.com", phone: "09171111111",
    parentName: "Parent Cruz", parentPhone: "09172222222"
  })).data.resident;
  const edited = await admin.request("PATCH", `/api/admin/residents/${juan.id}`, { phone: "0917", parentPhone: "09173333333", roomId: null });
  assert.equal(edited.data.resident.phone, "0917");
  assert.equal(edited.data.resident.parentPhone, "09173333333");
  assert.equal((await admin.request("PATCH", `/api/admin/residents/${juan.id}`, { email: "" })).status, 400);
  assert.equal((await admin.request("PATCH", `/api/admin/residents/${juan.id}`, { roomId: room.id })).status, 409);
  assert.equal((await admin.request("GET", "/api/admin/residents")).data.residents.length, 2);

  // Payments
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const paid = await admin.request("POST", "/api/admin/payments", {
    accountId: maria.id, amount: 1500, status: "paid", dueDate: "2025-01-15", orNumber: "OR-2026-001"
  });
  assert.equal(paid.status, 201);
  const today = new Date();
  assert.equal(paid.data.payment.paidDate, `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`);
  assert.equal(paid.data.payment.orNumber, "OR-2026-001");
  const late = await admin.request("POST", "/api/admin/payments", { accountId: maria.id, amount: 1500, status: "pending", dueDate: yesterday });
  assert.equal(late.data.payment.status, "overdue");
  assert.equal((await admin.request("POST", "/api/admin/payments", { accountId: maria.id, amount: -5, dueDate: yesterday })).status, 400);
  const recordable = await admin.request("POST", "/api/admin/payments", {
    accountId: maria.id, amount: 700, status: "pending", dueDate: "2999-01-01", billingFrequency: "Weekly"
  });
  assert.equal(recordable.data.payment.billingFrequency, "Weekly");
  assert.equal((await admin.request("PUT", "/api/payments/record", {
    payment_id: recordable.data.payment.id, or_number: "OR-2026-001", amount_paid: 700
  })).status, 422);
  assert.equal((await admin.request("PUT", "/api/payments/record", {
    payment_id: recordable.data.payment.id, or_number: "OR-2026-003", amount_paid: 699
  })).status, 422);
  const recorded = await admin.request("PUT", "/api/payments/record", {
    payment_id: recordable.data.payment.id, or_number: "OR-2026-003", amount_paid: 725
  });
  assert.equal(recorded.status, 200);
  assert.equal(recorded.data.payment.status, "paid");
  assert.equal(recorded.data.payment.amount, 700);
  const history = await admin.request("GET", "/api/payments/history");
  assert.equal(history.status, 200);
  assert.ok(history.data.payments.some((payment) => payment.id === recordable.data.payment.id && payment.amount === 725 && payment.billingFrequency === "Weekly" && payment.recordedBy === "The Boss"));
  const mariaPaymentSession = new Client();
  assert.equal((await mariaPaymentSession.request("POST", "/api/auth/login", { username: "maria", password: residentPassword })).status, 200);
  const receiptImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=";
  assert.equal((await mariaPaymentSession.request("POST", `/api/me/payments/${late.data.payment.id}/or`, {
    orNumber: "OR-MARIA-BAD", orImageData: "data:image/png;base64,YQ=="
  })).status, 400);
  const submittedLateOr = await mariaPaymentSession.request("POST", `/api/me/payments/${late.data.payment.id}/or`, {
    orNumber: "OR-MARIA-VERIFY", orImageData: receiptImage
  });
  assert.equal(submittedLateOr.status, 200);
  assert.equal(submittedLateOr.data.payment.status, "overdue");
  assert.equal(submittedLateOr.data.payment.orNumber, "OR-MARIA-VERIFY");
  assert.equal(submittedLateOr.data.payment.verificationStatus, "pending");
  assert.equal(submittedLateOr.data.payment.hasOrImage, true);
  assert.equal((await mariaPaymentSession.request("POST", `/api/me/payments/${late.data.payment.id}/or`, {
    orNumber: "OR-MARIA-REPLACEMENT"
  })).status, 409);
  const correctedLateOr = await mariaPaymentSession.request("PATCH", `/api/me/payments/${late.data.payment.id}/or`, {
    orNumber: "OR-MARIA-CORRECTED"
  });
  assert.equal(correctedLateOr.status, 200);
  assert.equal(correctedLateOr.data.payment.hasOrImage, true);
  const replacedLateReceipt = await mariaPaymentSession.request("PATCH", `/api/me/payments/${late.data.payment.id}/or`, {
    orNumber: "OR-MARIA-CORRECTED", orImageData: roomPhoto
  });
  assert.equal(replacedLateReceipt.status, 200);
  assert.equal((await mariaPaymentSession.request("GET", `/api/admin/payments/${late.data.payment.id}/proof`)).status, 403);
  assert.equal((await admin.request("GET", `/api/admin/payments/${late.data.payment.id}/proof`)).data.orImageData, roomPhoto);
  const rejectedOr = await admin.request("PATCH", `/api/admin/payments/${late.data.payment.id}/verification`, { decision: "rejected" });
  assert.equal(rejectedOr.data.payment.status, "overdue");
  assert.equal(rejectedOr.data.payment.verificationStatus, "rejected");
  const resubmittedOr = await mariaPaymentSession.request("POST", `/api/me/payments/${late.data.payment.id}/or`, {
    orNumber: "OR-MARIA-VERIFY-2"
  });
  assert.equal(resubmittedOr.data.payment.verificationStatus, "pending");
  assert.equal(resubmittedOr.data.payment.hasOrImage, false);
  const settled = await admin.request("PATCH", `/api/admin/payments/${late.data.payment.id}/verification`, { decision: "verified" });
  assert.equal(settled.data.payment.status, "paid");
  assert.equal(settled.data.payment.verificationStatus, "verified");
  assert.ok(settled.data.payment.paidDate);
  assert.equal(settled.data.payment.orNumber, "OR-MARIA-VERIFY-2");
  await admin.request("POST", "/api/admin/payments", { accountId: juan.id, amount: 1200, status: "pending", dueDate: "2999-01-01" });

  const summary = (await admin.request("GET", "/api/admin/summary")).data;
  assert.equal(summary.residents, 2);
  assert.equal(summary.rooms, 1);
  assert.equal(summary.collected, 3725);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.monthly.length, 6);

  // Bed assignment, resident lifecycle and reservation billing.
  const secondRoom = (await admin.request("POST", "/api/admin/rooms", {
    number: "102", capacity: 2, rent: 1200
  })).data.room;
  const thirdRoom = (await admin.request("POST", "/api/admin/rooms", {
    number: "103", capacity: 1, rent: 900
  })).data.room;
  assert.equal(secondRoom.availableBeds, 2);
  assert.ok((await admin.request("GET", "/api/admin/residents/unassigned")).data.residents.some((resident) => resident.id === juan.id));
  const reserved = await admin.request("POST", `/api/admin/rooms/${secondRoom.id}/assign`, {
    residentId: juan.id, reservationOnly: true
  });
  assert.equal(reserved.status, 201);
  assert.equal(reserved.data.resident.status, "Reserved");
  assert.equal(reserved.data.payment.amount, 1200);
  assert.equal(reserved.data.payment.paymentType, "Reservation Fee");
  assert.equal((await admin.request("GET", "/api/admin/rooms")).data.rooms.find((room) => room.id === secondRoom.id).availableBeds, 1);
  const roomResidents = await admin.request("GET", `/api/admin/rooms/${secondRoom.id}/residents`);
  assert.equal(roomResidents.data.residents[0].contactInfo, "0917 · juan@example.com");
  assert.equal((await admin.request("POST", `/api/admin/residents/${juan.id}/move-out`, {})).status, 409);
  assert.equal((await admin.request("PATCH", `/api/admin/payments/${reserved.data.payment.id}`, { status: "paid" })).status, 200);
  const juanPayments = (await admin.request("GET", "/api/admin/payments")).data.payments;
  for (const payment of juanPayments.filter((item) => item.accountId === juan.id && ["pending", "overdue"].includes(item.status))) {
    await admin.request("PATCH", `/api/admin/payments/${payment.id}`, { status: "paid" });
  }
  const movedOutJuan = await admin.request("POST", `/api/admin/residents/${juan.id}/move-out`, {});
  assert.equal(movedOutJuan.status, 200, JSON.stringify(movedOutJuan.data));
  assert.equal(movedOutJuan.data.resident.status, "Moved Out");
  assert.equal((await admin.request("GET", "/api/admin/rooms")).data.rooms.find((room) => room.id === secondRoom.id).availableBeds, 2);
  const movedOutJuanSession = new Client();
  assert.equal((await movedOutJuanSession.request("POST", "/api/auth/login", {
    username: "juan", password: residentPassword
  })).status, 200);
  const roomlessAdvance = await movedOutJuanSession.request("POST", "/api/me/payments/advance", { amount: 900 });
  assert.equal(roomlessAdvance.status, 201);
  assert.equal(roomlessAdvance.data.payment.paymentType, "Monthly Rent");
  assert.equal(roomlessAdvance.data.payment.amount, 900);

  const carol = (await admin.request("POST", "/api/admin/residents", {
    name: "Carol Resident", username: "carol", password: residentPassword, email: "carol@example.com", phone: "09170000002",
    parentName: "Parent Resident", parentPhone: "09170000003"
  })).data.resident;
  assert.equal(carol.status, "Unassigned");
  const carolAssigned = (await admin.request("POST", `/api/admin/rooms/${secondRoom.id}/assign`, { residentId: carol.id })).data.resident;
  assert.equal(carolAssigned.status, "Active");
  assert.equal((await admin.request("PATCH", `/api/admin/residents/${carol.id}/status`, { status: "On Leave" })).data.resident.status, "On Leave");
  assert.equal((await admin.request("GET", "/api/admin/rooms")).data.rooms.find((room) => room.id === secondRoom.id).availableBeds, 1);
  const transferred = await admin.request("POST", `/api/admin/residents/${carol.id}/transfer`, { roomId: thirdRoom.id });
  assert.equal(transferred.data.resident.roomNumber, "103");
  const roomsAfterTransfer = (await admin.request("GET", "/api/admin/rooms")).data.rooms;
  assert.equal(roomsAfterTransfer.find((room) => room.id === secondRoom.id).availableBeds, 2);
  assert.equal(roomsAfterTransfer.find((room) => room.id === thirdRoom.id).availableBeds, 0);
  assert.equal((await admin.request("PATCH", `/api/admin/residents/${carol.id}/status`, { status: "Active" })).data.resident.status, "Active");
  const monthlyInvoices = (await admin.request("GET", "/api/admin/payments")).data.payments.filter((payment) =>
    payment.accountId === carol.id && payment.paymentType === "Monthly Rent" && payment.billingFrequency === "Monthly"
  );
  assert.equal(monthlyInvoices.length, 1);
  assert.equal(monthlyInvoices[0].amount, 900);
  assert.equal(monthlyInvoices[0].dueDate, carolAssigned.moveInDate);
  assert.equal((await admin.request("GET", "/api/admin/payments")).data.payments.filter((payment) =>
    payment.accountId === carol.id && payment.paymentType === "Monthly Rent" && payment.billingFrequency === "Monthly"
  ).length, 1);
  assert.equal((await admin.request("POST", `/api/admin/residents/${carol.id}/move-out`, {})).status, 409);

  const carolSession = new Client();
  assert.equal((await carolSession.request("POST", "/api/auth/login", { username: "carol", password: residentPassword })).status, 200);
  assert.equal((await carolSession.request("POST", `/api/me/payments/${late.data.payment.id}/or`, { orNumber: "OR-CAROL-001" })).status, 404);
  assert.equal((await carolSession.request("POST", `/api/me/payments/${monthlyInvoices[0].id}/or`, { orNumber: "OR-2026-001" })).status, 422);
  const submittedOr = await carolSession.request("POST", `/api/me/payments/${monthlyInvoices[0].id}/or`, { orNumber: "OR-CAROL-001" });
  assert.equal(submittedOr.status, 200);
  assert.equal(submittedOr.data.payment.status, "pending");
  assert.equal(submittedOr.data.payment.verificationStatus, "pending");
  assert.equal(submittedOr.data.payment.orNumber, "OR-CAROL-001");
  assert.equal(submittedOr.data.payment.paidDate, null);
  const correctedOr = await carolSession.request("PATCH", `/api/me/payments/${monthlyInvoices[0].id}/or`, {
    orNumber: "OR-CAROL-CORRECTED"
  });
  assert.equal(correctedOr.status, 200);
  assert.equal(correctedOr.data.payment.orNumber, "OR-CAROL-CORRECTED");
  assert.equal((await admin.request("POST", `/api/admin/residents/${carol.id}/move-out`, {})).status, 409);
  const verifiedOr = await admin.request("PATCH", `/api/admin/payments/${monthlyInvoices[0].id}/verification`, { decision: "verified" });
  assert.equal(verifiedOr.data.payment.status, "paid");
  assert.equal((await carolSession.request("PATCH", `/api/me/payments/${monthlyInvoices[0].id}/or`, {
    orNumber: "OR-CAROL-TOO-LATE"
  })).status, 409);
  const carolHistory = await admin.request("GET", "/api/payments/history");
  assert.ok(carolHistory.data.payments.some((payment) => payment.id === monthlyInvoices[0].id && payment.recordedBy === "The Boss"));
  assert.equal((await admin.request("POST", `/api/admin/residents/${carol.id}/move-out`, {})).data.resident.roomId, null);
  assert.equal((await admin.request("GET", "/api/admin/rooms")).data.rooms.find((room) => room.id === thirdRoom.id).availableBeds, 1);

  // Notices, reminders, visitors
  const announcementTime = Date.now() - 60000;
  assert.equal((await admin.request("POST", "/api/admin/announcements", {
    title: "Rules", body: "Keep it clean.", publishedAt: announcementTime
  })).status, 201);
  assert.equal((await admin.request("POST", "/api/admin/announcements", {
    title: "Bad date", body: "Invalid timestamp.", publishedAt: "tomorrow"
  })).status, 400);
  const announcement = (await admin.request("GET", "/api/announcements")).data.announcements[0];
  assert.equal(announcement.createdAt, announcementTime);
  assert.equal((await admin.request("POST", "/api/admin/reminders", { kind: "payment", title: "Pay rent", dueDate: "2999-01-25" })).status, 201);
  assert.equal((await admin.request("POST", "/api/admin/reminders", { kind: "bogus", title: "x" })).status, 400);
  assert.equal((await admin.request("POST", "/api/admin/visitors", { visitorName: "John Ten", accountId: maria.id, visitedAt: Date.now() })).status, 201);
  assert.equal((await admin.request("GET", "/api/admin/visitors")).data.visitors[0].residentName, "Maria Santos");

  // Curfew
  assert.equal((await admin.request("PATCH", "/api/admin/curfew", { curfewTime: "25:00" })).status, 400);
  assert.equal((await admin.request("PATCH", "/api/admin/curfew", { curfewTime: "22:00" })).status, 200);
  assert.equal((await admin.request("POST", "/api/admin/curfew/log", { accountId: maria.id, time: "21:30" })).status, 404);
  const curfew = (await admin.request("GET", "/api/admin/curfew")).data;
  assert.deepEqual(curfew, { curfewTime: "22:00" });

  // Resident view
  const resident = new Client();
  assert.equal((await resident.request("POST", "/api/auth/login", { username: "maria", password: residentPassword })).status, 200);
  assert.equal((await resident.request("GET", "/resident.html")).status, 200);
  assert.equal((await resident.request("GET", "/index.html")).status, 303);
  assert.equal((await resident.request("GET", "/api/admin/residents")).status, 403);
  assert.equal((await resident.request("POST", "/api/admin/announcements", { title: "Hi", body: "Hi" })).status, 403);
  assert.equal((await resident.request("GET", "/api/admin/reports")).status, 403);
  assert.equal((await resident.request("POST", "/api/me/reports", {
    category: "unknown", title: "Invalid", body: "Not valid", anonymous: false
  })).status, 400);
  const namedReport = await resident.request("POST", "/api/me/reports", {
    category: "maintenance", title: "Leaking sink", body: "The sink in the shared bathroom is leaking.", anonymous: false
  });
  assert.equal(namedReport.status, 201);
  const anonymousReport = await resident.request("POST", "/api/me/reports", {
    category: "safety", title: "Broken gate", body: "The side gate does not lock.", anonymous: true
  });
  assert.equal(anonymousReport.status, 201);
  const ownReports = await resident.request("GET", "/api/me/reports");
  assert.deepEqual(ownReports.data.reports.map((report) => report.title), ["Leaking sink"]);
  const adminReports = await admin.request("GET", "/api/admin/reports");
  assert.equal(adminReports.data.reports.find((report) => report.title === "Leaking sink").residentName, "Maria Santos");
  const hiddenIdentityReport = adminReports.data.reports.find((report) => report.title === "Broken gate");
  assert.equal(hiddenIdentityReport.residentName, "Anonymous resident");
  assert.equal(hiddenIdentityReport.roomNumber, null);
  assert.equal((await admin.request("PATCH", `/api/admin/reports/${anonymousReport.data.id}`, { status: "invalid" })).status, 400);
  assert.equal((await admin.request("PATCH", `/api/admin/reports/${anonymousReport.data.id}`, { status: "in_progress" })).status, 200);
  assert.equal((await resident.request("PATCH", `/api/admin/reports/${anonymousReport.data.id}`, { status: "resolved" })).status, 403);
  const overview = (await resident.request("GET", "/api/me/overview")).data;
  const residentNotifications = await resident.request("GET", "/api/me/notifications");
  assert.equal(residentNotifications.data.unreadCount, 2);
  assert.deepEqual(residentNotifications.data.notifications.map((notification) => notification.kind).sort(), ["announcement", "reminder"]);
  assert.ok(Number.isInteger(residentNotifications.data.notifications[0].createdAt));
  const unreadResidentNotification = residentNotifications.data.notifications[0];
  assert.equal((await resident.request("PATCH", `/api/me/notifications/${unreadResidentNotification.id}`, {})).status, 200);
  assert.equal((await resident.request("GET", "/api/me/notifications")).data.unreadCount, 1);
  assert.equal(overview.room.number, "101");
  assert.equal(overview.room.photoData, roomPhoto);
  assert.equal(overview.payments.length, 3);
  const manualMonthly = await resident.request("POST", "/api/me/payments/monthly", {
    amount: 700, orNumber: "OR-MANUAL-MONTHLY", orImageData: receiptImage
  });
  assert.equal(manualMonthly.status, 201);
  assert.equal(manualMonthly.data.payment.paymentType, "Monthly Rent");
  assert.equal(manualMonthly.data.payment.amount, 700);
  assert.equal(manualMonthly.data.payment.verificationStatus, "pending");
  assert.equal((await admin.request("PATCH", `/api/admin/payments/${manualMonthly.data.payment.id}/verification`, {
    decision: "verified"
  })).data.payment.status, "paid");
  const residentLatePayment = overview.payments.find((payment) => payment.id === late.data.payment.id);
  assert.equal(residentLatePayment.status, "paid");
  assert.deepEqual(overview.curfew, { curfewTime: "22:00" });
  assert.equal(overview.visitors.length, 1);
  const advance = await resident.request("POST", "/api/me/payments/advance", {});
  assert.equal(advance.status, 201);
  assert.equal(advance.data.payment.paymentType, "Monthly Rent");
  assert.ok(advance.data.payment.dueDate > new Date().toISOString().slice(0, 10));
  const duplicateAdvance = await resident.request("POST", "/api/me/payments/advance", {});
  assert.equal(duplicateAdvance.status, 200);
  assert.equal(duplicateAdvance.data.alreadyExists, true);
  assert.equal(duplicateAdvance.data.payment.id, advance.data.payment.id);
  const advanceAmount = advance.data.payment.amount;
  const partialAmount = Math.max(1, Math.floor(advanceAmount / 2));
  assert.ok(partialAmount < advanceAmount);
  assert.equal((await resident.request("POST", `/api/me/payments/${advance.data.payment.id}/or`, {
    orNumber: "OR-ADVANCE-TOO-MUCH", submittedAmount: advanceAmount + 1
  })).status, 422);
  assert.equal((await resident.request("POST", `/api/me/payments/${advance.data.payment.id}/or`, {
    orNumber: "OR-ADVANCE-PARTIAL", submittedAmount: partialAmount
  })).status, 200);
  assert.equal((await admin.request("PATCH", `/api/admin/payments/${advance.data.payment.id}/verification`, { decision: "verified" })).status, 200);
  const remainingAdvance = (await resident.request("GET", "/api/me/overview")).data.payments.find((payment) => payment.id === advance.data.payment.id);
  assert.equal(remainingAdvance.amount, advanceAmount - partialAmount);
  assert.equal(remainingAdvance.status, "pending");
  const partialHistory = (await admin.request("GET", "/api/payments/history")).data.payments.find((payment) => payment.orNumber === "OR-ADVANCE-PARTIAL");
  assert.equal(partialHistory.amount, partialAmount);
  assert.equal((await resident.request("POST", `/api/me/payments/${advance.data.payment.id}/or`, {
    orNumber: "OR-ADVANCE-REMAINDER"
  })).status, 200);
  assert.equal((await admin.request("PATCH", `/api/admin/payments/${advance.data.payment.id}/verification`, { decision: "verified" })).data.payment.status, "paid");

  const largeReceipt = `data:image/png;base64,${Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(20 * 1024)
  ]).toString("base64")}`;
  const residentDeposit = await carolSession.request("POST", "/api/me/payments/deposit", {
    amount: 1800, orNumber: "OR-CAROL-DEPOSIT", orImageData: largeReceipt
  });
  assert.equal(residentDeposit.status, 201);
  assert.equal(residentDeposit.data.payment.paymentType, "Security Deposit");
  assert.equal(residentDeposit.data.payment.amount, 1800);
  assert.equal(residentDeposit.data.payment.verificationStatus, "pending");
  assert.equal(residentDeposit.data.payment.hasOrImage, true);
  assert.equal((await carolSession.request("POST", "/api/me/payments/deposit", {
    amount: 1800, orNumber: "OR-CAROL-DEPOSIT-2"
  })).status, 409);
  assert.equal((await admin.request("GET", `/api/admin/payments/${residentDeposit.data.payment.id}/proof`)).data.orImageData, largeReceipt);
  assert.equal((await admin.request("PATCH", `/api/admin/payments/${residentDeposit.data.payment.id}/verification`, {
    decision: "verified"
  })).data.payment.status, "paid");

  const securityDeposit = await admin.request("POST", "/api/admin/payments", {
    accountId: maria.id, amount: 2500, status: "pending", paymentType: "Security Deposit",
    dueDate: new Date().toISOString().slice(0, 10), note: "Security deposit"
  });
  assert.equal(securityDeposit.status, 201);
  assert.equal(securityDeposit.data.payment.paymentType, "Security Deposit");
  assert.equal((await resident.request("POST", `/api/me/payments/${securityDeposit.data.payment.id}/or`, {
    orNumber: "OR-SECURITY-DEPOSIT"
  })).status, 200);
  assert.equal((await admin.request("PATCH", `/api/admin/payments/${securityDeposit.data.payment.id}/verification`, { decision: "verified" })).data.payment.status, "paid");
  assert.equal((await admin.request("POST", `/api/admin/payments/${securityDeposit.data.payment.id}/refund`, {})).status, 404);
  const downpayment = await admin.request("POST", "/api/admin/payments", {
    accountId: maria.id, amount: 1500, status: "pending", paymentType: "Downpayment",
    dueDate: new Date().toISOString().slice(0, 10), note: "Initial downpayment"
  });
  assert.equal(downpayment.status, 201);
  assert.equal(downpayment.data.payment.paymentType, "Downpayment");
  assert.equal(downpayment.data.payment.isDownpayment, true);
  const submittedDownpayment = await resident.request("POST", `/api/me/payments/${downpayment.data.payment.id}/or`, {
    orNumber: "OR-MARIA-DOWNPAYMENT", submittedAmount: 750, orImageData: receiptImage
  });
  assert.equal(submittedDownpayment.status, 200);
  assert.equal(submittedDownpayment.data.payment.paymentType, "Downpayment");
  assert.equal((await admin.request("PATCH", `/api/admin/payments/${downpayment.data.payment.id}/verification`, {
    decision: "verified"
  })).data.payment.paymentType, "Downpayment");
  const downpaymentRemainder = (await resident.request("GET", "/api/me/overview")).data.payments.find((payment) => payment.id === downpayment.data.payment.id);
  assert.equal(downpaymentRemainder.paymentType, "Downpayment");
  assert.equal(downpaymentRemainder.amount, 750);
  assert.equal((await admin.request("PATCH", `/api/admin/payments/${downpayment.data.payment.id}`, {
    amount: 750
  })).data.payment.paymentType, "Downpayment");

  const visitorSubmission = await resident.request("POST", "/api/me/visitors", {
    visitorName: "Resident Guest", visitedAt: Date.now()
  });
  assert.equal(visitorSubmission.status, 201);
  assert.equal(visitorSubmission.data.visitor.status, "approved");
  assert.equal((await resident.request("POST", "/api/me/visitors", { visitorName: "Ignored accountId", accountId: juan.id, visitedAt: Date.now() })).data.visitor.residentName, "Maria Santos");
  const notifications = await admin.request("GET", "/api/admin/notifications");
  assert.equal(notifications.data.unreadCount, 0);
  assert.equal((await admin.request("GET", "/api/admin/notifications")).data.unreadCount, 0);
  assert.equal((await resident.request("GET", "/api/announcements")).data.announcements.length, 1);
  assert.equal((await resident.request("GET", "/api/reminders")).data.reminders.length, 1);
  assert.equal((await admin.request("GET", "/api/me/overview")).status, 403);

  // Password reset ends the old session; deleting cleans up
  assert.equal((await admin.request("PATCH", `/api/admin/residents/${maria.id}`, { password: "a-brand-new-password" })).status, 200);
  assert.equal((await resident.request("GET", "/api/me/overview")).status, 401);
  assert.equal((await new Client().request("POST", "/api/auth/login", { username: "maria", password: "a-brand-new-password" })).status, 200);
  assert.equal((await admin.request("DELETE", `/api/admin/residents/${maria.id}`)).status, 200);
  assert.equal((await admin.request("DELETE", `/api/admin/residents/${maria.id}`)).status, 404);
  assert.equal((await admin.request("DELETE", `/api/admin/rooms/${room.id}`)).status, 200);

  // Sign out
  assert.equal((await admin.request("POST", "/api/auth/logout", {})).status, 200);
  assert.equal((await admin.request("GET", "/api/auth/me")).status, 401);
});
