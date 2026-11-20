const { PASSWORD_MAX, PASSWORD_MIN, createAccount, isUniqueError, publicUser, setPassword } = require("./store");

const MAX_ROOM_IMAGE_BYTES = 1024 * 1024;
const MAX_ROOM_IMAGE_DATA_LENGTH = Math.ceil(MAX_ROOM_IMAGE_BYTES / 3) * 4;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function text(value, label, { max = 100, required = true } = {}) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) {
    if (required) throw new HttpError(400, `${label} is required.`);
    return "";
  }
  if ([...s].length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return s;
}

function whole(value, label, min, max) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

function oneOf(value, label, list) {
  if (!list.includes(value)) throw new HttpError(400, `${label} must be one of: ${list.join(", ")}.`);
  return value;
}

function dateText(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${label} is required.`);
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new HttpError(400, `${label} must be a valid date.`);
  }
  return value;
}

function timeText(value, label) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new HttpError(400, `${label} must be a time like 22:00.`);
  }
  return value;
}

function roomPhoto(value, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (value === "" && optional) return "";
  return imageData(value, "Room photo");
}

function paymentProofImage(value) {
  if (value === undefined || value === "") return "";
  return imageData(value, "Payment proof");
}

function imageData(value, label) {
  const invalidMessage = `${label} must be a PNG, JPEG or WebP image no larger than 1 MB.`;
  if (typeof value !== "string") throw new HttpError(400, invalidMessage);
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length > MAX_ROOM_IMAGE_DATA_LENGTH) {
    throw new HttpError(400, invalidMessage);
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_ROOM_IMAGE_BYTES || bytes.toString("base64") !== match[2]) {
    throw new HttpError(400, invalidMessage);
  }
  const validSignature = match[1] === "png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : match[1] === "jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!validSignature) throw new HttpError(400, `${label} contents do not match the selected image type.`);
  return value;
}

function password(value) {
  if (typeof value !== "string" || [...value].length < PASSWORD_MIN || [...value].length > PASSWORD_MAX) {
    throw new HttpError(400, `Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`);
  }
  return value;
}

function idParam(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, "Not found.");
  return id;
}

function createApi(db) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('monthly_rent_start_month', ?)")
    .run(localDate(new Date()).slice(0, 7));
  const routes = [];
  const add = (method, pattern, access, handler) => {
    routes.push({
      method,
      access,
      handler,
      regex: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`)
    });
  };
  const created = (data) => ({ status: 201, data });
  const requireFound = (result, what) => {
    if (!result.changes) throw new HttpError(404, `${what} was not found.`);
    return { ok: true };
  };
  const notifyResidents = (kind, sourceId, title, message, createdAt) => db.prepare(`
    INSERT INTO resident_notifications (account_id, kind, source_id, title, body, created_at)
    SELECT id, ?, ?, ?, ?, ? FROM accounts WHERE role = 'resident'
  `).run(kind, sourceId, title, message, createdAt);

  const curfewTime = () => db.prepare("SELECT value FROM settings WHERE key = 'curfew_time'").get().value;
  const ensureMonthlyRentPayments = () => {
    const today = localDate(new Date());
    const currentMonth = today.slice(0, 7);
    const startMonth = db.prepare("SELECT value FROM settings WHERE key = 'monthly_rent_start_month'").get()?.value;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth || "")) {
      throw new Error("Monthly rent billing start month is invalid.");
    }
    if (startMonth > currentMonth) return;

    db.exec("BEGIN IMMEDIATE");
    try {
      const residents = db.prepare(`
        SELECT a.id, a.move_in_date, r.rent
        FROM accounts a JOIN rooms r ON r.id = a.room_id
        WHERE a.role = 'resident' AND a.status IN ('Active', 'On Leave')
          AND a.move_in_date IS NOT NULL AND a.move_in_date <= ? AND r.rent > 0
      `).all(today);
      const hasInvoice = db.prepare(`
        SELECT 1 FROM payments
        WHERE account_id = ? AND (
          billing_period = ? OR
          (payment_type = 'Monthly Rent' AND billing_frequency = 'Monthly' AND substr(due_date, 1, 7) = ?)
        )
        LIMIT 1
      `);
      const insertInvoice = db.prepare(`
        INSERT INTO payments
          (account_id, amount, paid_amount, status, due_date, paid_date, note, or_number,
           payment_type, billing_frequency, billing_period, recorded_by, created_at)
        VALUES (?, ?, NULL, 'pending', ?, NULL, ?, '', 'Monthly Rent', 'Monthly', ?, NULL, ?)
      `);

      for (let month = startMonth; month <= currentMonth;) {
        const [year, monthNumber] = month.split("-").map(Number);
        const lastDay = new Date(year, monthNumber, 0).getDate();
        const nextMonth = monthNumber === 12
          ? `${year + 1}-01`
          : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
        for (const resident of residents) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(resident.move_in_date)) {
            throw new Error(`Resident ${resident.id} has an invalid move-in date.`);
          }
          if (resident.move_in_date.slice(0, 7) > month) continue;
          if (hasInvoice.get(resident.id, month, month)) continue;
          const moveInDay = Number(resident.move_in_date.slice(8, 10));
          const dueDate = `${month}-${String(Math.min(moveInDay, lastDay)).padStart(2, "0")}`;
          insertInvoice.run(
            resident.id, resident.rent, dueDate, `Monthly rent for ${month}`, month, Date.now()
          );
        }
        month = nextMonth;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  // ---------- Residents ----------
  const residentSelect = `
    SELECT a.id, a.username, a.name, a.email, a.phone, a.parent_name, a.parent_phone, a.room_id, a.status, a.move_in_date, a.created_at, r.number AS room_number
    FROM accounts a LEFT JOIN rooms r ON r.id = a.room_id`;
  const mapResident = (r) => ({
    id: r.id, username: r.username, name: r.name, email: r.email, phone: r.phone,
    parentName: r.parent_name, parentPhone: r.parent_phone,
    roomId: r.room_id, roomNumber: r.room_number, status: r.status, moveInDate: r.move_in_date,
    registeredAt: r.created_at
  });
  const loadResident = (id) => {
    const row = db.prepare(`${residentSelect} WHERE a.role = 'resident' AND a.id = ?`).get(id);
    if (!row) throw new HttpError(404, "Resident was not found.");
    return mapResident(row);
  };
  const parseRoomId = (value) => (value === null || value === undefined || value === "" ? null : whole(value, "Room", 1, 1e9));
  const assertRoomOpen = (roomId, residentId) => {
    if (roomId === null) return;
    const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!room) throw new HttpError(400, "That room does not exist.");
    if (room.status === "maintenance") throw new HttpError(409, `Room ${room.number} is under maintenance.`);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE room_id = ? AND role = 'resident' AND status IN ('Active', 'On Leave', 'Reserved') AND id <> ?").get(roomId, residentId || "");
    if (n >= room.capacity) throw new HttpError(409, `Room ${room.number} is full.`);
  };
  const username = (value) => {
    const s = text(value, "Username", { max: 32 });
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(s)) {
      throw new HttpError(400, "Username must be 3–32 letters, numbers, dots, dashes or underscores.");
    }
    return s;
  };

  add("GET", "/api/admin/residents", "admin", () => ({
    residents: db.prepare(`${residentSelect} WHERE a.role = 'resident' ORDER BY a.created_at DESC`).all().map(mapResident)
  }));

  add("GET", "/api/admin/residents/unassigned", "admin", () => ({
    residents: db.prepare(`${residentSelect} WHERE a.role = 'resident' AND a.status = 'Unassigned' AND a.room_id IS NULL ORDER BY a.name COLLATE NOCASE`).all().map(mapResident)
  }));

  add("GET", "/api/admin/rooms/:id/residents", "admin", ({ params }) => {
    const roomId = idParam(params);
    const room = db.prepare("SELECT id, number FROM rooms WHERE id = ?").get(roomId);
    if (!room) throw new HttpError(404, "Room was not found.");
    const residents = db.prepare(`${residentSelect}
      WHERE a.role = 'resident' AND a.room_id = ? AND a.status IN ('Active', 'On Leave', 'Reserved')
      ORDER BY a.name COLLATE NOCASE`).all(roomId).map((resident) => ({
      ...mapResident(resident), contactInfo: [resident.phone, resident.email].filter(Boolean).join(" · ")
    }));
    return { room: { id: room.id, number: room.number }, residents };
  });

  add("POST", "/api/admin/rooms/:id/assign", "admin", ({ body, params }) => {
    const roomId = idParam(params);
    const residentId = text(body.residentId, "Resident", { max: 64 });
    const reservationOnly = body.reservationOnly === true;
    db.exec("BEGIN IMMEDIATE");
    try {
      const resident = db.prepare("SELECT id, status, room_id FROM accounts WHERE id = ? AND role = 'resident'").get(residentId);
      if (!resident || resident.status !== "Unassigned" || resident.room_id !== null) {
        throw new HttpError(409, "Choose an unassigned resident.");
      }
      assertRoomOpen(roomId, residentId);
      const room = db.prepare("SELECT id, number, rent FROM rooms WHERE id = ?").get(roomId);
      const status = reservationOnly ? "Reserved" : "Active";
      const moveInDate = reservationOnly ? null : localDate(new Date());
      db.prepare("UPDATE accounts SET room_id = ?, status = ?, move_in_date = ? WHERE id = ?")
        .run(roomId, status, moveInDate, residentId);
      let payment = null;
      if (reservationOnly) {
        if (room.rent < 1) throw new HttpError(409, `Set a monthly rent for Room ${room.number} before reserving a bed.`);
        const dueDate = localDate(new Date());
        const result = db.prepare(`INSERT INTO payments
          (account_id, amount, status, due_date, paid_date, note, or_number, payment_type, created_at)
          VALUES (?, ?, 'pending', ?, NULL, ?, '', 'Reservation Fee', ?)`)
          .run(residentId, room.rent, dueDate, `Reservation fee for Room ${room.number}`, Date.now());
        payment = { id: Number(result.lastInsertRowid), amount: room.rent, dueDate, status: "pending", paymentType: "Reservation Fee" };
      }
      db.exec("COMMIT");
      return created({ resident: loadResident(residentId), payment });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  add("POST", "/api/admin/residents/:id/transfer", "admin", ({ body, params }) => {
    const residentId = params.id;
    const roomId = parseRoomId(body.roomId);
    if (roomId === null) throw new HttpError(400, "Choose a room.");
    db.exec("BEGIN IMMEDIATE");
    try {
      const resident = db.prepare("SELECT id, room_id, status FROM accounts WHERE id = ? AND role = 'resident'").get(residentId);
      if (!resident || !["Active", "On Leave", "Reserved"].includes(resident.status) || resident.room_id === null) {
        throw new HttpError(409, "This resident cannot be transferred.");
      }
      if (resident.room_id === roomId) throw new HttpError(400, "Choose a different room.");
      assertRoomOpen(roomId, residentId);
      db.prepare("UPDATE accounts SET room_id = ?, move_in_date = CASE WHEN status = 'Active' THEN ? ELSE move_in_date END WHERE id = ?")
        .run(roomId, localDate(new Date()), residentId);
      db.exec("COMMIT");
      return { resident: loadResident(residentId) };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  add("PATCH", "/api/admin/residents/:id/status", "admin", ({ body, params }) => {
    const status = oneOf(body.status, "Status", ["Active", "On Leave"]);
    const result = db.prepare(`UPDATE accounts SET status = ?,
      move_in_date = CASE WHEN ? = 'Active' THEN COALESCE(move_in_date, ?) ELSE move_in_date END
      WHERE id = ? AND role = 'resident' AND room_id IS NOT NULL
      AND (status IN ('Active', 'On Leave') OR (status = 'Reserved' AND ? = 'Active'))`)
      .run(status, status, localDate(new Date()), params.id, status);
    if (!result.changes) throw new HttpError(409, "This resident cannot make that status change.");
    return { resident: loadResident(params.id) };
  });

  add("POST", "/api/admin/residents/:id/move-out", "admin", ({ params }) => {
    const id = params.id;
    ensureMonthlyRentPayments();
    db.exec("BEGIN IMMEDIATE");
    try {
      const resident = db.prepare("SELECT id FROM accounts WHERE id = ? AND role = 'resident'").get(id);
      if (!resident) throw new HttpError(404, "Resident was not found.");
      const balance = db.prepare("SELECT COUNT(*) AS count FROM payments WHERE account_id = ? AND status IN ('pending', 'overdue')").get(id).count;
      if (balance) throw new HttpError(409, "Move-out is blocked. Clear all pending or overdue payments first.");
      db.prepare("UPDATE accounts SET room_id = NULL, status = 'Moved Out', move_in_date = NULL WHERE id = ?").run(id);
      db.exec("COMMIT");
      return { resident: loadResident(id) };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  add("POST", "/api/admin/residents", "admin", ({ body }) => {
    const data = {
      name: text(body.name, "Name"),
      username: username(body.username),
      email: text(body.email, "Email", { max: 254 }),
      phone: text(body.phone, "Phone", { max: 40 }),
      parentName: text(body.parentName, "Parent/Guardian name", { max: 100 }),
      parentPhone: text(body.parentPhone, "Parent/Guardian phone", { max: 40 }),
      password: password(body.password),
      roomId: parseRoomId(body.roomId)
    };
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new HttpError(400, "Enter a valid email address.");
    assertRoomOpen(data.roomId, null);
    try {
      const account = createAccount(db, { ...data, role: "resident" });
      if (data.roomId !== null) {
        db.prepare("UPDATE accounts SET status = 'Active', move_in_date = ? WHERE id = ?").run(localDate(new Date()), account.id);
      }
      return created({ resident: loadResident(account.id) });
    } catch (error) {
      if (isUniqueError(error, "accounts.username")) throw new HttpError(409, "That username is already taken.");
      throw error;
    }
  });

  add("PATCH", "/api/admin/residents/:id", "admin", ({ body, params }) => {
    const id = params.id;
    const current = loadResident(id);
    const name = has(body, "name") ? text(body.name, "Name") : current.name;
    const email = has(body, "email") ? text(body.email, "Email", { max: 254 }) : current.email;
    const phone = has(body, "phone") ? text(body.phone, "Phone", { max: 40 }) : current.phone;
    const parentName = has(body, "parentName") ? text(body.parentName, "Parent/Guardian name", { max: 100 }) : current.parentName;
    const parentPhone = has(body, "parentPhone") ? text(body.parentPhone, "Parent/Guardian phone", { max: 40 }) : current.parentPhone;
    if (!email || !phone || !parentName || !parentPhone) throw new HttpError(400, "Email, phone and parent/guardian contact information are required.");
    const roomId = has(body, "roomId") ? parseRoomId(body.roomId) : current.roomId;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    if (roomId !== current.roomId) assertRoomOpen(roomId, id);
    const newPassword = has(body, "password") && body.password !== "" ? password(body.password) : null;
    const status = roomId !== current.roomId
      ? roomId === null ? "Unassigned" : "Active"
      : db.prepare("SELECT status FROM accounts WHERE id = ?").get(id).status;
    const moveInDate = roomId !== current.roomId
      ? roomId === null ? null : localDate(new Date())
      : current.moveInDate;
    db.prepare("UPDATE accounts SET name = ?, email = ?, phone = ?, parent_name = ?, parent_phone = ?, room_id = ?, status = ?, move_in_date = ? WHERE id = ?")
      .run(name, email, phone, parentName, parentPhone, roomId, status, moveInDate, id);
    if (newPassword) setPassword(db, id, newPassword);
    return { resident: loadResident(id) };
  });

  add("DELETE", "/api/admin/residents/:id", "admin", ({ params }) =>
    requireFound(db.prepare("DELETE FROM accounts WHERE id = ? AND role = 'resident'").run(params.id), "Resident"));

  // ---------- Admin accounts ----------
  const adminAccountSelect = "SELECT id, username, name, email, phone, created_at AS createdAt FROM accounts WHERE role = 'admin'";
  const loadAdminAccount = (id) => {
    const account = db.prepare(`${adminAccountSelect} AND id = ?`).get(id);
    if (!account) throw new HttpError(404, "Admin account was not found.");
    return account;
  };
  add("GET", "/api/admin/accounts", "admin", () => ({
    accounts: db.prepare(`${adminAccountSelect} ORDER BY created_at ASC, username COLLATE NOCASE`).all()
  }));
  add("POST", "/api/admin/accounts", "admin", ({ body }) => {
    const data = {
      username: username(body.username),
      name: text(body.name, "Name"),
      email: text(body.email, "Email", { max: 254 }),
      phone: text(body.phone, "Phone", { max: 40, required: false }),
      password: password(body.password)
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new HttpError(400, "Enter a valid email address.");
    try {
      const account = createAccount(db, { ...data, role: "admin" });
      return created({ account: loadAdminAccount(account.id) });
    } catch (error) {
      if (isUniqueError(error, "accounts.username")) throw new HttpError(409, "That username is already taken.");
      throw error;
    }
  });
  add("PATCH", "/api/admin/accounts/:id", "admin", ({ body, params }) => {
    const current = loadAdminAccount(params.id);
    const usernameValue = has(body, "username") ? username(body.username) : current.username;
    const name = has(body, "name") ? text(body.name, "Name") : current.name;
    const email = has(body, "email") ? text(body.email, "Email", { max: 254 }) : text(current.email, "Email", { max: 254 });
    const phone = has(body, "phone") ? text(body.phone, "Phone", { max: 40, required: false }) : current.phone;
    const newPassword = has(body, "password") && body.password !== "" ? password(body.password) : null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    try {
      db.prepare("UPDATE accounts SET username = ?, name = ?, email = ?, phone = ? WHERE id = ? AND role = 'admin'")
        .run(usernameValue, name, email, phone, params.id);
      if (newPassword) setPassword(db, params.id, newPassword);
    } catch (error) {
      if (isUniqueError(error, "accounts.username")) throw new HttpError(409, "That username is already taken.");
      throw error;
    }
    return { account: loadAdminAccount(params.id) };
  });

  // ---------- Rooms ----------
  const mapRoom = (r, occupants) => {
    const list = occupants.filter((o) => o.room_id === r.id && ["Active", "On Leave", "Reserved"].includes(o.status)).map((o) => ({ id: o.id, name: o.name }));
    return {
      id: r.id, number: r.number, capacity: r.capacity, rent: r.rent, notes: r.notes,
      photoData: r.photo_data,
      maintenance: r.status === "maintenance", occupants: list,
      availableBeds: Math.max(0, r.capacity - list.length),
      status: r.status === "maintenance" ? "maintenance" : list.length >= r.capacity ? "occupied" : "available"
    };
  };
  const roomPayload = (body, current = {}) => ({
    number: has(body, "number") || !current.number ? text(body.number, "Room number", { max: 20 }) : current.number,
    capacity: has(body, "capacity") || !current.capacity ? whole(body.capacity, "Capacity", 1, 20) : current.capacity,
    rent: has(body, "rent") || current.rent === undefined ? whole(body.rent ?? 0, "Rent", 0, 10000000) : current.rent,
    status: has(body, "status") || !current.status ? oneOf(body.status ?? "available", "Status", ["available", "maintenance"]) : current.status,
    notes: has(body, "notes") ? text(body.notes, "Notes", { max: 200, required: false }) : current.notes || "",
    photoData: has(body, "photoData") ? roomPhoto(body.photoData, { optional: true }) : current.photoData || ""
  });
  const loadRoom = (id) => {
    const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
    if (!row) throw new HttpError(404, "Room was not found.");
    const occupants = db.prepare("SELECT id, name, room_id, status FROM accounts WHERE room_id = ? AND role = 'resident'").all(id);
    return mapRoom(row, occupants);
  };
  const roomConflict = (error) => {
    if (isUniqueError(error, "rooms.number")) throw new HttpError(409, "A room with that number already exists.");
    throw error;
  };

  add("GET", "/api/admin/rooms", "admin", () => {
    const occupants = db.prepare("SELECT id, name, room_id, status FROM accounts WHERE room_id IS NOT NULL AND role = 'resident' ORDER BY name").all();
    const rooms = db.prepare("SELECT * FROM rooms ORDER BY number COLLATE NOCASE").all().map((r) => mapRoom(r, occupants));
    return { rooms };
  });

  add("POST", "/api/admin/rooms", "admin", ({ body }) => {
    const r = roomPayload(body);
    try {
      const result = db.prepare("INSERT INTO rooms (number, capacity, rent, status, notes, photo_data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(r.number, r.capacity, r.rent, r.status, r.notes, r.photoData);
      return created({ room: loadRoom(Number(result.lastInsertRowid)) });
    } catch (error) { return roomConflict(error); }
  });

  add("PATCH", "/api/admin/rooms/:id", "admin", ({ body, params }) => {
    const id = idParam(params);
    const current = loadRoom(id);
    const r = roomPayload(body, { number: current.number, capacity: current.capacity, rent: current.rent, status: current.maintenance ? "maintenance" : "available", notes: current.notes });
    if (r.capacity < current.occupants.length) {
      throw new HttpError(409, `Room ${current.number} has ${current.occupants.length} residents; capacity cannot be lower.`);
    }
    try {
      db.prepare("UPDATE rooms SET number = ?, capacity = ?, rent = ?, status = ?, notes = ?, photo_data = ? WHERE id = ?")
        .run(r.number, r.capacity, r.rent, r.status, r.notes, r.photoData, id);
    } catch (error) { roomConflict(error); }
    return { room: loadRoom(id) };
  });

  add("DELETE", "/api/admin/rooms/:id", "admin", ({ params }) =>
    requireFound(db.prepare("DELETE FROM rooms WHERE id = ?").run(idParam(params)), "Room"));

  // ---------- Payments ----------
  const paymentSelect = `
    SELECT p.id, p.account_id, p.amount, p.due_date, p.paid_date, p.note, p.or_number, p.payment_type, p.billing_frequency,
      p.is_security_deposit, p.is_downpayment, p.or_submitted_amount,
      p.or_verification_status, CASE WHEN p.or_image_data <> '' THEN 1 ELSE 0 END AS has_or_image,
      p.created_at,
      CASE WHEN p.status = 'pending' AND p.due_date < ? THEN 'overdue' ELSE p.status END AS shown_status,
      a.name AS resident_name, r.number AS room_number
    FROM payments p
    JOIN accounts a ON a.id = p.account_id
    LEFT JOIN rooms r ON r.id = a.room_id`;
  const mapPayment = (p) => ({
    id: p.id, accountId: p.account_id, residentName: p.resident_name, roomNumber: p.room_number,
    amount: p.amount, status: p.shown_status, dueDate: p.due_date, paidDate: p.paid_date, note: p.note,
    orNumber: p.or_number, paymentType: p.is_security_deposit ? "Security Deposit" : p.is_downpayment ? "Downpayment" : p.payment_type,
    isSecurityDeposit: Boolean(p.is_security_deposit), isDownpayment: Boolean(p.is_downpayment), billingFrequency: p.billing_frequency,
    verificationStatus: p.or_verification_status,
    submittedAmount: p.or_submitted_amount,
    hasOrImage: Boolean(p.has_or_image)
  });
  const assertUniqueOrNumber = (orNumber, paymentId = null) => {
    if (!orNumber) return;
    const duplicate = db.prepare("SELECT id FROM payments WHERE lower(trim(or_number)) = lower(?) AND id != COALESCE(?, -1)")
      .get(orNumber, paymentId);
    if (duplicate) throw new HttpError(422, "This OR number has already been used.");
  };
  const loadPayment = (id) => {
    const row = db.prepare(`${paymentSelect} WHERE p.id = ?`).get(localDate(new Date()), id);
    if (!row) throw new HttpError(404, "Payment was not found.");
    return mapPayment(row);
  };

  add("GET", "/api/admin/payments", "admin", () => {
    ensureMonthlyRentPayments();
    const rows = db.prepare(`${paymentSelect} ORDER BY p.due_date DESC, p.id DESC`).all(localDate(new Date()));
    return { payments: rows.map(mapPayment) };
  });

  add("GET", "/api/payments/history", "admin", () => ({
    payments: db.prepare(`
      SELECT p.id, COALESCE(p.paid_amount, p.amount) AS amount, p.paid_date AS paidDate, p.or_number AS orNumber,
        CASE WHEN p.is_security_deposit = 1 THEN 'Security Deposit'
          WHEN p.is_downpayment = 1 THEN 'Downpayment' ELSE p.payment_type END AS paymentType,
        p.billing_frequency AS billingFrequency,
        a.name AS residentName, r.number AS roomNumber,
        recorder.name AS recordedBy
      FROM payments p
      JOIN accounts a ON a.id = p.account_id
      LEFT JOIN rooms r ON r.id = a.room_id
      LEFT JOIN accounts recorder ON recorder.id = p.recorded_by
      WHERE p.status = 'paid'
      ORDER BY p.paid_date DESC, p.id DESC
    `).all()
  }));

  add("GET", "/api/admin/payments/:id/proof", "admin", ({ params }) => {
    const id = idParam(params);
    const payment = db.prepare("SELECT or_image_data FROM payments WHERE id = ?").get(id);
    if (!payment) throw new HttpError(404, "Payment was not found.");
    return { orImageData: payment.or_image_data };
  });

  add("PATCH", "/api/admin/payments/:id/verification", "admin", ({ body, params, user }) => {
    const id = idParam(params);
    const decision = oneOf(body.decision, "Verification decision", ["verified", "rejected"]);
    db.exec("BEGIN IMMEDIATE");
    try {
      const payment = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id);
      if (!payment) throw new HttpError(404, "Payment was not found.");
      if (!payment.or_number || payment.or_verification_status !== "pending" || payment.status === "paid") {
        throw new HttpError(409, "This payment is not awaiting OR verification.");
      }
      if (decision === "verified") {
        const submittedAmount = payment.or_submitted_amount || payment.amount;
        if (submittedAmount < payment.amount) {
          db.prepare(`INSERT INTO payments
            (account_id, amount, paid_amount, status, due_date, paid_date, note, or_number, payment_type,
             is_security_deposit, is_downpayment, billing_frequency, or_image_data, or_verification_status, recorded_by, created_at)
            VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)`)
            .run(payment.account_id, submittedAmount, submittedAmount, payment.due_date, localDate(new Date()),
              `${payment.note || payment.payment_type} · Partial payment`, payment.or_number, payment.payment_type, payment.is_security_deposit,
              payment.is_downpayment, payment.billing_frequency, payment.or_image_data, user.id, Date.now());
          db.prepare(`UPDATE payments SET amount = ?, or_number = '', or_image_data = '',
            or_verification_status = 'none', or_submitted_amount = NULL
            WHERE id = ?`).run(payment.amount - submittedAmount, id);
        } else {
          db.prepare(`UPDATE payments SET status = 'paid', paid_amount = amount, paid_date = ?,
            recorded_by = ?, or_verification_status = 'verified', or_submitted_amount = NULL WHERE id = ?`)
            .run(localDate(new Date()), user.id, id);
        }
      } else {
        db.prepare("UPDATE payments SET or_verification_status = 'rejected' WHERE id = ?").run(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { payment: loadPayment(id) };
  });

  add("PUT", "/api/payments/record", "admin", ({ body, user }) => {
    const id = idParam({ id: body.payment_id });
    const orNumber = text(body.or_number, "OR number", { max: 64 });
    const amountPaid = whole(body.amount_paid, "Amount paid", 1, 100000000);
    db.exec("BEGIN IMMEDIATE");
    try {
      const payment = db.prepare("SELECT id, amount, status FROM payments WHERE id = ?").get(id);
      if (!payment) throw new HttpError(404, "Payment was not found.");
      if (payment.status === "paid") throw new HttpError(409, "This payment has already been recorded.");
      if (amountPaid < payment.amount) throw new HttpError(422, "Amount paid cannot be less than the dorm payment.");
      assertUniqueOrNumber(orNumber, id);
      db.prepare("UPDATE payments SET paid_amount = ?, status = 'paid', paid_date = ?, or_number = ?, recorded_by = ? WHERE id = ?")
        .run(amountPaid, localDate(new Date()), orNumber, user.id, id);
      db.exec("COMMIT");
      return { payment: loadPayment(id) };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  add("POST", "/api/admin/payments", "admin", ({ body, user }) => {
    const accountId = text(body.accountId, "Resident", { max: 64 });
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND role = 'resident'").get(accountId)) {
      throw new HttpError(400, "Choose a valid resident.");
    }
    const amount = whole(body.amount, "Amount", 1, 100000000);
    const status = oneOf(body.status ?? "pending", "Status", ["paid", "pending", "overdue"]);
    const dueDate = dateText(body.dueDate, "Due date");
    const note = text(body.note, "Note", { max: 200, required: false });
    const orNumber = text(body.orNumber, "OR number", { max: 64, required: false });
    const requestedType = oneOf(body.paymentType ?? "Monthly Rent", "Payment type", ["Reservation Fee", "Monthly Rent", "Damage Penalty", "Security Deposit", "Downpayment"]);
    const isSecurityDeposit = requestedType === "Security Deposit";
    const isDownpayment = requestedType === "Downpayment";
    const paymentType = isSecurityDeposit || isDownpayment ? "Reservation Fee" : requestedType;
    const billingFrequency = oneOf(body.billingFrequency ?? "Monthly", "Billing frequency", ["Daily", "Weekly", "Monthly"]);
    const paidDate = status === "paid" ? localDate(new Date()) : null;
    assertUniqueOrNumber(orNumber);
    const result = db.prepare(`INSERT INTO payments
      (account_id, amount, paid_amount, status, due_date, paid_date, note, or_number, payment_type, is_security_deposit, is_downpayment, billing_frequency, recorded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(accountId, amount, status === "paid" ? amount : null, status, dueDate, paidDate, note, orNumber,
        paymentType, isSecurityDeposit ? 1 : 0, isDownpayment ? 1 : 0, billingFrequency, status === "paid" ? user.id : null, Date.now());
    return created({ payment: loadPayment(Number(result.lastInsertRowid)) });
  });

  add("PATCH", "/api/admin/payments/:id", "admin", ({ body, params, user }) => {
    const id = idParam(params);
    const row = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
    if (!row) throw new HttpError(404, "Payment was not found.");
    const amount = has(body, "amount") ? whole(body.amount, "Amount", 1, 100000000) : row.amount;
    const status = has(body, "status") ? oneOf(body.status, "Status", ["paid", "pending", "overdue"]) : row.status;
    const requestedType = has(body, "paymentType")
      ? oneOf(body.paymentType, "Payment type", ["Reservation Fee", "Monthly Rent", "Damage Penalty", "Security Deposit", "Downpayment"])
      : row.is_downpayment ? "Downpayment" : row.is_security_deposit ? "Security Deposit" : row.payment_type;
    const isSecurityDeposit = requestedType === "Security Deposit";
    const isDownpayment = requestedType === "Downpayment";
    const paymentType = isSecurityDeposit || isDownpayment ? "Reservation Fee" : requestedType;
    const billingFrequency = has(body, "billingFrequency") ? oneOf(body.billingFrequency, "Billing frequency", ["Daily", "Weekly", "Monthly"]) : row.billing_frequency;
    const dueDate = has(body, "dueDate") ? dateText(body.dueDate, "Due date") : row.due_date;
    const orNumber = has(body, "orNumber") ? text(body.orNumber, "OR number", { max: 64, required: false }) : row.or_number;
    const paidDate = status === "paid" ? row.paid_date || localDate(new Date()) : null;
    assertUniqueOrNumber(orNumber, id);
    db.prepare("UPDATE payments SET amount = ?, paid_amount = ?, status = ?, due_date = ?, paid_date = ?, or_number = ?, payment_type = ?, is_security_deposit = ?, is_downpayment = ?, billing_frequency = ?, recorded_by = ? WHERE id = ?")
      .run(amount, status === "paid" ? row.paid_amount ?? amount : null, status, dueDate, paidDate, orNumber, paymentType, isSecurityDeposit ? 1 : 0, isDownpayment ? 1 : 0, billingFrequency, status === "paid" ? row.recorded_by || user.id : null, id);
    return { payment: loadPayment(id) };
  });

  add("DELETE", "/api/admin/payments/:id", "admin", ({ params }) =>
    requireFound(db.prepare("DELETE FROM payments WHERE id = ?").run(idParam(params)), "Payment"));

  // ---------- Summary ----------
  add("GET", "/api/admin/summary", "admin", () => {
    ensureMonthlyRentPayments();
    const today = localDate(new Date());
    const count = (sql, ...args) => db.prepare(sql).get(...args).n;
    const months = [];
    const base = new Date();
    for (let i = 5; i >= 0; i -= 1) {
      const m = new Date(base.getFullYear(), base.getMonth() - i, 1);
      months.push({ key: `${m.getFullYear()}-${pad(m.getMonth() + 1)}`, label: m.toLocaleString("en-US", { month: "short" }), total: 0 });
    }
    const totals = db.prepare("SELECT substr(paid_date, 1, 7) AS month, SUM(COALESCE(paid_amount, amount)) AS total FROM payments WHERE status = 'paid' AND paid_date IS NOT NULL GROUP BY month").all();
    for (const t of totals) {
      const slot = months.find((m) => m.key === t.month);
      if (slot) slot.total = t.total;
    }
    const current = months[5].total;
    const previous = months[4].total;
    const pending = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE status IN ('pending', 'overdue')").get();
    return {
      residents: count("SELECT COUNT(*) AS n FROM accounts WHERE role = 'resident'"),
      rooms: count("SELECT COUNT(*) AS n FROM rooms"),
      collected: db.prepare("SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) AS n FROM payments WHERE status = 'paid'").get().n,
      pendingCount: pending.n,
      pendingTotal: pending.total,
      overdueCount: count("SELECT COUNT(*) AS n FROM payments WHERE status = 'overdue' OR (status = 'pending' AND due_date < ?)", today),
      monthly: months.map(({ label, total }) => ({ label, total })),
      changePercent: previous > 0 ? Math.round(((current - previous) / previous) * 100) : null
    };
  });

  // ---------- Announcements & reminders ----------
  add("GET", "/api/announcements", "any", () => ({
    announcements: db.prepare("SELECT id, title, body, created_at AS createdAt FROM announcements ORDER BY created_at DESC, id DESC").all()
  }));
  add("POST", "/api/admin/announcements", "admin", ({ body }) => {
    const title = text(body.title, "Title", { max: 100 });
    const message = text(body.body, "Message", { max: 1000 });
    const createdAt = has(body, "publishedAt")
      ? whole(body.publishedAt, "Date and time", 946684800000, 4102444800000)
      : Date.now();
    const result = db.prepare("INSERT INTO announcements (title, body, created_at) VALUES (?, ?, ?)").run(title, message, createdAt);
    notifyResidents("announcement", Number(result.lastInsertRowid), title, message, createdAt);
    return created({ id: Number(result.lastInsertRowid) });
  });
  add("DELETE", "/api/admin/announcements/:id", "admin", ({ params }) =>
    requireFound(db.prepare("DELETE FROM announcements WHERE id = ?").run(idParam(params)), "Announcement"));

  add("GET", "/api/reminders", "any", () => ({
    reminders: db.prepare("SELECT id, kind, title, body, due_date AS dueDate, created_at AS createdAt FROM reminders ORDER BY created_at DESC, id DESC").all()
  }));
  add("POST", "/api/admin/reminders", "admin", ({ body }) => {
    const kind = oneOf(body.kind, "Type", ["payment", "curfew", "event"]);
    const title = text(body.title, "Title", { max: 100 });
    const message = text(body.body, "Message", { max: 500, required: false });
    const dueDate = dateText(body.dueDate, "Date", { required: false });
    const createdAt = Date.now();
    const result = db.prepare("INSERT INTO reminders (kind, title, body, due_date, created_at) VALUES (?, ?, ?, ?, ?)").run(kind, title, message, dueDate, createdAt);
    notifyResidents("reminder", Number(result.lastInsertRowid), title, message || (dueDate ? `Date: ${dueDate}` : "A new reminder was posted."), createdAt);
    return created({ id: Number(result.lastInsertRowid) });
  });
  add("DELETE", "/api/admin/reminders/:id", "admin", ({ params }) =>
    requireFound(db.prepare("DELETE FROM reminders WHERE id = ?").run(idParam(params)), "Reminder"));

  // ---------- Resident reports ----------
  const reportSelect = `
    SELECT rr.id, rr.category, rr.title, rr.body, rr.is_anonymous AS isAnonymous,
      rr.status, rr.created_at AS createdAt, rr.updated_at AS updatedAt,
      CASE WHEN rr.is_anonymous = 1 THEN 'Anonymous resident' ELSE COALESCE(a.name, 'Former resident') END AS residentName,
      CASE WHEN rr.is_anonymous = 1 THEN NULL ELSE r.number END AS roomNumber
    FROM resident_reports rr
    LEFT JOIN accounts a ON a.id = rr.account_id
    LEFT JOIN rooms r ON r.id = a.room_id`;
  add("GET", "/api/admin/reports", "admin", () => ({
    reports: db.prepare(`${reportSelect} ORDER BY rr.created_at DESC, rr.id DESC`).all()
  }));
  add("PATCH", "/api/admin/reports/:id", "admin", ({ body, params }) => {
    const status = oneOf(body.status, "Status", ["new", "in_progress", "resolved"]);
    const result = db.prepare("UPDATE resident_reports SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), idParam(params));
    return requireFound(result, "Report");
  });
  add("GET", "/api/me/reports", "resident", ({ user }) => ({
    reports: db.prepare(`
      SELECT id, category, title, body, status, created_at AS createdAt, updated_at AS updatedAt
      FROM resident_reports WHERE account_id = ? ORDER BY created_at DESC, id DESC
    `).all(user.id)
  }));
  add("POST", "/api/me/reports", "resident", ({ body, user }) => {
    const category = oneOf(body.category, "Category", ["maintenance", "safety", "cleanliness", "noise", "other"]);
    const title = text(body.title, "Title", { max: 100 });
    const message = text(body.body, "Description", { max: 2000 });
    if (typeof body.anonymous !== "boolean") throw new HttpError(400, "Choose whether to send this report anonymously.");
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO resident_reports (account_id, is_anonymous, category, title, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(body.anonymous ? null : user.id, body.anonymous ? 1 : 0, category, title, message, now, now);
    return created({ id: Number(result.lastInsertRowid) });
  });

  // ---------- Visitors ----------
  const visitorSelect = `
    SELECT v.id, v.visitor_name AS visitorName, v.visited_at AS visitedAt, v.status,
      a.name AS residentName, r.number AS roomNumber
    FROM visitors v JOIN accounts a ON a.id = v.account_id LEFT JOIN rooms r ON r.id = a.room_id`;
  add("GET", "/api/admin/visitors", "admin", () => ({
    visitors: db.prepare(`${visitorSelect} ORDER BY v.visited_at DESC, v.id DESC`).all()
  }));
  add("POST", "/api/admin/visitors", "admin", ({ body }) => {
    const visitorName = text(body.visitorName, "Visitor name");
    const accountId = text(body.accountId, "Resident", { max: 64 });
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND role = 'resident'").get(accountId)) {
      throw new HttpError(400, "Choose a valid resident.");
    }
    const visitedAt = whole(body.visitedAt, "Date and time", 946684800000, 4102444800000);
    const result = db.prepare("INSERT INTO visitors (visitor_name, account_id, visited_at, created_at, status) VALUES (?, ?, ?, ?, 'approved')")
      .run(visitorName, accountId, visitedAt, Date.now());
    return created({ id: Number(result.lastInsertRowid) });
  });
  add("POST", "/api/admin/visitors/:id/approve", "admin", ({ params, user }) => {
    const id = idParam(params);
    const result = db.prepare("UPDATE visitors SET status = 'approved' WHERE id = ? AND status = 'pending'").run(id);
    if (!result.changes) {
      if (!db.prepare("SELECT 1 FROM visitors WHERE id = ?").get(id)) throw new HttpError(404, "Visitor entry was not found.");
    }
    db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE visitor_id = ? AND account_id = ?")
      .run(Date.now(), id, user.id);
    return { ok: true };
  });
  add("DELETE", "/api/admin/visitors/:id", "admin", ({ params }) =>
    requireFound(db.prepare("DELETE FROM visitors WHERE id = ?").run(idParam(params)), "Visitor entry"));

  // ---------- Admin notifications ----------
  add("GET", "/api/admin/notifications", "admin", ({ user }) => ({
    unreadCount: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read_at IS NULL").get(user.id).n,
    notifications: db.prepare(`
      SELECT id, visitor_id AS visitorId, title, body, created_at AS createdAt, read_at AS readAt
      FROM notifications WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`).all(user.id)
  }));
  add("PATCH", "/api/admin/notifications/:id", "admin", ({ params, user }) => {
    const result = db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND account_id = ?")
      .run(Date.now(), idParam(params), user.id);
    return requireFound(result, "Notification");
  });

  // ---------- Resident notifications ----------
  add("GET", "/api/me/notifications", "resident", ({ user }) => ({
    unreadCount: db.prepare("SELECT COUNT(*) AS n FROM resident_notifications WHERE account_id = ? AND read_at IS NULL").get(user.id).n,
    notifications: db.prepare(`
      SELECT id, kind, title, body, created_at AS createdAt, read_at AS readAt
      FROM resident_notifications WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`).all(user.id)
  }));
  add("PATCH", "/api/me/notifications/:id", "resident", ({ params, user }) => {
    const result = db.prepare("UPDATE resident_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND account_id = ?")
      .run(Date.now(), idParam(params), user.id);
    return requireFound(result, "Notification");
  });

  // ---------- Curfew ----------
  add("GET", "/api/admin/curfew", "admin", () => ({ curfewTime: curfewTime() }));

  add("PATCH", "/api/admin/curfew", "admin", ({ body }) => {
    const time = timeText(body.curfewTime, "Curfew time");
    db.prepare("UPDATE settings SET value = ? WHERE key = 'curfew_time'").run(time);
    return { curfewTime: time };
  });

  // ---------- Resident self-service ----------
  add("GET", "/api/me/overview", "resident", ({ user }) => {
    ensureMonthlyRentPayments();
    const today = localDate(new Date());
    const room = user.room_id ? loadRoom(user.room_id) : null;
    const payments = db.prepare(`${paymentSelect} WHERE p.account_id = ? ORDER BY p.due_date DESC, p.id DESC`)
      .all(today, user.id).map(mapPayment);
    const nextPayment = payments.filter((p) => p.status !== "paid").sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] || null;
    const visitors = db.prepare(`${visitorSelect} WHERE v.account_id = ? ORDER BY v.visited_at DESC LIMIT 50`).all(user.id);
    return {
      user: publicUser(user),
      room: room && {
        number: room.number, capacity: room.capacity, rent: room.rent, maintenance: room.maintenance,
        notes: room.notes, photoData: room.photoData, roommates: room.occupants.filter((o) => o.id !== user.id).map((o) => o.name)
      },
      payments,
      nextPayment,
      totalPaid: payments.filter((p) => p.status === "paid").reduce((sum, p) => sum + p.amount, 0),
      visitors,
      curfew: { curfewTime: curfewTime() }
    };
  });
  add("POST", "/api/me/payments/monthly", "resident", ({ body, user }) => {
    const amount = whole(body.amount, "Amount", 1, 100000000);
    const orNumber = text(body.orNumber, "OR number", { max: 64 });
    const orImageData = paymentProofImage(body.orImageData);
    db.exec("BEGIN IMMEDIATE");
    try {
      assertUniqueOrNumber(orNumber);
      const result = db.prepare(`INSERT INTO payments
        (account_id, amount, paid_amount, status, due_date, note, or_number, payment_type, billing_frequency,
         or_image_data, or_verification_status, or_submitted_amount, created_at)
        VALUES (?, ?, NULL, 'pending', ?, 'Monthly rent payment', ?, 'Monthly Rent', 'Monthly',
          ?, 'pending', ?, ?)`)
        .run(user.id, amount, localDate(new Date()), orNumber, orImageData, amount, Date.now());
      const payment = loadPayment(Number(result.lastInsertRowid));
      db.exec("COMMIT");
      return created({ payment });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  add("POST", "/api/me/payments/advance", "resident", ({ body, user }) => {
    ensureMonthlyRentPayments();
    const resident = db.prepare(`
      SELECT a.move_in_date, a.status, r.rent
      FROM accounts a LEFT JOIN rooms r ON r.id = a.room_id
      WHERE a.id = ? AND a.role = 'resident'
    `).get(user.id);
    if (!resident) throw new HttpError(404, "Resident was not found.");
    const hasRoomRent = Boolean(resident.move_in_date && ["Active", "On Leave"].includes(resident.status) && resident.rent);
    const amount = hasRoomRent ? null : whole(body.amount, "Amount", 1, 100000000);
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentMonth = localDate(new Date()).slice(0, 7);
      const unpaidAdvance = db.prepare(`SELECT id FROM payments WHERE account_id = ? AND payment_type = 'Monthly Rent'
        AND billing_frequency = 'Monthly' AND substr(due_date, 1, 7) > ? AND status != 'paid'
        ORDER BY due_date ASC LIMIT 1`).get(user.id, currentMonth);
      if (unpaidAdvance) {
        db.exec("COMMIT");
        return { payment: loadPayment(unpaidAdvance.id), alreadyExists: true };
      }
      const latest = db.prepare(`SELECT MAX(COALESCE(billing_period, substr(due_date, 1, 7))) AS month
        FROM payments WHERE account_id = ? AND payment_type = 'Monthly Rent' AND billing_frequency = 'Monthly'`)
        .get(user.id).month;
      const base = latest && latest > currentMonth ? latest : currentMonth;
      const [year, monthNumber] = base.split("-").map(Number);
      const nextMonthDate = monthNumber === 12 ? new Date(year + 1, 0, 1) : new Date(year, monthNumber, 1);
      const nextMonth = `${nextMonthDate.getFullYear()}-${pad(nextMonthDate.getMonth() + 1)}`;
      const existing = db.prepare(`SELECT id FROM payments WHERE account_id = ? AND payment_type = 'Monthly Rent'
        AND billing_frequency = 'Monthly' AND (billing_period = ? OR substr(due_date, 1, 7) = ?) LIMIT 1`)
        .get(user.id, nextMonth, nextMonth);
      if (existing) {
        db.exec("COMMIT");
        return { payment: loadPayment(existing.id), alreadyExists: true };
      }
      const lastDay = new Date(nextMonthDate.getFullYear(), nextMonthDate.getMonth() + 1, 0).getDate();
      const moveInDay = hasRoomRent ? Number(resident.move_in_date.slice(8, 10)) : 1;
      const dueDate = `${nextMonth}-${String(Math.min(moveInDay, lastDay)).padStart(2, "0")}`;
      const result = db.prepare(`INSERT INTO payments
        (account_id, amount, paid_amount, status, due_date, note, payment_type, billing_frequency, billing_period, created_at)
        VALUES (?, ?, NULL, 'pending', ?, ?, 'Monthly Rent', 'Monthly', ?, ?)`)
        .run(user.id, amount ?? resident.rent, dueDate, `Advance rent for ${nextMonth}`, nextMonth, Date.now());
      db.exec("COMMIT");
      return created({ payment: loadPayment(Number(result.lastInsertRowid)), alreadyExists: false });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  add("POST", "/api/me/payments/deposit", "resident", ({ body, user }) => {
    const amount = whole(body.amount, "Amount", 1, 100000000);
    const orNumber = text(body.orNumber, "OR number", { max: 64 });
    const orImageData = paymentProofImage(body.orImageData);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT id FROM payments WHERE account_id = ? AND is_security_deposit = 1 LIMIT 1").get(user.id);
      if (existing) throw new HttpError(409, "A security deposit payment already exists. Submit or review its payment proof in your payment history.");
      assertUniqueOrNumber(orNumber);
      const result = db.prepare(`INSERT INTO payments
        (account_id, amount, paid_amount, status, due_date, note, or_number, payment_type, is_security_deposit,
         billing_frequency, or_image_data, or_verification_status, or_submitted_amount, created_at)
        VALUES (?, ?, NULL, 'pending', ?, 'Security deposit', ?, 'Reservation Fee', 1,
          'Monthly', ?, 'pending', ?, ?)`)
        .run(user.id, amount, localDate(new Date()), orNumber, orImageData, amount, Date.now());
      const payment = loadPayment(Number(result.lastInsertRowid));
      db.exec("COMMIT");
      return created({ payment });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  add("POST", "/api/me/payments/:id/or", "resident", ({ body, params, user }) => {
    const id = idParam(params);
    const orNumber = text(body.orNumber, "OR number", { max: 64 });
    const submittedAmount = body.submittedAmount === undefined ? null : whole(body.submittedAmount, "Amount to pay", 1, 100000000);
    const orImageData = paymentProofImage(body.orImageData);
    db.exec("BEGIN IMMEDIATE");
    try {
      const payment = db.prepare("SELECT id, amount, status, or_verification_status FROM payments WHERE id = ? AND account_id = ?").get(id, user.id);
      if (!payment) throw new HttpError(404, "Payment was not found.");
      if (payment.status === "paid") throw new HttpError(409, "This payment has already been paid.");
      if (payment.or_verification_status === "pending") throw new HttpError(409, "This OR is already awaiting administrator verification.");
      const amountToSubmit = submittedAmount ?? payment.amount;
      if (amountToSubmit > payment.amount) throw new HttpError(422, "Amount to pay cannot exceed the remaining bill.");
      assertUniqueOrNumber(orNumber, id);
      db.prepare(`UPDATE payments SET or_number = ?, or_image_data = ?, or_submitted_amount = ?, or_verification_status = 'pending'
        WHERE id = ? AND account_id = ?`)
        .run(orNumber, orImageData, amountToSubmit, id, user.id);
      db.exec("COMMIT");
      return { payment: loadPayment(id) };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  add("PATCH", "/api/me/payments/:id/or", "resident", ({ body, params, user }) => {
    const id = idParam(params);
    const orNumber = text(body.orNumber, "OR number", { max: 64 });
    const submittedAmount = body.submittedAmount === undefined ? null : whole(body.submittedAmount, "Amount to pay", 1, 100000000);
    const orImageData = has(body, "orImageData") ? paymentProofImage(body.orImageData) : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const payment = db.prepare("SELECT amount, status, or_verification_status, or_submitted_amount FROM payments WHERE id = ? AND account_id = ?").get(id, user.id);
      if (!payment) throw new HttpError(404, "Payment was not found.");
      if (payment.status === "paid" || payment.or_verification_status !== "pending") {
        throw new HttpError(409, "This payment is no longer awaiting administrator verification.");
      }
      const amountToSubmit = submittedAmount ?? payment.or_submitted_amount ?? payment.amount;
      if (amountToSubmit > payment.amount) throw new HttpError(422, "Amount to pay cannot exceed the remaining bill.");
      assertUniqueOrNumber(orNumber, id);
      db.prepare(`UPDATE payments SET or_number = ?, or_image_data = COALESCE(?, or_image_data), or_submitted_amount = ?
        WHERE id = ? AND account_id = ? AND status != 'paid' AND or_verification_status = 'pending'`)
        .run(orNumber, orImageData, amountToSubmit, id, user.id);
      db.exec("COMMIT");
      return { payment: loadPayment(id) };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  add("POST", "/api/me/visitors", "resident", ({ body, user }) => {
    const visitorName = text(body.visitorName, "Visitor name");
    const visitedAt = whole(body.visitedAt, "Date and time", 946684800000, 4102444800000);
    const createdAt = Date.now();
    const result = db.prepare("INSERT INTO visitors (visitor_name, account_id, visited_at, created_at, status) VALUES (?, ?, ?, ?, 'approved')")
      .run(visitorName, user.id, visitedAt, createdAt);
    const visitorId = Number(result.lastInsertRowid);
    return created({ visitor: db.prepare(`${visitorSelect} WHERE v.id = ?`).get(visitorId) });
  });

  return { add, routes };
}

module.exports = { HttpError, MAX_ROOM_IMAGE_BYTES, createApi, localDate };
