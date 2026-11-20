// Fills a LOCAL database with sample data for trying the app out.
// Do not run this on a real deployment: it creates accounts with well-known passwords.
const { createAccount, findAccountByUsername, openStore } = require("./store");
const { localDate } = require("./api");

const db = openStore();
if (findAccountByUsername(db, "admin")) {
  console.log('Demo data already exists (an "admin" account was found). Nothing changed.');
  db.close();
  process.exit(0);
}

const adminPassword = "admin-demo-12345";
const residentPassword = "resident-demo-12345";
const now = new Date();
const day = (offset) => localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));

createAccount(db, { username: "admin", name: "Residence Administrator", password: adminPassword, role: "admin" });

const rooms = [
  ["101", 1, 1500], ["102", 1, 1500], ["103", 1, 1500], ["104", 2, 1200], ["105", 2, 1200],
  ["201", 2, 1300], ["202", 2, 1300], ["203", 1, 1600], ["204", 3, 1000], ["205", 1, 1500]
];
const roomIds = {};
for (const [number, capacity, rent] of rooms) {
  roomIds[number] = Number(db.prepare("INSERT INTO rooms (number, capacity, rent, status) VALUES (?, ?, ?, ?)")
    .run(number, capacity, rent, number === "205" ? "maintenance" : "available").lastInsertRowid);
}

const residents = [
  ["maria", "Maria Santos", "101"], ["juan", "Juan Dela Cruz", "102"], ["ana", "Ana Reyes", "103"], ["carlos", "Carlos Garcia", "104"]
];
const ids = {};
for (const [username, name, room] of residents) {
  ids[username] = createAccount(db, { username, name, password: residentPassword, role: "resident", roomId: roomIds[room] }).id;
}

const addPayment = db.prepare("INSERT INTO payments (account_id, amount, status, due_date, paid_date, note, created_at) VALUES (?, ?, ?, ?, ?, '', ?)");
addPayment.run(ids.maria, 1500, "paid", day(-20), day(-18), Date.now());
addPayment.run(ids.juan, 1500, "pending", day(5), null, Date.now());
addPayment.run(ids.ana, 1500, "paid", day(-15), day(-14), Date.now());
addPayment.run(ids.carlos, 1200, "pending", day(-3), null, Date.now());

db.prepare("INSERT INTO announcements (title, body, created_at) VALUES (?, ?, ?)")
  .run("Dormitory Announcement", "Please keep our dormitory clean and follow the house rules.", Date.now());
db.prepare("INSERT INTO reminders (kind, title, body, due_date, created_at) VALUES ('payment', 'Payment Reminder', 'Your monthly payment is due soon.', ?, ?)")
  .run(day(5), Date.now());
db.prepare("INSERT INTO reminders (kind, title, body, due_date, created_at) VALUES ('curfew', 'Curfew Reminder', 'Please be inside the dormitory before 10:00 PM.', NULL, ?)")
  .run(Date.now());
db.prepare("INSERT INTO visitors (visitor_name, account_id, visited_at, created_at) VALUES ('John Ten', ?, ?, ?)")
  .run(ids.maria, Date.now() - 86400000, Date.now());

console.log("Demo data created.");
console.log(`  Admin:    admin / ${adminPassword}`);
console.log(`  Residents: maria, juan, ana, carlos / ${residentPassword}`);
db.close();
