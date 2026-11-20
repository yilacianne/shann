const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const passwordOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummySalt = Buffer.alloc(16, 0);
const dummyHash = scryptSync("not-a-real-password", dummySalt, 64, passwordOptions);

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

function openStore(databasePath = process.env.DMS_DB_PATH || path.join(__dirname, "data", "dormitory-v2.sqlite")) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT NOT NULL UNIQUE COLLATE NOCASE,
      capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 20),
      rent INTEGER NOT NULL DEFAULT 0 CHECK (rent >= 0),
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance')),
      notes TEXT NOT NULL DEFAULT '',
      photo_data TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      parent_name TEXT NOT NULL DEFAULT '',
      parent_phone TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK (role IN ('admin', 'resident')),
      room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'Unassigned' CHECK (status IN ('Active', 'On Leave', 'Reserved', 'Moved Out', 'Unassigned')),
      move_in_date TEXT,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL CHECK (amount > 0),
      paid_amount INTEGER CHECK (paid_amount IS NULL OR paid_amount >= 0),
      status TEXT NOT NULL CHECK (status IN ('paid', 'pending', 'overdue')),
      due_date TEXT NOT NULL,
      paid_date TEXT,
      note TEXT NOT NULL DEFAULT '',
      or_number TEXT NOT NULL DEFAULT '',
      payment_type TEXT NOT NULL DEFAULT 'Monthly Rent' CHECK (payment_type IN ('Reservation Fee', 'Monthly Rent', 'Damage Penalty')),
      is_security_deposit INTEGER NOT NULL DEFAULT 0 CHECK (is_security_deposit IN (0, 1)),
      is_downpayment INTEGER NOT NULL DEFAULT 0 CHECK (is_downpayment IN (0, 1)),
      billing_frequency TEXT NOT NULL DEFAULT 'Monthly' CHECK (billing_frequency IN ('Daily', 'Weekly', 'Monthly')),
      billing_period TEXT,
      or_image_data TEXT NOT NULL DEFAULT '',
      or_verification_status TEXT NOT NULL DEFAULT 'none',
      or_submitted_amount INTEGER CHECK (or_submitted_amount IS NULL OR or_submitted_amount > 0),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('payment', 'curfew', 'event')),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_name TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      visited_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved'))
    );
    CREATE TABLE IF NOT EXISTS curfew_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      log_date TEXT NOT NULL,
      log_time TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('on_time', 'late')),
      created_at INTEGER NOT NULL,
      UNIQUE (account_id, log_date)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      visitor_id INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      UNIQUE (account_id, visitor_id)
    );
    CREATE TABLE IF NOT EXISTS resident_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('announcement', 'reminder')),
      source_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      UNIQUE (account_id, kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS resident_notifications_unread ON resident_notifications(account_id, read_at);
    CREATE TABLE IF NOT EXISTS resident_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      is_anonymous INTEGER NOT NULL CHECK (is_anonymous IN (0, 1)),
      category TEXT NOT NULL CHECK (category IN ('maintenance', 'safety', 'cleanliness', 'noise', 'other')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK ((is_anonymous = 1 AND account_id IS NULL) OR is_anonymous = 0)
    );
    CREATE INDEX IF NOT EXISTS resident_reports_status ON resident_reports(status, created_at);
    INSERT OR IGNORE INTO settings (key, value) VALUES ('curfew_time', '22:00');
  `);
  const roomColumns = db.prepare("PRAGMA table_info(rooms)").all();
  if (!roomColumns.some((column) => column.name === "photo_data")) {
    db.exec("ALTER TABLE rooms ADD COLUMN photo_data TEXT NOT NULL DEFAULT ''");
  }
  const visitorColumns = db.prepare("PRAGMA table_info(visitors)").all();
  if (!visitorColumns.some((column) => column.name === "status")) {
    db.exec("ALTER TABLE visitors ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved'))");
  }
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all();
  if (!accountColumns.some((column) => column.name === "parent_name")) {
    db.exec("ALTER TABLE accounts ADD COLUMN parent_name TEXT NOT NULL DEFAULT ''");
  }
  if (!accountColumns.some((column) => column.name === "parent_phone")) {
    db.exec("ALTER TABLE accounts ADD COLUMN parent_phone TEXT NOT NULL DEFAULT ''");
  }
  if (!accountColumns.some((column) => column.name === "status")) {
    db.exec("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'Unassigned' CHECK (status IN ('Active', 'On Leave', 'Reserved', 'Moved Out', 'Unassigned'))");
  }
  if (!accountColumns.some((column) => column.name === "move_in_date")) {
    db.exec("ALTER TABLE accounts ADD COLUMN move_in_date TEXT");
  }
  if (accountColumns.some((column) => column.name === "role") && accountColumns.some((column) => column.name === "room_id")) {
    db.exec(`
      UPDATE accounts SET status = CASE WHEN room_id IS NULL THEN 'Unassigned' ELSE 'Active' END
        , move_in_date = CASE WHEN room_id IS NULL THEN NULL ELSE COALESCE(move_in_date, date(created_at / 1000, 'unixepoch', 'localtime')) END
      WHERE role = 'resident' AND status = 'Unassigned' AND room_id IS NOT NULL;
      UPDATE accounts SET move_in_date = date(created_at / 1000, 'unixepoch', 'localtime')
      WHERE role = 'resident' AND status = 'Active' AND room_id IS NOT NULL AND move_in_date IS NULL;
      UPDATE accounts SET room_id = NULL, move_in_date = NULL WHERE role = 'resident' AND status = 'Moved Out';
    `);
  }
  const paymentColumns = db.prepare("PRAGMA table_info(payments)").all();
  if (!paymentColumns.some((column) => column.name === "or_number")) {
    db.exec("ALTER TABLE payments ADD COLUMN or_number TEXT NOT NULL DEFAULT ''");
  }
  if (!paymentColumns.some((column) => column.name === "payment_type")) {
    db.exec("ALTER TABLE payments ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'Monthly Rent' CHECK (payment_type IN ('Reservation Fee', 'Monthly Rent', 'Damage Penalty'))");
  }
  if (!paymentColumns.some((column) => column.name === "recorded_by")) {
    db.exec("ALTER TABLE payments ADD COLUMN recorded_by TEXT REFERENCES accounts(id) ON DELETE SET NULL");
  }
  if (!paymentColumns.some((column) => column.name === "paid_amount")) {
    db.exec("ALTER TABLE payments ADD COLUMN paid_amount INTEGER CHECK (paid_amount IS NULL OR paid_amount >= 0)");
  }
  if (!paymentColumns.some((column) => column.name === "billing_frequency")) {
    db.exec("ALTER TABLE payments ADD COLUMN billing_frequency TEXT NOT NULL DEFAULT 'Monthly' CHECK (billing_frequency IN ('Daily', 'Weekly', 'Monthly'))");
  }
  if (!paymentColumns.some((column) => column.name === "billing_period")) {
    db.exec("ALTER TABLE payments ADD COLUMN billing_period TEXT");
  }
  if (!paymentColumns.some((column) => column.name === "or_image_data")) {
    db.exec("ALTER TABLE payments ADD COLUMN or_image_data TEXT NOT NULL DEFAULT ''");
  }
  if (!paymentColumns.some((column) => column.name === "or_verification_status")) {
    db.exec("ALTER TABLE payments ADD COLUMN or_verification_status TEXT NOT NULL DEFAULT 'none'");
  }
  if (!paymentColumns.some((column) => column.name === "is_security_deposit")) {
    db.exec("ALTER TABLE payments ADD COLUMN is_security_deposit INTEGER NOT NULL DEFAULT 0 CHECK (is_security_deposit IN (0, 1))");
  }
  if (!paymentColumns.some((column) => column.name === "is_downpayment")) {
    db.exec("ALTER TABLE payments ADD COLUMN is_downpayment INTEGER NOT NULL DEFAULT 0 CHECK (is_downpayment IN (0, 1))");
  }
  if (!paymentColumns.some((column) => column.name === "or_submitted_amount")) {
    db.exec("ALTER TABLE payments ADD COLUMN or_submitted_amount INTEGER CHECK (or_submitted_amount IS NULL OR or_submitted_amount > 0)");
  }
  db.exec(`UPDATE payments
    SET status = 'pending', paid_amount = NULL, paid_date = NULL, recorded_by = NULL
    WHERE status = 'paid' AND or_number <> '' AND recorded_by = account_id AND or_verification_status = 'none'`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS payments_billing_period ON payments(account_id, billing_period) WHERE billing_period IS NOT NULL");
  db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE visitor_id IN (SELECT id FROM visitors WHERE status = 'pending')").run(Date.now());
  db.exec("UPDATE visitors SET status = 'approved' WHERE status = 'pending'");
  return db;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, passwordOptions);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

function verifyPassword(password, saltHex, hashHex) {
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = scryptSync(password, salt, expected.length, passwordOptions);
  return timingSafeEqual(actual, expected);
}

function getAccountById(db, id) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

function findAccountByUsername(db, username) {
  return db.prepare("SELECT * FROM accounts WHERE username = ? COLLATE NOCASE")
    .get(String(username).trim());
}

function createAccount(db, { username, name, email = "", phone = "", parentName = "", parentPhone = "", password, role, roomId = null }) {
  if (role !== "admin" && role !== "resident") throw new TypeError("Account role must be admin or resident.");
  const credentials = hashPassword(password);
  const id = randomUUID();
  const now = new Date();
  const moveInDate = role === "resident" && roomId !== null
    ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    : null;
  db.prepare(`
    INSERT INTO accounts (id, username, name, email, phone, parent_name, parent_phone, role, room_id, status, move_in_date, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, String(username).trim(), name.trim(), email.trim(), phone.trim(), parentName.trim(), parentPhone.trim(),
    role, roomId, role === "resident" ? roomId === null ? "Unassigned" : "Active" : "Unassigned",
    moveInDate, credentials.salt, credentials.hash, Date.now()
  );
  return getAccountById(db, id);
}

function setPassword(db, id, password) {
  const credentials = hashPassword(password);
  db.prepare("UPDATE accounts SET password_salt = ?, password_hash = ? WHERE id = ?").run(credentials.salt, credentials.hash, id);
  db.prepare("DELETE FROM sessions WHERE account_id = ?").run(id);
}

function publicUser(account) {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    email: account.email,
    phone: account.phone,
    role: account.role,
    roomId: account.room_id ?? null
  };
}

function isUniqueError(error, column) {
  return String(error && error.message).includes(`UNIQUE constraint failed: ${column}`);
}

module.exports = {
  PASSWORD_MAX,
  PASSWORD_MIN,
  createAccount,
  dummyHashHex: dummyHash.toString("hex"),
  dummySaltHex: dummySalt.toString("hex"),
  findAccountByUsername,
  getAccountById,
  isUniqueError,
  openStore,
  publicUser,
  setPassword,
  verifyPassword
};
