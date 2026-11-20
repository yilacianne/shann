/* Administrator dashboard */
const MODULES = [
  { go: "residents", icon: "users", label: "Resident Management", category: "People & access" },
  { go: "admin-accounts", icon: "user", label: "Admin Accounts", category: "People & access" },
  { go: "rooms", icon: "bed", label: "Room Management", category: "People & access" },
  { go: "payments", icon: "wallet", label: "Payment Monitoring", category: "Daily operations" },
  { go: "visitors", icon: "card", label: "Visitor Log", category: "Daily operations" },
  { go: "curfew", icon: "clock", label: "Curfew Schedule", category: "Daily operations" },
  { go: "announcements", icon: "megaphone", label: "Announcements", category: "Communication" },
  { go: "reports", icon: "alert", label: "Resident Reports", category: "Communication" },
  { go: "reminders", icon: "bell", label: "Reminders", category: "Communication" }
];
const BOTTOM_TABS = ["home", "residents", "payments"];
const state = {
  residents: [], adminAccounts: [], payments: [], paymentHistory: [],
  paymentView: "main",
  paymentSearch: "", paymentPage: 1, paymentPageSize: 5,
  search: "", me: null, unreadNotifications: 0, roomDetailsId: null
};
const $ = (id) => document.getElementById(id);
const body = (name) => $(`body-${name}`);
let rentChart;

const emptyBox = (title, text) => `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;
const moduleButton = (m) => `<button class="module${m.wide ? " wide" : ""}" type="button" data-go="${m.go}">${icon(m.icon)}<span>${esc(m.label)}</span></button>`;
const moduleGroups = () => [...new Set(MODULES.map((module) => module.category))].map((category) => `
  <section class="module-group"><h3>${esc(category)}</h3><div class="module-grid">
    ${MODULES.filter((module) => module.category === category).map(moduleButton).join("")}
  </div></section>`).join("");

/* ---------- Home ---------- */
async function renderHome() {
  const [s, { rooms }, { visitors }, curfew, { payments }, { announcements }, { reminders }, { reports }] = await Promise.all([
    api("GET", "/api/admin/summary"),
    api("GET", "/api/admin/rooms"),
    api("GET", "/api/admin/visitors"),
    api("GET", "/api/admin/curfew"),
    api("GET", "/api/admin/payments"),
    api("GET", "/api/announcements"),
    api("GET", "/api/reminders"),
    api("GET", "/api/admin/reports")
  ]);
  rentChart?.destroy();
  const occupiedRooms = rooms.filter((room) => room.occupants.length > 0).length;
  const pendingVisitors = visitors.filter((visitor) => visitor.status === "pending");
  const openReports = reports.filter((report) => report.status !== "resolved");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const schedule = [
    ...payments
      .filter((payment) => payment.status !== "paid" && payment.dueDate && new Date(`${payment.dueDate}T00:00:00`) >= today)
      .map((payment) => ({
        date: `${payment.dueDate}T00:00:00`,
        dateLabel: formatDate(payment.dueDate),
        title: `Rent due · ${payment.residentName}`,
        description: `${peso(payment.amount)}${payment.roomNumber ? ` · Room ${payment.roomNumber}` : ""}`,
        glyph: "wallet"
      })),
    ...reminders
      .filter((reminder) => reminder.dueDate && new Date(`${reminder.dueDate}T00:00:00`) >= today)
      .map((reminder) => ({
        date: `${reminder.dueDate}T00:00:00`,
        dateLabel: formatDate(reminder.dueDate),
        title: reminder.title,
        description: reminder.body || "Reminder",
        glyph: reminder.kind === "payment" ? "wallet" : reminder.kind === "event" ? "calendar" : "clock"
      })),
    ...announcements.slice(0, 3).map((announcement) => ({
      date: announcement.createdAt,
      dateLabel: formatDate(announcement.createdAt),
      title: announcement.title,
      description: announcement.body,
      glyph: "megaphone"
    }))
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).slice(0, 6);
  body("home").innerHTML = `
    <div class="dashboard-intro">
      <div><p class="dashboard-eyebrow">OVERVIEW</p><h2>Welcome back, ${esc(state.me.name.split(/\s+/)[0])}</h2><p class="muted">Here’s what’s happening at your dormitory today.</p></div>
    </div>
    <div class="dashboard-stat-grid">
      <article class="dashboard-stat"><span class="stat-icon mint">${icon("bed")}</span><div><span class="dashboard-stat-label">Occupied rooms</span><strong>${occupiedRooms}<small> / ${rooms.length} total</small></strong></div></article>
      <article class="dashboard-stat"><span class="stat-icon blue">${icon("users")}</span><div><span class="dashboard-stat-label">Total residents</span><strong>${s.residents}</strong></div></article>
      <article class="dashboard-stat"><span class="stat-icon amber">${icon("wallet")}</span><div><span class="dashboard-stat-label">Pending rent payments</span><strong>${s.pendingCount}</strong></div></article>
      <article class="dashboard-stat"><span class="stat-icon rose">${icon("card")}</span><div><span class="dashboard-stat-label">Pending visitor approvals</span><strong>${pendingVisitors.length}</strong></div></article>
      <article class="dashboard-stat"><span class="stat-icon amber">${icon("alert")}</span><div><span class="dashboard-stat-label">Open resident reports</span><strong>${openReports.length}</strong></div></article>
    </div>
    <div class="dashboard-main-grid">
      <section class="dashboard-panel rent-panel">
        <div class="panel-heading"><div><h3>Monthly rent collection</h3><p class="muted">Paid rent over the last six months</p></div><span class="panel-total">${peso(s.collected)}<small> collected</small></span></div>
        <div class="chart-wrap"><canvas id="rent-chart" role="img" aria-label="Monthly rent collection line chart"></canvas></div>
        <p class="chart-unavailable" id="rent-chart-fallback" hidden>Chart is unavailable. The collection total is still shown above.</p>
      </section>
      <section class="dashboard-panel curfew-panel">
        <div class="panel-heading"><div><h3>Curfew schedule</h3><p class="muted">Residents should be inside by</p></div></div>
        <div class="curfew-schedule-time">${formatClock(curfew.curfewTime)}</div>
        <button class="text-link" type="button" data-go="curfew">Change curfew time</button>
      </section>
      <section class="dashboard-panel visitor-panel">
        <div class="panel-heading"><div><h3>Visitor approvals</h3><p class="muted">Requests waiting for review</p></div><button class="text-link" type="button" data-go="visitors">View all</button></div>
        ${pendingVisitors.length ? `<div class="dashboard-list">${pendingVisitors.slice(0, 5).map((visitor) => `
          <div class="dashboard-list-item">${avatar(visitor.residentName)}
            <div class="grow"><strong>${esc(visitor.visitorName)}</strong><small>${esc(visitor.residentName)}${visitor.roomNumber ? ` · Room ${esc(visitor.roomNumber)}` : ""}</small><small>${formatDateTime(visitor.visitedAt)}</small></div>
            <button class="btn btn-primary small" type="button" data-approve-visitor="${visitor.id}">Approve</button>
          </div>`).join("")}</div>` : emptyBox("No approvals waiting", "New visitor requests will appear here.")}
      </section>
      <section class="dashboard-panel">
        <div class="panel-heading"><div><h3>Resident reports</h3><p class="muted">Problems submitted by residents</p></div><button class="text-link" type="button" data-go="reports">View all</button></div>
        ${openReports.length ? `<div class="dashboard-list">${openReports.slice(0, 5).map((report) => `
          <div class="dashboard-list-item"><span class="schedule-icon">${icon("alert")}</span>
            <div class="grow"><strong>${esc(report.title)}</strong><small>${esc(report.residentName)} · ${esc(REPORT_CATEGORY_LABELS[report.category])}</small></div>
            <span class="pill pending">${esc(REPORT_STATUS_LABELS[report.status])}</span>
          </div>`).join("")}</div>` : emptyBox("No open reports", "New resident reports will appear here.") }
      </section>
      <section class="dashboard-panel schedule-panel">
        <div class="panel-heading"><div><h3>Announcements &amp; due dates</h3><p class="muted">Upcoming reminders and rent dates</p></div><button class="text-link" type="button" data-go="announcements">Announcements</button></div>
        ${schedule.length ? `<div class="dashboard-list">${schedule.map((item) => `
          <div class="dashboard-list-item schedule-item"><span class="schedule-icon">${icon(item.glyph)}</span>
            <div class="grow"><strong>${esc(item.title)}</strong><small>${esc(item.description)}</small></div><time>${esc(item.dateLabel)}</time>
          </div>`).join("")}</div>` : emptyBox("Nothing scheduled", "Upcoming rent dates and reminders will appear here.")}
      </section>
    </div>`;
  if (window.Chart) {
    rentChart = new Chart($("rent-chart"), {
      type: "line",
      data: {
        labels: s.monthly.map((month) => month.label),
        datasets: [{
          data: s.monthly.map((month) => month.total),
          borderColor: "#d1ad4f",
          backgroundColor: "rgba(209,173,79,.14)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => peso(context.raw) } } },
        scales: {
          y: { beginAtZero: true, ticks: { color: currentTheme() === "dark" ? "#bcaeb0" : "#75656a", callback: (value) => `₱${Number(value).toLocaleString("en-PH")}` }, grid: { color: "rgba(160,140,140,.15)" } },
          x: { ticks: { color: currentTheme() === "dark" ? "#bcaeb0" : "#75656a" }, grid: { display: false } }
        }
      }
    });
  } else {
    $("rent-chart-fallback").hidden = false;
  }
}

/* ---------- Residents ---------- */
async function loadResidents() {
  state.residents = (await api("GET", "/api/admin/residents")).residents;
}

function residentRow(r) {
  return `<div class="row">${avatar(r.name)}
    <div class="grow"><button class="resident-name" type="button" data-edit="${esc(r.id)}" aria-label="Edit ${esc(r.name)}">${esc(r.name)}</button><small>${r.roomNumber ? `Room ${esc(r.roomNumber)}` : "No room assigned"}</small><small class="parent-contact">Parent: ${esc(r.parentName)} · ${esc(r.parentPhone)}</small><small>Registered: ${formatDate(r.registeredAt)}</small></div>
    <button class="dots" type="button" data-remove="${esc(r.id)}" aria-label="Remove ${esc(r.name)}">⋮</button></div>`;
}

function drawResidents() {
  const q = state.search.trim().toLowerCase();
  const list = state.residents.filter((r) => !q || [r.name, r.username, r.roomNumber, r.email].some((v) => String(v || "").toLowerCase().includes(q)));
  $("resident-list").innerHTML = list.length
    ? `<div class="list">${list.map(residentRow).join("")}</div>`
    : state.residents.length ? emptyBox("No matches", "Try a different name or room.") : emptyBox("No residents yet", "Use the + button to add your first resident.");
}

async function renderResidents() {
  if (!$("resident-search")) {
    body("residents").innerHTML = `<div class="action-row"><label class="search">${icon("search")}<input id="resident-search" type="search" placeholder="Search resident…" aria-label="Search residents"></label><button class="btn btn-ghost small" id="export-residents" type="button">Export CSV</button><button class="btn btn-primary" id="add-resident-action" type="button">${icon("plus")} Add resident</button></div><div id="resident-list"></div>`;
    $("resident-search").value = state.search;
    $("resident-search").addEventListener("input", (e) => { state.search = e.target.value; drawResidents(); });
    $("add-resident-action").addEventListener("click", () => residentForm(null).catch((error) => toast(error.message, true)));
    $("export-residents").addEventListener("click", () => downloadCsv(
      "dormitory-residents.csv",
      ["Student ID", "Full name", "Email", "Phone", "Room", "Registered"],
      state.residents.map((r) => [r.username, r.name, r.email, r.phone, r.roomNumber, formatDate(r.registeredAt)])
    ));
  }
  await loadResidents();
  drawResidents();
}

async function residentForm(resident) {
  const { rooms } = await api("GET", "/api/admin/rooms");
  const roomOptions = [{ value: "", label: "No room assigned" }].concat(rooms.filter((r) => r.availableBeds > 0 && !r.maintenance).map((r) => ({
    value: r.id, label: `Room ${r.number} · ${r.availableBeds} available`
  })));
  const editing = Boolean(resident);
  openForm({
    title: editing ? "Edit resident" : "Add resident",
    intro: editing ? "" : "Residents sign in with the student ID and password you set here.",
    submitLabel: editing ? "Save changes" : "Add resident",
    fields: [
      { name: "name", label: "Full name", required: true, value: resident?.name, placeholder: "e.g. Maria Santos", autocomplete: "off" },
      { name: "username", label: "Student ID", required: true, value: resident?.username, readonly: editing, placeholder: "e.g. 20240001", autocomplete: "off" },
      { name: "password", label: editing ? "New password (optional)" : "Password", type: "password", required: !editing, generate: true, showPassword: true, minlength: 12, autocomplete: "new-password", help: editing ? "Leave blank to keep the current password. At least 12 characters." : "At least 12 characters. Share it with the resident." },
      { name: "email", label: "Email", type: "email", required: true, maxlength: 254, value: resident?.email, autocomplete: "email" },
      { name: "phone", label: "Phone", type: "tel", required: true, maxlength: 40, value: resident?.phone, autocomplete: "tel" },
      { name: "parentName", label: "Parent/Guardian full name", required: true, maxlength: 100, value: resident?.parentName, autocomplete: "name" },
      { name: "parentPhone", label: "Parent/Guardian phone", type: "tel", required: true, maxlength: 40, value: resident?.parentPhone, autocomplete: "tel" },
      ...(!editing ? [{ name: "roomId", label: "Room", type: "select", options: roomOptions, value: "" }] : [])
    ],
    onSubmit: async (v) => {
      const payload = { name: v.name, email: v.email, phone: v.phone, parentName: v.parentName, parentPhone: v.parentPhone, password: v.password };
      if (editing) await api("PATCH", `/api/admin/residents/${resident.id}`, payload);
      else await api("POST", "/api/admin/residents", { ...payload, username: v.username, roomId: v.roomId || null });
      toast(editing ? "Resident updated." : `${v.name} added.`);
      await renderResidents();
    }
  });
}

/* ---------- Admin accounts ---------- */
async function renderAdminAccounts() {
  const { accounts } = await api("GET", "/api/admin/accounts");
  state.adminAccounts = accounts;
  body("admin-accounts").innerHTML = `
    <p class="muted">Only administrators can add other administrators. Admin accounts have access to all management features.</p>
    ${accounts.length ? `<div class="list">${accounts.map((account) => `<button class="row admin-account-row" type="button" data-admin-account="${esc(account.id)}" aria-label="Edit admin account ${esc(account.name)}">${avatar(account.name)}
      <span class="grow"><strong>${esc(account.name)}</strong><small>Username: ${esc(account.username)}</small>
      <small>${account.email ? esc(account.email) : "No email"}${account.phone ? ` · ${esc(account.phone)}` : ""} · Added ${formatDate(account.createdAt)}</small></span>
      <span class="pill ${account.id === state.me.id ? "info" : "available"}">${account.id === state.me.id ? "You" : "Admin"}</span></button>`).join("")}</div>`
      : emptyBox("No admin accounts", "Use the + button to add an administrator.")}`;
}

function adminAccountForm(account = null) {
  const editing = Boolean(account);
  openForm({
    title: editing ? "Edit admin account" : "Create admin account",
    intro: editing ? "Update the administrator's account details." : "Generate a password or enter one, then copy and share it securely. The new administrator can manage all system records.",
    submitLabel: editing ? "Save changes" : "Create admin",
    fields: [
      { name: "name", label: "Full name", required: true, max: 100, value: account?.name, autocomplete: "name" },
      { name: "username", label: "Admin username", required: true, min: 3, maxlength: 32, value: account?.username, placeholder: "e.g. admin2", autocomplete: "off", help: "3–32 letters, numbers, dots, dashes or underscores." },
      {
        name: "password", label: editing ? "New password (optional)" : "Temporary password", type: "password",
        required: !editing, generate: !editing, minlength: 12, maxlength: 128, autocomplete: "new-password",
        help: editing ? "Leave blank to keep the current password. New passwords must be at least 12 characters." : "At least 12 characters. Copy it before creating the account."
      },
      { name: "email", label: "Email", type: "email", required: true, max: 254, value: account?.email, autocomplete: "email" },
      { name: "phone", label: "Phone (optional)", type: "tel", max: 40, value: account?.phone, autocomplete: "tel" }
    ],
    onSubmit: async (values) => {
      if (editing) {
        await api("PATCH", `/api/admin/accounts/${account.id}`, {
          name: values.name, username: values.username, email: values.email, phone: values.phone, password: values.password
        });
        toast("Admin account updated.");
      } else {
        await api("POST", "/api/admin/accounts", {
          name: values.name, username: values.username, password: values.password,
          email: values.email, phone: values.phone
        });
        toast(`Admin account ${values.username} created. Share its password securely.`);
      }
      await renderAdminAccounts();
    }
  });
}

/* ---------- Payments ---------- */
function drawPayments() {
  const query = state.paymentSearch.trim().toLowerCase();
  const filtered = state.payments.filter((p) => !query || String(p.residentName || "").toLowerCase().includes(query));
  const pageCount = Math.max(1, Math.ceil(filtered.length / state.paymentPageSize));
  state.paymentPage = Math.min(state.paymentPage, pageCount);
  const offset = (state.paymentPage - 1) * state.paymentPageSize;
  const list = filtered.slice(offset, offset + state.paymentPageSize);
  $("payment-list").innerHTML = filtered.length ? `<div class="table-wrap"><table class="payment-history-table"><thead><tr>
    <th>Resident</th><th>Room</th><th>Type</th><th>Dorm payment</th><th>Status</th><th>Due date</th><th>OR number</th><th>Paid date</th><th>Verification</th>
    </tr></thead><tbody>${list.map((p) => `<tr><td>${esc(p.residentName)}</td><td>${p.roomNumber ? `Room ${esc(p.roomNumber)}` : "—"}</td>
      <td><strong>${esc(p.paymentType)}</strong>${p.paymentType === "Monthly Rent" ? `<small class="payment-type-detail">${esc(p.billingFrequency)}</small>` : ""}</td>
      <td>${peso(p.amount)}</td><td><span class="pill ${p.status}">${STATUS_LABELS[p.status]}</span>
        ${p.verificationStatus === "pending" ? '<small class="payment-verification-note">Awaiting verification</small>' : ""}</td><td>${formatDate(p.dueDate)}</td>
      <td>${esc(p.orNumber || "—")}</td><td>${p.paidDate ? formatDate(p.paidDate) : "—"}</td>
      <td>${p.verificationStatus === "pending" && p.status !== "paid"
        ? `<button class="btn payment-outline small" type="button" data-verify-payment="${p.id}">Review OR</button>`
        : p.verificationStatus === "verified" ? '<span class="verification-state verified">Verified</span>'
          : p.verificationStatus === "rejected" && p.status !== "paid" ? '<span class="verification-state rejected">Rejected</span>' : "—"}</td></tr>`).join("")}</tbody></table></div>`
    + `<div class="payment-pagination"><span>Showing ${offset + 1}–${Math.min(offset + state.paymentPageSize, filtered.length)} of ${filtered.length}</span>
      <div class="payment-pagination-controls"><label>Rows per page
        <select id="payment-page-size" aria-label="Rows per page">${[5, 10, 25].map((size) => `<option value="${size}"${size === state.paymentPageSize ? " selected" : ""}>${size}</option>`).join("")}</select>
      </label><button class="btn payment-outline small" type="button" data-payment-page="-1"${state.paymentPage <= 1 ? " disabled" : ""}>Previous</button>
      <span>Page ${state.paymentPage} of ${pageCount}</span>
      <button class="btn payment-outline small" type="button" data-payment-page="1"${state.paymentPage >= pageCount ? " disabled" : ""}>Next</button></div></div>`
    : emptyBox("No payments here", state.payments.length ? "No resident matches that name." : "Monthly rent bills are generated automatically; use + to add another payment.");
  const pageSize = $("payment-page-size");
  if (pageSize) pageSize.addEventListener("change", () => {
    state.paymentPageSize = Number(pageSize.value);
    state.paymentPage = 1;
    drawPayments();
  });
}

async function renderPayments() {
  state.paymentView = "main";
  const [summary, data] = await Promise.all([api("GET", "/api/admin/summary"), api("GET", "/api/admin/payments")]);
  state.payments = data.payments;
  const change = summary.changePercent;
  body("payments").innerHTML = `
    <div class="payments-theme">
    <div class="payment-summary">
      <div><span class="muted">Total Collected</span><strong>${peso(summary.collected)}</strong>
        ${change === null ? "" : `<span class="payment-change">${change < 0 ? "↓" : "↑"} ${Math.abs(change)}%</span>`}</div>
      <button class="btn payment-outline" id="payment-history-button" type="button">History</button>
    </div>
    <label class="search payment-search">${icon("search")}<input id="payment-search" type="search" placeholder="Search resident name…" aria-label="Search by resident name" value="${esc(state.paymentSearch)}"></label>
    <div class="export-row"><button class="btn btn-ghost small" id="export-payments" type="button">Export CSV for Excel</button></div>
    <div id="payment-list"></div>
    </div>`;
  $("payment-history-button").addEventListener("click", () => showPaymentHistory().catch((error) => toast(error.message, true)));
  $("export-payments").addEventListener("click", () => downloadCsv(
    "dormitory-payments.csv",
    ["Resident", "Room", "Billing frequency", "Payment type", "Amount (PHP)", "Status", "Due date", "OR number", "Paid date", "Note"],
    state.payments.map((p) => [p.residentName, p.roomNumber, p.billingFrequency, p.paymentType, p.amount, STATUS_LABELS[p.status] || p.status, p.dueDate, p.orNumber, p.paidDate, p.note])
  ));
  $("payment-search").addEventListener("input", (event) => {
    state.paymentSearch = event.target.value;
    state.paymentPage = 1;
    drawPayments();
  });
  state.paymentPage = 1;
  drawPayments();
}

async function showPaymentHistory() {
  const { payments } = await api("GET", "/api/payments/history");
  state.paymentHistory = payments;
  state.paymentView = "history";
  body("payments").innerHTML = `<div class="payments-theme payment-history-view">
    <div class="payment-history-heading"><h2>Payment History</h2>
      <button class="btn payment-outline" id="payment-history-back" type="button">← Back to Payments</button></div>
    ${payments.length ? `<div class="table-wrap"><table class="payment-history-table">
      <thead><tr><th>Paid date</th><th>Resident</th><th>Room</th><th>Type</th><th>Paid</th><th>OR number</th><th>Recorded by</th></tr></thead>
      <tbody>${payments.map((payment) => `<tr>
        <td>${payment.paidDate ? formatDate(payment.paidDate) : "—"}</td>
        <td>${esc(payment.residentName)}</td><td>${payment.roomNumber ? `Room ${esc(payment.roomNumber)}` : "—"}</td>
        <td>${esc(payment.billingFrequency)} · ${esc(payment.paymentType)}</td><td>${peso(payment.amount)}</td><td>${esc(payment.orNumber || "—")}</td>
        <td>${esc(payment.recordedBy || "—")}</td></tr>`).join("")}</tbody></table></div>
      <p class="payment-history-note">Only paid payments are here.</p>`
      : `${emptyBox("No paid payments", "Recorded payments will appear here.")}<p class="payment-history-note">Only paid payments are here.</p>`}
    </div>`;
  $("payment-history-back").addEventListener("click", () => renderPayments().catch((error) => toast(error.message, true)));
}

async function openPaymentVerification(payment) {
  const { orImageData } = await api("GET", `/api/admin/payments/${payment.id}/proof`);
  const dlg = getDialog("verify-payment-dialog");
  dlg.innerHTML = `<div class="dlg payment-verification-dialog">
    <div class="dlg-head"><h2>Verify resident payment</h2><button class="icon-btn" type="button" data-close aria-label="Close">×</button></div>
    <p class="muted small">${esc(payment.residentName)}${payment.roomNumber ? ` · Room ${esc(payment.roomNumber)}` : ""}</p>
    <div class="payment-verification-details"><span>OR number</span><strong>${esc(payment.orNumber)}</strong><span>Amount submitted</span><strong>${peso(payment.submittedAmount || payment.amount)}</strong><span>Remaining bill</span><strong>${peso(payment.amount)}</strong></div>
    <div class="payment-proof-image">${orImageData ? `<img src="${esc(orImageData)}" alt="Receipt submitted by ${esc(payment.residentName)}">` : '<p class="muted">No receipt image was attached.</p>'}</div>
    <p class="form-status" role="alert"></p>
    <div class="dlg-actions">
      <button class="btn btn-danger" type="button" data-payment-decision="rejected">Reject OR</button>
      <button class="btn btn-ghost" type="button" data-close>Cancel</button>
      <button class="btn payment-save" type="button" data-payment-decision="verified">${payment.submittedAmount && payment.submittedAmount < payment.amount ? "Approve partial payment" : "Approve and mark Paid"}</button>
    </div>
  </div>`;
  dlg.onclick = async (event) => {
    if (event.target === dlg) return dlg.close();
    if (event.target.closest("[data-close]")) return dlg.close();
    const button = event.target.closest("[data-payment-decision]");
    if (!button) return;
    const decision = button.dataset.paymentDecision;
    const partialPayment = payment.submittedAmount && payment.submittedAmount < payment.amount;
    const action = decision === "verified"
      ? partialPayment ? "approve this partial payment and leave the remaining balance due" : "approve this OR and mark the bill Paid"
      : "reject this OR";
    if (!(await confirmAction(`Are you sure you want to ${action}?`, decision === "verified" ? "Approve" : "Reject"))) return;
    const buttons = dlg.querySelectorAll("[data-payment-decision]");
    buttons.forEach((item) => { item.disabled = true; });
    const status = dlg.querySelector(".form-status");
    try {
      await api("PATCH", `/api/admin/payments/${payment.id}/verification`, { decision });
      dlg.close();
      toast(decision !== "verified" ? "OR rejected. The resident can resubmit it."
        : payment.submittedAmount && payment.submittedAmount < payment.amount
          ? "Partial payment approved; the remaining balance is still due."
          : "OR verified; payment marked Paid.");
      await renderPayments();
    } catch (error) {
      status.textContent = error.message;
      buttons.forEach((item) => { item.disabled = false; });
    }
  };
  dlg.showModal();
}

async function paymentForm(payment) {
  if (payment) {
    return openForm({
      title: "Update payment",
      intro: `${payment.residentName}${payment.roomNumber ? ` · Room ${payment.roomNumber}` : ""}`,
      fields: [
        { name: "status", label: "Status", type: "select", value: payment.status, options: ["paid", "pending", "overdue"].map((v) => ({ value: v, label: STATUS_LABELS[v] })) },
        { name: "amount", label: "Amount (₱)", type: "number", min: 1, required: true, value: payment.amount },
        { name: "paymentType", label: "Payment type", type: "select", value: payment.paymentType, options: ["Reservation Fee", "Downpayment", "Monthly Rent", "Damage Penalty", "Security Deposit"].map((value) => ({ value, label: value })), help: "Downpayment and monthly rent are separate bills. Security deposit is refundable." },
        { name: "billingFrequency", label: "Billing frequency", type: "select", value: payment.billingFrequency, options: ["Daily", "Weekly", "Monthly"].map((value) => ({ value, label: value })) },
        { name: "dueDate", label: "Due date", type: "date", required: true, value: payment.dueDate },
        { name: "orNumber", label: "OR number (optional)", max: 64, value: payment.orNumber }
      ],
      onSubmit: async (v) => {
        await api("PATCH", `/api/admin/payments/${payment.id}`, { status: v.status, amount: Number(v.amount), paymentType: v.paymentType, billingFrequency: v.billingFrequency, dueDate: v.dueDate, orNumber: v.orNumber });
        toast("Payment updated.");
        await renderPayments();
      },
      onDelete: async () => { await api("DELETE", `/api/admin/payments/${payment.id}`); toast("Payment deleted."); await renderPayments(); }
    });
  }
  await loadResidents();
  if (!state.residents.length) return toast("Add a resident first, then record their payment.", true);
  const { rooms } = await api("GET", "/api/admin/rooms");
  const rentFor = (residentId) => rooms.find((r) => r.id === state.residents.find((x) => x.id === residentId)?.roomId)?.rent || "";
  openForm({
    title: "Add payment",
    submitLabel: "Add payment",
    fields: [
      {
        name: "accountId", label: "Resident", type: "select", required: true, value: state.residents[0].id,
        options: state.residents.map((r) => ({ value: r.id, label: `${r.name}${r.roomNumber ? ` (Room ${r.roomNumber})` : ""}` })),
        onChange: (value, form) => { const rent = rentFor(value); if (rent) form.elements.amount.value = rent; }
      },
      { name: "amount", label: "Amount (₱)", type: "number", min: 1, required: true, value: rentFor(state.residents[0].id) },
      { name: "status", label: "Status", type: "select", value: "pending", options: ["pending", "paid", "overdue"].map((v) => ({ value: v, label: STATUS_LABELS[v] })) },
      { name: "paymentType", label: "Payment type", type: "select", value: "Monthly Rent", options: ["Reservation Fee", "Downpayment", "Monthly Rent", "Damage Penalty", "Security Deposit"].map((value) => ({ value, label: value })), help: "Downpayment and monthly rent are separate bills. Security deposit is refundable." },
      { name: "billingFrequency", label: "Billing frequency", type: "select", value: "Monthly", options: ["Daily", "Weekly", "Monthly"].map((value) => ({ value, label: value })) },
      { name: "dueDate", label: "Due date", type: "date", required: true, value: localDateTimeValue().slice(0, 10) },
      { name: "orNumber", label: "OR number (optional)", max: 64 },
      { name: "note", label: "Note (optional)", max: 200 }
    ],
    onSubmit: async (v) => {
      await api("POST", "/api/admin/payments", { accountId: v.accountId, amount: Number(v.amount), status: v.status, paymentType: v.paymentType, billingFrequency: v.billingFrequency, dueDate: v.dueDate, orNumber: v.orNumber, note: v.note });
      toast("Payment recorded.");
      await renderPayments();
    }
  });
}

/* ---------- Announcements ---------- */
async function renderAnnouncements() {
  const { announcements } = await api("GET", "/api/announcements");
  body("announcements").innerHTML = `
    <div class="announcement-actions"><button class="btn btn-primary" type="button" data-add-announcement>${icon("plus")} New announcement</button></div>
    ${announcements.length ? `<div class="list">${announcements.map((a) => `
    <div class="row"><span class="note-icon info">${icon("megaphone")}</span>
      <div class="grow"><strong>${esc(a.title)}</strong><p class="note-body">${esc(a.body)}</p><small>${formatDateTime(a.createdAt)}</small></div>
      <button class="dots" type="button" data-delete-announcement="${a.id}" aria-label="Delete ${esc(a.title)}">⋮</button></div>`).join("")}</div>`
      : emptyBox("No announcements", "Use the New announcement button to post one for your residents.")}`;
}

function announcementForm() {
  openForm({
    title: "New announcement", submitLabel: "Post",
    fields: [
      { name: "title", label: "Title", required: true, max: 100, placeholder: "e.g. Dormitory Announcement" },
      { name: "body", label: "Message", type: "textarea", required: true, max: 1000 },
      { name: "publishedAt", label: "Date & time", type: "datetime-local", required: true, value: localDateTimeValue() }
    ],
    onSubmit: async (v) => {
      const publishedAt = new Date(v.publishedAt).getTime();
      if (!Number.isFinite(publishedAt)) throw new Error("Enter a valid announcement date and time.");
      await api("POST", "/api/admin/announcements", { title: v.title, body: v.body, publishedAt });
      toast("Announcement posted and residents notified.");
      await renderAnnouncements();
    }
  });
}

/* ---------- Reminders ---------- */
const REMINDER_STYLE = { payment: ["alert", ""], curfew: ["info", "info"], event: ["checkCircle", "ok"] };
const REPORT_STATUS_LABELS = { new: "Received", in_progress: "In progress", resolved: "Resolved" };
const REPORT_CATEGORY_LABELS = { maintenance: "Maintenance", safety: "Safety", cleanliness: "Cleanliness", noise: "Noise", other: "Other" };

async function renderReminders() {
  const { reminders } = await api("GET", "/api/reminders");
  body("reminders").innerHTML = reminders.length ? `<div class="list">${reminders.map((r) => {
    const [glyph, tone] = REMINDER_STYLE[r.kind];
    return `<div class="row"><span class="note-icon ${tone}">${icon(glyph)}</span>
      <div class="grow"><strong>${esc(r.title)}</strong>${r.body ? `<p class="note-body">${esc(r.body)}</p>` : ""}<small>${r.dueDate ? `Date: ${formatDate(r.dueDate)}` : formatDate(r.createdAt)}</small></div>
      <button class="dots" type="button" data-delete-reminder="${r.id}" aria-label="Delete ${esc(r.title)}">⋮</button></div>`;
  }).join("")}</div>` : emptyBox("No reminders", "Use the + button to add a payment, curfew or event reminder.");
}

function reminderForm() {
  openForm({
    title: "New reminder", submitLabel: "Add reminder",
    fields: [
      { name: "kind", label: "Type", type: "select", options: [{ value: "payment", label: "Payment reminder" }, { value: "curfew", label: "Curfew reminder" }, { value: "event", label: "Event reminder" }] },
      { name: "title", label: "Title", required: true, max: 100, placeholder: "e.g. Payment Reminder" },
      { name: "body", label: "Message (optional)", type: "textarea", max: 500 },
      { name: "dueDate", label: "Date (optional)", type: "date" }
    ],
    onSubmit: async (v) => { await api("POST", "/api/admin/reminders", { kind: v.kind, title: v.title, body: v.body, dueDate: v.dueDate }); toast("Reminder added and residents notified."); await renderReminders(); }
  });
}

/* ---------- Resident reports ---------- */
async function renderReports() {
  const { reports } = await api("GET", "/api/admin/reports");
  body("reports").innerHTML = reports.length ? `<div class="list">${reports.map((report) => `
    <article class="row report-row">
      <span class="note-icon info">${icon("alert")}</span>
      <div class="grow">
        <strong>${esc(report.title)}</strong>
        <small>${esc(REPORT_CATEGORY_LABELS[report.category])} · ${esc(report.residentName)}${report.roomNumber ? ` · Room ${esc(report.roomNumber)}` : ""}</small>
        <p class="note-body">${esc(report.body)}</p>
        <small>${formatDateTime(report.createdAt)}</small>
      </div>
      <span class="pill ${report.status === "resolved" ? "available" : "pending"}">${esc(REPORT_STATUS_LABELS[report.status])}</span>
    </article>`).join("")}</div>`
    : emptyBox("No resident reports", "Reports sent by residents will appear here.");
}

/* ---------- Visitors ---------- */
async function renderVisitors() {
  const { visitors } = await api("GET", "/api/admin/visitors");
  body("visitors").innerHTML = visitors.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Visitor Name</th><th>Resident</th><th>Date &amp; Time</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${visitors.map((v) => `<tr><td>${esc(v.visitorName)}</td><td>${esc(v.residentName)}</td><td>${esc(formatDateTime(v.visitedAt))}</td>
      <td><span class="pill ${v.status === "pending" ? "pending" : "available"}">${v.status === "pending" ? "Pending approval" : "Logged"}</span></td>
      <td class="actions">${v.status === "pending" ? `<button class="btn outline small" type="button" data-approve-visitor="${v.id}">Approve</button>` : ""}
        <button class="dots" type="button" data-delete-visitor="${v.id}" aria-label="Remove entry for ${esc(v.visitorName)}">×</button></td></tr>`).join("")}</tbody></table></div>`
    : emptyBox("No visitors logged", "Use the + button to record a visitor.");
}

async function visitorForm() {
  await loadResidents();
  if (!state.residents.length) return toast("Add a resident first, then log their visitors.", true);
  openForm({
    title: "Log a visitor", submitLabel: "Add to log",
    fields: [
      { name: "visitorName", label: "Visitor name", required: true, max: 100 },
      { name: "accountId", label: "Visiting resident", type: "select", options: state.residents.map((r) => ({ value: r.id, label: `${r.name}${r.roomNumber ? ` (Room ${r.roomNumber})` : ""}` })) },
      { name: "visitedAt", label: "Date & time", type: "datetime-local", required: true, value: localDateTimeValue() }
    ],
    onSubmit: async (v) => {
      const visitedAt = new Date(v.visitedAt).getTime();
      if (!Number.isFinite(visitedAt)) throw new Error("Enter a valid date and time.");
      await api("POST", "/api/admin/visitors", { visitorName: v.visitorName, accountId: v.accountId, visitedAt });
      toast("Visitor logged.");
      await renderVisitors();
    }
  });
}

/* ---------- Rooms ---------- */
function roomPhoto(room) {
  return room.photoData
    ? `<img src="${esc(room.photoData)}" alt="Photo of room ${esc(room.number)}">`
    : icon("bed");
}

async function renderRooms() {
  const { rooms } = await api("GET", "/api/admin/rooms");
  body("rooms").innerHTML = `<div class="room-management-actions"><button class="btn btn-primary" id="add-room-action" type="button">${icon("plus")} Add room</button></div>${
    rooms.length ? `<div class="room-grid">${rooms.map((r) => `
    <article class="room-card"><div class="room-photo">${roomPhoto(r)}</div>
      <div class="room-body"><h3>Room ${esc(r.number)}</h3>
        <div class="room-meta"><span class="pill info">Capacity: ${r.capacity}</span><span class="pill ${r.status}">${STATUS_LABELS[r.status]}</span><span class="pill available">${r.availableBeds} available beds</span>${r.rent ? `<span class="pill info">${peso(r.rent)}/mo</span>` : ""}</div>
        <div class="room-actions"><button class="btn btn-ghost" type="button" data-room-details="${r.id}">View Details</button>
          <button class="btn btn-primary" type="button" data-room-assign="${r.id}"${r.availableBeds < 1 || r.maintenance ? " disabled" : ""}>Assign Resident</button>
          <button class="btn btn-ghost room-edit" type="button" data-room-edit="${r.id}" aria-label="Edit room ${esc(r.number)}">${icon("info")}</button>
        </div></div></article>`).join("")}</div>`
    : emptyBox("No rooms yet", "Add your first room to start assigning residents.")}`;
  $("add-room-action").addEventListener("click", () => roomForm(null).catch((error) => toast(error.message, true)));
  state.rooms = rooms;
}

async function renderRoomDetails(roomId) {
  state.roomDetailsId = roomId;
  const [{ room, residents }, { payments }] = await Promise.all([
    api("GET", `/api/admin/rooms/${roomId}/residents`),
    api("GET", "/api/admin/payments")
  ]);
  const dlg = getDialog("room-details-dialog");
  dlg.innerHTML = `<div class="dlg room-details-dialog">
    <div class="dlg-head"><div><p class="dashboard-eyebrow">ROOM DETAILS</p><h2>Room ${esc(room.number)}</h2></div>
      <button class="icon-btn" type="button" data-close-room-details aria-label="Close">${icon("close")}</button></div>
    ${residents.length ? `<div class="table-wrap room-residents-table"><table><thead><tr>
      <th>Resident Name</th><th>Contact Info</th><th>Move-in Date</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody>${residents.map((resident) => {
        const unpaid = payments.filter((payment) => payment.accountId === resident.id && ["pending", "overdue"].includes(payment.status));
        const actionOptions = [
          '<option value="">Actions</option>',
          '<option value="transfer">Transfer</option>',
          ...(resident.status === "Active" ? ['<option value="leave">Temporary Leave</option>'] : []),
          ...(resident.status === "On Leave" ? ['<option value="return">Return from Leave</option>'] : []),
          ...(resident.status === "Reserved" ? ['<option value="activate">Mark as Active</option>'] : []),
          '<option value="move-out">Evict / Move Out</option>'
        ].join("");
        return `<tr><td><div class="resident-cell"><strong>${esc(resident.name)}</strong>
          <button class="text-link" type="button" data-quick-pay="${esc(resident.id)}">Log Payment${unpaid.length ? ` (${unpaid.length})` : ""}</button></div></td>
          <td>${esc(resident.contactInfo || "—")}</td><td>${resident.moveInDate ? formatDate(resident.moveInDate) : "Not moved in"}</td>
          <td><span class="pill resident-status">${esc(resident.status)}</span></td>
          <td><label class="sr-only" for="resident-action-${esc(resident.id)}">Actions for ${esc(resident.name)}</label>
            <select class="resident-action-select" id="resident-action-${esc(resident.id)}" data-resident-action="${esc(resident.id)}">${actionOptions}</select></td></tr>`;
      }).join("")}</tbody></table></div>` : emptyBox("No residents assigned", "Assign an unassigned resident to this room.")}
    <div class="room-detail-footer"><span class="muted">${residents.length} assigned · ${Math.max(0, (state.rooms.find((item) => item.id === roomId)?.capacity || residents.length) - residents.length)} beds available</span>
      <button class="btn btn-primary" type="button" data-room-assign="${roomId}">Assign Resident</button></div>
  </div>`;
  dlg.addEventListener("click", closeRoomDialogClick);
  if (!dlg.open) dlg.showModal();
}

function closeRoomDialogClick(event) {
  if (event.target.closest("[data-close-room-details]")) event.currentTarget.close();
}

async function assignResidentForm(roomId) {
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room || room.availableBeds < 1 || room.maintenance) {
    toast("This room has no available beds.", true);
    return;
  }
  const { residents } = await api("GET", "/api/admin/residents/unassigned");
  if (!residents.length) {
    toast("There are no unassigned residents to assign.", true);
    return;
  }
  const searchOptions = (search, form) => {
    const select = form.elements.residentId;
    const query = search.trim().toLowerCase();
    const previous = select.value;
    const filtered = residents.filter((resident) =>
      `${resident.name} ${resident.username}`.toLowerCase().includes(query));
    select.innerHTML = filtered.map((resident) =>
      `<option value="${esc(resident.id)}">${esc(resident.name)} · ${esc(resident.username)}</option>`).join("");
    if (filtered.some((resident) => resident.id === previous)) select.value = previous;
  };
  const form = openForm({
    title: `Assign resident · Room ${room.number}`,
    intro: "Choose an unassigned resident. Reservation-only assignments create a pending fee equal to the room’s monthly rent, due today.",
    submitLabel: "Assign bed",
    fields: [
      { name: "residentSearch", label: "Search residents", type: "search", placeholder: "Name or student ID", onInput: searchOptions },
      { name: "residentId", label: "Resident", type: "select", required: true, options: residents.map((resident) => ({
        value: resident.id, label: `${resident.name} · ${resident.username}`
      })) },
      { name: "reservationOnly", label: "Reservation only", type: "checkbox", help: `Reserve a bed without marking move-in. Reservation fee: ${peso(room.rent)}.` }
    ],
    onSubmit: async (values) => {
      await api("POST", `/api/admin/rooms/${roomId}/assign`, {
        residentId: values.residentId,
        reservationOnly: values.reservationOnly === "true"
      });
      toast(values.reservationOnly === "true" ? "Bed reserved and reservation fee invoiced." : "Resident assigned.");
      await renderRooms();
      window.setTimeout(() => renderRoomDetails(roomId).catch((error) => toast(error.message, true)), 0);
    }
  });
  if (form) searchOptions("", form);
}

async function transferResidentForm(resident) {
  const { rooms } = await api("GET", "/api/admin/rooms");
  const availableRooms = rooms.filter((room) => room.id !== resident.roomId && room.availableBeds > 0 && !room.maintenance);
  if (!availableRooms.length) {
    toast("There are no other rooms with available beds.", true);
    return;
  }
  openForm({
    title: `Transfer ${resident.name}`,
    submitLabel: "Transfer resident",
    fields: [{ name: "roomId", label: "New room", type: "select", required: true, options: availableRooms.map((room) => ({
      value: room.id, label: `Room ${room.number} · ${room.availableBeds} bed${room.availableBeds === 1 ? "" : "s"} available`
    })) }],
    onSubmit: async (values) => {
      await api("POST", `/api/admin/residents/${resident.id}/transfer`, { roomId: values.roomId });
      toast(`${resident.name} transferred.`);
      await renderRooms();
      window.setTimeout(() => renderRoomDetails(Number(values.roomId)).catch((error) => toast(error.message, true)), 0);
    }
  });
}

async function quickPaymentForm(residentId) {
  const { payments } = await api("GET", "/api/admin/payments");
  const unpaid = payments.filter((payment) => payment.accountId === residentId && ["pending", "overdue"].includes(payment.status));
  if (!unpaid.length) {
    toast("This resident has no unpaid invoices.");
    return;
  }
  openForm({
    title: "Log Payment",
    intro: "Mark an outstanding invoice as paid.",
    submitLabel: "Mark as paid",
    fields: [{ name: "paymentId", label: "Invoice", type: "select", required: true, options: unpaid.map((payment) => ({
      value: payment.id,
      label: `${payment.paymentType} · ${peso(payment.amount)} · Due ${formatDate(payment.dueDate)} (${STATUS_LABELS[payment.status]})`
    })) }],
    onSubmit: async (values) => {
      await api("PATCH", `/api/admin/payments/${values.paymentId}`, { status: "paid" });
      toast("Payment recorded.");
      await renderRoomDetails(Number(state.roomDetailsId));
      await renderRooms();
    }
  });
}

async function runResidentAction(residentId, action) {
  const roomId = state.roomDetailsId;
  const { residents } = await api("GET", `/api/admin/rooms/${roomId}/residents`);
  const resident = residents.find((item) => item.id === residentId);
  if (!resident) throw new Error("Resident is no longer assigned to this room.");
  if (action === "transfer") return transferResidentForm(resident);
  if (action === "leave" || action === "return" || action === "activate") {
    await api("PATCH", `/api/admin/residents/${residentId}/status`, { status: action === "leave" ? "On Leave" : "Active" });
    toast(action === "leave" ? `${resident.name} marked On Leave.` : `${resident.name} is Active.`);
  } else if (action === "move-out") {
    if (!(await confirmAction(`Move ${resident.name} out of the dormitory? Unpaid payments must be cleared first.`, "Move Out"))) return;
    await api("POST", `/api/admin/residents/${residentId}/move-out`, {});
    toast(`${resident.name} moved out.`);
  }
  await renderRooms();
  await renderRoomDetails(roomId);
}

function readRoomPhoto(file) {
  if (!file) return Promise.resolve(undefined);
  if (file.size > 1024 * 1024) return Promise.reject(new Error("Room photos must be 1 MB or smaller."));
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    return Promise.reject(new Error("Choose a PNG, JPEG or WebP room photo."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Could not read the selected room photo.")));
    reader.readAsDataURL(file);
  });
}

function roomForm(room) {
  const editing = Boolean(room);
  openForm({
    title: editing ? `Room ${room.number}` : "Add room",
    intro: editing ? (room.occupants.length ? `Residents: ${room.occupants.map((o) => o.name).join(", ")}` : "No residents assigned yet.") : "",
    submitLabel: editing ? "Save changes" : "Add room",
    fields: [
      { name: "number", label: "Room number", required: true, max: 20, value: room?.number, placeholder: "e.g. 101" },
      { name: "capacity", label: "Capacity (beds)", type: "number", min: 1, max: 20, required: true, value: room?.capacity ?? 1 },
      { name: "rent", label: "Monthly rent (₱)", type: "number", min: 0, required: true, value: room?.rent ?? 0 },
      { name: "status", label: "Status", type: "select", value: room?.maintenance ? "maintenance" : "available", options: [{ value: "available", label: "In service" }, { value: "maintenance", label: "Under maintenance" }] },
      { name: "notes", label: "Notes (optional)", max: 200, value: room?.notes },
      { name: "photo", label: "Room photo (optional)", type: "file", accept: "image/png,image/jpeg,image/webp", help: `${room?.photoData ? "Choose a new photo to replace the current one. " : ""}PNG, JPEG or WebP, up to 1 MB.` },
      ...(room?.photoData ? [{ name: "photoAction", label: "Current photo", type: "select", options: [{ value: "keep", label: "Keep current photo" }, { value: "remove", label: "Remove photo" }] }] : [])
    ],
    onSubmit: async (v) => {
      const payload = { number: v.number, capacity: Number(v.capacity), rent: Number(v.rent), status: v.status, notes: v.notes };
      if (v.photo.size) payload.photoData = await readRoomPhoto(v.photo);
      else if (v.photoAction === "remove") payload.photoData = "";
      if (editing) await api("PATCH", `/api/admin/rooms/${room.id}`, payload);
      else await api("POST", "/api/admin/rooms", payload);
      toast(editing ? "Room updated." : "Room added.");
      await renderRooms();
    },
    onDelete: editing ? async () => { await api("DELETE", `/api/admin/rooms/${room.id}`); toast("Room deleted."); await renderRooms(); } : undefined
  });
}

async function renderNotifications() {
  const { notifications, unreadCount } = await api("GET", "/api/admin/notifications");
  state.unreadNotifications = unreadCount;
  updateNotificationBadge();
  body("notifications").innerHTML = notifications.length ? `<div class="list">${notifications.map((n) => `
    <div class="row notification-row${n.readAt ? "" : " unread"}">
      <span class="note-icon info">${icon("bell")}</span>
      <div class="grow"><strong>${esc(n.title)}</strong><p class="note-body">${esc(n.body)}</p><small>${formatDateTime(n.createdAt)}${n.readAt ? "" : " · Unread"}</small></div>
      <button class="btn outline small" type="button" data-go="visitors">Visitor log</button>
      ${n.readAt ? "" : `<button class="dots" type="button" data-read-notification="${n.id}" aria-label="Mark notification as read">✓</button>`}
    </div>`).join("")}</div>` : emptyBox("No notifications", "New resident visitor-log submissions will appear here.");
}

async function refreshNotificationBadge() {
  const { unreadCount } = await api("GET", "/api/admin/notifications");
  state.unreadNotifications = unreadCount;
  updateNotificationBadge();
}

function updateNotificationBadge() {
  ["notification-count", "desktop-notification-count"].forEach((id) => {
    const badge = $(id);
    if (!badge) return;
    badge.hidden = state.unreadNotifications < 1;
    badge.textContent = state.unreadNotifications > 99 ? "99+" : String(state.unreadNotifications);
    badge.setAttribute("aria-label", `${state.unreadNotifications} unread notifications`);
  });
}

/* ---------- Curfew ---------- */
async function renderCurfew() {
  const c = await api("GET", "/api/admin/curfew");
  body("curfew").innerHTML = `
    <div class="card"><div class="row"><span class="note-icon">${icon("clock")}</span>
      <div class="grow"><strong>Curfew time: ${formatClock(c.curfewTime)}</strong><small>Residents should be inside the dormitory by this time.</small></div>
      <button class="btn outline small" type="button" data-curfew-time="${c.curfewTime}">Change</button></div></div>
    <div class="card"><strong>Curfew policy</strong><p class="note-body">Residents do not need to submit a check-in. This page only displays the dormitory curfew time.</p></div>`;
}

function curfewTimeForm(current) {
  openForm({
    title: "Curfew time", submitLabel: "Save",
    fields: [{ name: "curfewTime", label: "Residents must be inside by", type: "time", required: true, value: current }],
    onSubmit: async (v) => { await api("PATCH", "/api/admin/curfew", { curfewTime: v.curfewTime }); toast("Curfew time updated."); await renderCurfew(); }
  });
}

/* ---------- More ---------- */
function renderMore() {
  const me = state.me;
  body("more").innerHTML = `
    <div class="card"><div class="row">${avatar(me.name)}<div class="grow"><strong>${esc(me.name)}</strong><small>Signed in as ${esc(me.username)} · Administrator</small></div></div></div>
    <h2 class="section-title">Management</h2>
    ${moduleGroups()}
    <button class="btn btn-danger btn-block" type="button" id="signout">${icon("logout")} Sign out</button>`;
}

/* ---------- Routing ---------- */
const views = {
  home: renderHome, residents: renderResidents, "admin-accounts": renderAdminAccounts, payments: renderPayments, announcements: renderAnnouncements,
  reminders: renderReminders, visitors: renderVisitors, notifications: renderNotifications, reports: renderReports,
  rooms: renderRooms, curfew: renderCurfew, more: renderMore
};
let routeToken = 0;

async function route() {
  const name = Object.hasOwn(views, location.hash.slice(1)) ? location.hash.slice(1) : "home";
  const token = ++routeToken;
  document.querySelectorAll(".page").forEach((page) => { page.hidden = page.id !== `view-${name}`; });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    const active = btn.dataset.go === name || (btn.dataset.go === "more" && !BOTTOM_TABS.includes(name));
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-sidebar-link]").forEach((btn) => {
    const active = btn.dataset.go === name || (btn.dataset.go === "more" && !BOTTOM_TABS.includes(name));
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
  try {
    await views[name]();
    if (name !== "notifications") await refreshNotificationBadge();
  } catch (error) {
    if (token === routeToken) toast(error.message, true);
  }
}

function go(name) {
  if (location.hash === `#${name}` || (name === "home" && !location.hash)) route();
  else location.hash = name;
}

async function signOut() {
  try {
    await api("POST", "/api/auth/logout", {});
    window.location.assign(appUrl("login.html"));
  } catch (error) {
    toast(error.message, true);
  }
}

document.addEventListener("click", async (event) => {
  const t = event.target;
  const act = async (fn) => { try { await fn(); } catch (error) { toast(error.message, true); } };
  const navigate = t.closest("[data-go]");
  if (navigate) return go(navigate.dataset.go);
  if (t.closest("[data-add-announcement]")) return act(() => announcementForm());
  if (t.closest("#signout")) return signOut();

  const approveVisitor = t.closest("[data-approve-visitor]");
  if (approveVisitor) return act(async () => {
    await api("POST", `/api/admin/visitors/${approveVisitor.dataset.approveVisitor}/approve`, {});
    toast("Visitor approved.");
    await renderHome();
    await refreshNotificationBadge();
  });

  const roomDetails = t.closest("[data-room-details]");
  if (roomDetails) return act(() => renderRoomDetails(Number(roomDetails.dataset.roomDetails)));
  const assignRoom = t.closest("[data-room-assign]");
  if (assignRoom) return act(() => assignResidentForm(Number(assignRoom.dataset.roomAssign)));
  const editRoom = t.closest("[data-room-edit]");
  if (editRoom) return act(() => roomForm(state.rooms.find((room) => room.id === Number(editRoom.dataset.roomEdit))));
  const quickPay = t.closest("[data-quick-pay]");
  if (quickPay) return act(() => quickPaymentForm(quickPay.dataset.quickPay));

  const adminAccount = t.closest("[data-admin-account]");
  if (adminAccount) {
    const record = state.adminAccounts.find((account) => account.id === adminAccount.dataset.adminAccount);
    if (record) return act(() => adminAccountForm(record));
  }
  const edit = t.closest("[data-edit]");
  if (edit) {
    return act(() => residentForm(state.residents.find((r) => r.id === edit.dataset.edit)));
  }
  const remove = t.closest("[data-remove]");
  if (remove) {
    const r = state.residents.find((x) => x.id === remove.dataset.remove);
    if (r && await confirmAction(`Remove ${r.name}? Their account, payments, visitors and curfew records will be deleted.`, "Remove")) {
      return act(async () => { await api("DELETE", `/api/admin/residents/${r.id}`); toast("Resident removed."); await renderResidents(); });
    }
    return;
  }
  const paymentPage = t.closest("[data-payment-page]");
  if (paymentPage) {
    state.paymentPage += Number(paymentPage.dataset.paymentPage);
    return drawPayments();
  }
  const verifyPayment = t.closest("[data-verify-payment]");
  if (verifyPayment) {
    const payment = state.payments.find((item) => String(item.id) === verifyPayment.dataset.verifyPayment);
    if (payment) return act(() => openPaymentVerification(payment));
  }
  const pay = t.closest("[data-payment]");
  if (pay) return act(() => paymentForm(state.payments.find((p) => String(p.id) === pay.dataset.payment)));
  const room = t.closest("[data-room]");
  if (room) return roomForm(state.rooms.find((r) => String(r.id) === room.dataset.room));
  const deleters = [
    ["data-delete-announcement", "announcements", "Delete this announcement?", renderAnnouncements],
    ["data-delete-reminder", "reminders", "Delete this reminder?", renderReminders],
    ["data-delete-visitor", "visitors", "Remove this visitor entry?", renderVisitors]
  ];
  for (const [attr, path, message, refresh] of deleters) {
    const button = t.closest(`[${attr}]`);
    if (button) {
      if (await confirmAction(message)) await act(async () => { await api("DELETE", `/api/admin/${path}/${button.getAttribute(attr)}`); toast("Deleted."); await refresh(); });
      return;
    }
  }
  const timeBtn = t.closest("[data-curfew-time]");
  if (timeBtn) return curfewTimeForm(timeBtn.dataset.curfewTime);
  const readNotification = t.closest("[data-read-notification]");
  if (readNotification) return act(async () => {
    await api("PATCH", `/api/admin/notifications/${readNotification.dataset.readNotification}`, {});
    await renderNotifications();
  });

});

document.addEventListener("change", async (event) => {
  const action = event.target.closest("[data-resident-action]");
  if (!action || !action.value) return;
  const residentId = action.dataset.residentAction;
  const selectedAction = action.value;
  action.value = "";
  try {
    await runResidentAction(residentId, selectedAction);
  } catch (error) {
    toast(error.message, true);
  }
});

const addActions = {
  "add-admin-account": adminAccountForm,
  "add-payments": () => paymentForm(null), "add-announcements": announcementForm,
  "add-reminders": reminderForm, "add-visitors": visitorForm
};
for (const [id, handler] of Object.entries(addActions)) {
  $(id).addEventListener("click", async () => { try { await handler(); } catch (error) { toast(error.message, true); } });
}

window.addEventListener("hashchange", route);

(async function start() {
  $("year").textContent = String(new Date().getFullYear());
  try {
    const { user } = await api("GET", "/api/auth/me");
    if (user.role !== "admin") return window.location.replace(appUrl("resident.html"));
    state.me = user;
    $("desktop-user-name").textContent = user.name;
    $("desktop-user-meta").textContent = user.username;
    $("desktop-header-name").textContent = user.name;
    $("desktop-user-avatar").textContent = initials(user.name);
    $("desktop-header-avatar").textContent = initials(user.name);
  } catch (error) {
    if (error.message.includes("sign in")) return;
    toast(error.message, true);
    return;
  }
  route();
  window.setInterval(() => {
    refreshNotificationBadge().catch((error) => toast(error.message, true));
  }, 30000);
})();
