/* Resident portal */
const MODULES = [
  { go: "room", icon: "bed", label: "My Room" },
  { go: "payments", icon: "wallet", label: "My Payments" },
  { go: "visitors", icon: "card", label: "My Visitors" },
  { go: "announcements", icon: "megaphone", label: "Announcements" },
  { go: "reminders", icon: "bell", label: "Reminders" },
  { go: "reports", icon: "alert", label: "Report a problem" },
  { go: "curfew", icon: "clock", label: "Curfew Schedule" }
];
const BOTTOM_TABS = ["home", "announcements", "reminders"];
const state = { overview: null };
const $ = (id) => document.getElementById(id);
const body = (name) => $(`body-${name}`);
const emptyBox = (title, text) => `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;
const moduleButton = (m) => `<button class="module" type="button" data-go="${m.go}">${icon(m.icon)}<span>${esc(m.label)}</span></button>`;
const REMINDER_STYLE = { payment: ["alert", ""], curfew: ["info", "info"], event: ["checkCircle", "ok"] };

async function loadOverview() {
  state.overview = await api("GET", "/api/me/overview");
  return state.overview;
}

/* ---------- Home ---------- */
async function renderHome() {
  const o = await loadOverview();
  const first = o.user.name.trim().split(/\s+/)[0];
  const next = o.nextPayment;
  const [{ announcements }, { reminders }] = await Promise.all([api("GET", "/api/announcements"), api("GET", "/api/reminders")]);
  body("home").innerHTML = `
    <div><h2>Welcome, ${esc(first)}</h2><p class="muted">Here's your residence at a glance.</p></div>
    <div class="tile-grid">
      <div class="tile">${icon("bed")}<strong class="text">${o.room ? `Room ${esc(o.room.number)}` : "Pending"}</strong><span class="label">${o.room ? (o.room.maintenance ? "Under maintenance" : "Your room") : "Room not assigned yet"}</span></div>
      <div class="tile teal">${icon("wallet")}<strong class="text">${next ? peso(next.amount) : "All paid"}</strong><span class="label">${next ? `Due ${formatDate(next.dueDate)}` : "No payments due"}</span></div>
      <div class="tile teal">${icon("clock")}<strong class="text">Curfew ${formatClock(o.curfew.curfewTime)}</strong><span class="label">Please be inside by this time</span></div>
      <div class="tile">${icon("card")}<strong>${o.visitors.length}</strong><span class="label">Visitors logged</span></div>
    </div>
    <h2 class="section-title">Latest announcement</h2>
    ${announcements[0] ? `<div class="card"><strong>${esc(announcements[0].title)}</strong><p class="note-body">${esc(announcements[0].body)}</p><small class="muted">${formatDateTime(announcements[0].createdAt)}</small></div>`
      : emptyBox("You're all caught up", "There are no announcements right now.")}
    ${reminders.length ? `<h2 class="section-title">Reminders</h2><div class="list">${reminders.slice(0, 3).map(reminderRow).join("")}</div>` : ""}
    <h2 class="section-title">Quick links</h2>
    <div class="module-grid">${MODULES.map(moduleButton).join("")}</div>`;
}

/* ---------- Room ---------- */
async function renderRoom() {
  const { room } = await loadOverview();
  body("room").innerHTML = room ? `
    <div class="room-card"><div class="room-photo">${room.photoData
      ? `<img src="${esc(room.photoData)}" alt="Photo of room ${esc(room.number)}">`
      : icon("bed")}</div><div class="room-body">
      <h3>Room ${esc(room.number)}</h3>
      <div class="room-meta"><span class="pill info">Capacity: ${room.capacity}</span><span class="pill ${room.maintenance ? "maintenance" : "occupied"}">${room.maintenance ? "Under maintenance" : "Occupied"}</span></div></div></div>
    <div class="card">
      <div class="stat-line"><span>Monthly rent</span><strong>${room.rent ? peso(room.rent) : "Not set"}</strong></div>
      <div class="stat-line"><span>Roommates</span><strong>${room.roommates.length ? esc(room.roommates.join(", ")) : "None"}</strong></div>
      ${room.notes ? `<div class="stat-line"><span>Notes</span><strong>${esc(room.notes)}</strong></div>` : ""}
    </div>`
    : `<div class="status-hero card"><div class="big none">${icon("bed")}</div><h2>Waiting for a room</h2><p class="muted">Your room will appear here once the residence team assigns one to your account.</p><span class="pill pending">Pending assignment</span></div>`;
}

/* ---------- Payments ---------- */
async function renderPayments() {
  const o = await loadOverview();
  const outstandingPayments = o.payments.filter((payment) => payment.status !== "paid");
  const outstandingBalance = outstandingPayments.reduce((total, payment) => total + payment.amount, 0);
  const payments = [...o.payments].sort((a, b) => {
    if (a.status === "paid" && b.status !== "paid") return 1;
    if (a.status !== "paid" && b.status === "paid") return -1;
    return String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
  });
  const hasDeposit = payments.some((payment) => payment.isSecurityDeposit);
  const allUnpaidMonthly = payments.filter((payment) => payment.paymentType === "Monthly Rent" && payment.status !== "paid");
  const monthlyBills = allUnpaidMonthly.filter((payment) => payment.verificationStatus !== "pending");
  const currentMonth = new Date().toISOString().slice(0, 7);
  const existingAdvance = payments
    .filter((payment) => payment.paymentType === "Monthly Rent" && payment.dueDate?.slice(0, 7) > currentMonth && payment.status !== "paid")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const canSubmitPayment = monthlyBills.length > 0 || !allUnpaidMonthly.length ||
    !existingAdvance || existingAdvance.verificationStatus !== "pending" || !hasDeposit;
  body("payments").innerHTML = `
    <section class="resident-payment-actions" aria-label="Payment options">
      <article class="card resident-payment-action">
        <div><h3>Make a payment</h3><p>${canSubmitPayment
          ? "Submit your monthly rent, advance rent, or security deposit with one form."
          : "Your payment proofs are awaiting review. You can update them from payment history below."}</p></div>
        <button class="btn btn-primary" type="button" id="start-payment"${canSubmitPayment ? "" : " disabled"}>Submit payment</button>
      </article>
    </section>
    <div class="resident-payment-summary">
      <article class="card payment-summary-card${outstandingBalance ? " has-balance" : ""}">
        <span class="payment-summary-label">Outstanding balance</span>
        <strong>${outstandingBalance ? peso(outstandingBalance) : "All caught up"}</strong>
        <small>${outstandingPayments.length ? `${outstandingPayments.length} unpaid ${outstandingPayments.length === 1 ? "bill" : "bills"}` : "No payments due"}</small>
      </article>
      <article class="card payment-summary-card">
        <span class="payment-summary-label">Total paid</span>
        <strong>${peso(o.totalPaid)}</strong>
        <small>Verified payments</small>
      </article>
    </div>
    <div class="payment-history-heading"><div><h2>Payment history</h2><p class="payment-history-note">Review your bills and payment proof status.</p></div><span class="pill info">${o.payments.length} ${o.payments.length === 1 ? "bill" : "bills"}</span></div>
    ${payments.length ? `<div class="resident-payment-list">${payments.map((p) => {
      const awaitingVerification = p.status !== "paid" && p.verificationStatus === "pending";
      const rejected = p.status !== "paid" && p.verificationStatus === "rejected";
      return `<article class="card payment-bill ${p.status}">
        <div class="payment-bill-heading"><div><span class="payment-bill-type">${esc(p.paymentType || "Payment")}</span><h3>${esc(p.note || p.paymentType || "Payment bill")}</h3></div><span class="pill ${p.status}">${STATUS_LABELS[p.status]}</span></div>
        <strong class="payment-bill-amount">${peso(p.amount)}</strong>
        <div class="payment-bill-details">
          <div><span>${p.status === "paid" ? "Paid on" : "Due date"}</span><strong>${formatDate(p.status === "paid" ? p.paidDate : p.dueDate) || "Not set"}</strong></div>
          <div><span>OR number</span><strong>${esc(p.orNumber || "—")}</strong></div>
        </div>
        ${awaitingVerification ? `<div class="payment-proof-awaiting"><p class="payment-proof-status">Submitted · Awaiting administrator approval</p><button class="btn outline small" type="button" data-edit-payment-or="${p.id}">Edit submission</button></div>` : ""}
        ${rejected ? '<p class="payment-proof-status rejected">OR rejected. Please resubmit your proof.</p>' : ""}
        ${p.status !== "paid" && !awaitingVerification ? `<button class="btn btn-primary payment-proof-button" type="button" data-submit-payment-or="${p.id}">${rejected ? "Resubmit payment proof" : "Submit payment proof"}</button>` : ""}
      </article>`;
    }).join("")}</div>`
      : emptyBox("No payment history yet", "Monthly rent bills will appear automatically once your move-in day arrives.")}`;
}

function readPaymentProof(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the selected image."));
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function validatePaymentProof(file) {
  if (file && file.size > 1024 * 1024) throw new Error("Receipt image must be 1 MB or smaller.");
  if (file && file.size && !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG or WebP image.");
  }
}

function addPaymentProofPreview(form) {
  const fileInput = form.elements.orImage;
  const preview = document.createElement("div");
  preview.className = "payment-proof-preview";
  preview.hidden = true;
  const image = document.createElement("img");
  image.alt = "Selected payment proof";
  const fileName = document.createElement("small");
  preview.append(image, fileName);
  fileInput.closest(".field").append(preview);
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      preview.hidden = true;
      image.removeAttribute("src");
      fileName.textContent = "";
      return;
    }
    try {
      validatePaymentProof(file);
      image.src = await readPaymentProof(file);
      fileName.textContent = file.name;
      preview.hidden = false;
    } catch (error) {
      toast(error.message, true);
      fileInput.value = "";
      preview.hidden = true;
    }
  });
}

function submitPaymentOr(payment, editing = false) {
  const form = openForm({
    title: editing ? "Edit submitted proof" : "Send payment proof",
    intro: editing
      ? "Correct the OR number or replace the receipt while the administrator is reviewing it. The bill stays due until approval."
      : "Enter the amount you are paying, OR number and optional receipt. The balance is updated only after administrator approval.",
    submitLabel: editing ? "Save changes" : "Send proof",
    fields: [
      { name: "submittedAmount", label: "Amount to pay (₱)", type: "number", min: 1, max: payment.amount, required: true, value: editing ? payment.submittedAmount || payment.amount : payment.amount, help: `Remaining bill: ${peso(payment.amount)}. Partial payment is allowed.` },
      { name: "orNumber", label: "OR number", required: true, max: 64, value: payment.orNumber, autocomplete: "off" },
      { name: "orImage", label: editing ? "Replace receipt image (optional)" : "Insert receipt image (optional)", type: "file", accept: "image/png,image/jpeg,image/webp", help: editing ? `${payment.hasOrImage ? "A receipt is already attached. " : ""}Leave empty to keep the current receipt. PNG, JPEG or WebP; maximum size: 1 MB.` : "PNG, JPEG or WebP; maximum size: 1 MB." }
    ],
    onSubmit: async (values) => {
      const file = values.orImage;
      validatePaymentProof(file);
      const payload = { orNumber: values.orNumber, submittedAmount: Number(values.submittedAmount) };
      if (file && file.size) payload.orImageData = await readPaymentProof(file);
      else if (!editing) payload.orImageData = "";
      await api(editing ? "PATCH" : "POST", `/api/me/payments/${payment.id}/or`, payload);
      toast(editing ? "Payment proof updated." : "Payment proof sent for administrator verification.");
      await renderPayments();
    }
  });
  addPaymentProofPreview(form);
}

function residentPaymentForm() {
  const overview = state.overview;
  const allUnpaidMonthly = overview.payments.filter((payment) =>
    payment.paymentType === "Monthly Rent" && payment.status !== "paid");
  const monthlyBills = allUnpaidMonthly.filter((payment) => payment.verificationStatus !== "pending");
  const currentMonth = new Date().toISOString().slice(0, 7);
  const existingAdvance = overview.payments
    .filter((payment) => payment.paymentType === "Monthly Rent" && payment.dueDate?.slice(0, 7) > currentMonth && payment.status !== "paid")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const hasDeposit = overview.payments.some((payment) => payment.isSecurityDeposit);
  const rent = state.overview.room?.rent || 0;
  const advanceAvailable = !existingAdvance || existingAdvance.verificationStatus !== "pending";
  const paymentTypes = [];
  if (monthlyBills.length || !allUnpaidMonthly.length) paymentTypes.push({ value: "monthly", label: "Monthly payment" });
  if (advanceAvailable) paymentTypes.push({ value: "advance", label: "Advance payment" });
  if (!hasDeposit) paymentTypes.push({ value: "deposit", label: "Security deposit" });
  const selectedType = paymentTypes[0]?.value || "";
  const initialBill = monthlyBills[0];
  const maxAmount = existingAdvance?.amount || rent || 100000000;
  const form = openForm({
    title: "Submit payment",
    intro: "Choose the payment type, then enter your OR number and attach the receipt if available.",
    submitLabel: "Submit payment",
    fields: [
      {
        name: "paymentType", label: "Payment type", type: "select", required: true, value: selectedType,
        options: paymentTypes,
        onChange: (value, currentForm) => updateResidentPaymentFields(value, currentForm, monthlyBills, initialBill, rent, existingAdvance)
      },
      {
        name: "paymentId", label: "Monthly bill", type: "select", required: true, value: initialBill?.id,
        options: monthlyBills.map((payment) => ({
          value: payment.id,
          label: `${peso(payment.amount)} · Due ${formatDate(payment.dueDate) || "Not set"}`
        })),
        onChange: (value, currentForm) => {
          const payment = monthlyBills.find((item) => String(item.id) === String(value));
          if (payment) setResidentPaymentAmount(currentForm, payment.amount, `Remaining bill: ${peso(payment.amount)}. Partial payment is allowed.`);
        }
      },
      {
        name: "amount", label: "Amount (₱)", type: "number", min: 1,
        max: initialBill?.amount || 100000000, required: true,
        value: initialBill?.amount || (selectedType === "advance" && rent ? maxAmount : ""),
        help: initialBill ? `Remaining bill: ${peso(initialBill.amount)}. Partial payment is allowed.` : "Enter the amount to pay."
      },
      { name: "orNumber", label: "OR number", required: true, max: 64, autocomplete: "off" },
      { name: "orImage", label: "Receipt image (optional)", type: "file", accept: "image/png,image/jpeg,image/webp", help: "PNG, JPEG or WebP; maximum size: 1 MB." }
    ],
    onSubmit: async (values) => {
      const file = values.orImage;
      validatePaymentProof(file);
      const amount = Number(values.amount);
      const payload = { orNumber: values.orNumber, orImageData: "" };
      if (file && file.size) payload.orImageData = await readPaymentProof(file);
      if (values.paymentType === "monthly" && monthlyBills.length) {
        const payment = monthlyBills.find((item) => String(item.id) === values.paymentId);
        if (!payment) throw new Error("Choose a valid monthly bill.");
        await api("POST", `/api/me/payments/${payment.id}/or`, { ...payload, submittedAmount: amount });
      } else if (values.paymentType === "monthly") {
        await api("POST", "/api/me/payments/monthly", { ...payload, amount });
      } else if (values.paymentType === "advance") {
        const result = await api("POST", "/api/me/payments/advance", { amount });
        const payment = result.payment;
        if (payment.status === "paid") throw new Error("This advance rent bill has already been paid.");
        if (payment.verificationStatus === "pending") throw new Error("This advance rent payment is already awaiting administrator verification. You can edit it from payment history.");
        if (amount > payment.amount) throw new Error(`Amount to pay cannot exceed the remaining bill of ${peso(payment.amount)}.`);
        await api("POST", `/api/me/payments/${payment.id}/or`, { ...payload, submittedAmount: amount });
      } else if (values.paymentType === "deposit") {
        await api("POST", "/api/me/payments/deposit", { ...payload, amount });
      } else {
        throw new Error("Choose a valid payment type.");
      }
      toast("Payment submitted for administrator verification.");
      await renderPayments();
    }
  });
  updateResidentPaymentFields(selectedType, form, monthlyBills, initialBill, rent, existingAdvance);
  addPaymentProofPreview(form);
}

function setResidentPaymentAmount(form, max, help) {
  const amount = form.elements.amount;
  amount.max = max;
  amount.value = max;
  let helpText = amount.closest(".field").querySelector("small");
  if (!helpText) {
    helpText = document.createElement("small");
    amount.closest(".field").append(helpText);
  }
  helpText.textContent = help;
}

function updateResidentPaymentFields(type, form, monthlyBills, initialBill, rent, existingAdvance) {
  const billField = form.elements.paymentId.closest(".field");
  const amountField = form.elements.amount.closest(".field");
  const amountLabel = amountField.querySelector("span");
  const amountHelp = amountField.querySelector("small");
  const amount = form.elements.amount;
  billField.hidden = type !== "monthly" || !monthlyBills.length;
  form.elements.paymentId.required = type === "monthly" && monthlyBills.length > 0;
  amountLabel.textContent = type === "deposit" ? "Deposit amount (₱)" : type === "advance" ? "Advance payment amount (₱)" : "Monthly payment amount (₱)";
  if (type === "monthly" && initialBill && monthlyBills.length) {
    const selected = monthlyBills.find((payment) => String(payment.id) === form.elements.paymentId.value) || initialBill;
    setResidentPaymentAmount(form, selected.amount, `Remaining bill: ${peso(selected.amount)}. Partial payment is allowed.`);
  } else if (type === "advance") {
    const max = existingAdvance?.amount || rent || 100000000;
    amount.max = max;
    amount.value = rent ? max : "";
    amountHelp.textContent = rent
      ? `Next advance rent bill: ${peso(max)}. Partial payment is allowed.`
      : "No room rent is set. Enter the amount to pay in advance.";
  } else {
    amount.max = 100000000;
    amount.value = "";
    amountHelp.textContent = type === "deposit"
      ? "Enter the security deposit amount."
      : "Enter the monthly rent amount you paid.";
  }
}

/* ---------- Announcements & reminders ---------- */
async function renderAnnouncements() {
  const { announcements } = await api("GET", "/api/announcements");
  body("announcements").innerHTML = announcements.length ? `<div class="list">${announcements.map((a) => `
    <div class="row"><span class="note-icon info">${icon("megaphone")}</span>
      <div class="grow"><strong>${esc(a.title)}</strong><p class="note-body">${esc(a.body)}</p><small>${formatDateTime(a.createdAt)}</small></div></div>`).join("")}</div>`
    : emptyBox("You're all caught up", "There are no announcements right now. New updates will show up here.");
}

function reminderRow(r) {
  const [glyph, tone] = REMINDER_STYLE[r.kind];
  return `<div class="row"><span class="note-icon ${tone}">${icon(glyph)}</span>
    <div class="grow"><strong>${esc(r.title)}</strong>${r.body ? `<p class="note-body">${esc(r.body)}</p>` : ""}<small>${r.dueDate ? `Date: ${formatDate(r.dueDate)}` : formatDate(r.createdAt)}</small></div></div>`;
}

async function renderReminders() {
  const { reminders } = await api("GET", "/api/reminders");
  body("reminders").innerHTML = reminders.length ? `<div class="list">${reminders.map(reminderRow).join("")}</div>` : emptyBox("No reminders", "Payment, curfew and event reminders will show up here.");
}

/* ---------- Reports ---------- */
const REPORT_STATUS_LABELS = { new: "Received", in_progress: "In progress", resolved: "Resolved" };
const REPORT_CATEGORY_LABELS = { maintenance: "Maintenance", safety: "Safety", cleanliness: "Cleanliness", noise: "Noise", other: "Other" };

async function renderReports() {
  const { reports } = await api("GET", "/api/me/reports");
  body("reports").innerHTML = `
    <div class="card">
      <h2>Tell the admin about a problem</h2>
      <p class="muted">Send a report remotely. You can choose whether to include your name.</p>
      <button class="btn btn-primary btn-block report-start" type="button" id="start-resident-report">${icon("plus")} New report</button>
    </div>
    ${reports.length ? `<h2 class="section-title">Your reports</h2><div class="list">${reports.map((report) => `
      <div class="row"><span class="note-icon info">${icon("alert")}</span>
        <div class="grow"><strong>${esc(report.title)}</strong><small>${esc(REPORT_CATEGORY_LABELS[report.category])} · ${esc(REPORT_STATUS_LABELS[report.status])}</small>
          <p class="note-body">${esc(report.body)}</p><small>${formatDateTime(report.createdAt)}</small></div></div>`).join("")}</div>`
      : emptyBox("No named reports yet", "Reports sent anonymously are not linked to your account and won't appear here.")}`;
}

function residentReportForm() {
  openForm({
    title: "Report a problem",
    intro: "Describe the issue so the administrator can follow up. Anonymous reports are not linked to your account.",
    submitLabel: "Send report",
    fields: [
      { name: "category", label: "Category", type: "select", options: Object.entries(REPORT_CATEGORY_LABELS).map(([value, label]) => ({ value, label })) },
      { name: "title", label: "Subject", required: true, max: 100, placeholder: "e.g. Leaking pipe in the bathroom" },
      { name: "body", label: "Description", type: "textarea", required: true, max: 2000, placeholder: "Share where it is and what happened." },
      { name: "anonymous", label: "Send anonymously", type: "checkbox" }
    ],
    onSubmit: async (values) => {
      await api("POST", "/api/me/reports", {
        category: values.category,
        title: values.title,
        body: values.body,
        anonymous: values.anonymous === "true"
      });
      toast(values.anonymous === "true" ? "Anonymous report sent to the administrator." : "Report sent to the administrator.");
      await renderReports();
    }
  });
}

async function renderNotifications() {
  const { notifications, unreadCount } = await api("GET", "/api/me/notifications");
  updateResidentNotificationBadge(unreadCount);
  body("notifications").innerHTML = notifications.length ? `<div class="list">${notifications.map((notification) => `
    <div class="row notification-row${notification.readAt ? "" : " unread"}">
      <span class="note-icon ${notification.kind === "announcement" ? "info" : ""}">${icon(notification.kind === "announcement" ? "megaphone" : "bell")}</span>
      <div class="grow"><strong>${esc(notification.title)}</strong>${notification.body ? `<p class="note-body">${esc(notification.body)}</p>` : ""}<small>${formatDateTime(notification.createdAt)}${notification.readAt ? "" : " · Unread"}</small></div>
      ${notification.readAt ? "" : `<button class="btn outline small" type="button" data-read-resident-notification="${notification.id}">Mark read</button>`}
    </div>`).join("")}</div>` : emptyBox("No notifications", "Announcements and reminders will appear here.");
}

async function refreshResidentNotificationBadge() {
  const { unreadCount } = await api("GET", "/api/me/notifications");
  updateResidentNotificationBadge(unreadCount);
}

function updateResidentNotificationBadge(unreadCount) {
  ["resident-notification-count", "desktop-notification-count"].forEach((id) => {
    const badge = $(id);
    if (!badge) return;
    badge.hidden = unreadCount < 1;
    badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    badge.setAttribute("aria-label", `${unreadCount} unread notifications`);
  });
}

/* ---------- Visitors ---------- */
async function renderVisitors() {
  const { visitors } = await loadOverview();
  body("visitors").innerHTML = `
    <button class="btn btn-primary btn-block" type="button" id="add-my-visitor">${icon("plus")} Add a visitor</button>
    ${visitors.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Visitor Name</th><th>Date &amp; Time</th><th>Status</th></tr></thead>
      <tbody>${visitors.map((v) => `<tr><td>${esc(v.visitorName)}</td><td>${esc(formatDateTime(v.visitedAt))}</td>
        <td><span class="pill available">Logged</span></td></tr>`).join("")}</tbody></table></div>`
      : emptyBox("No visitors logged", "Add visitors here to record them in the visitor log.")}`;
}

function visitorForm() {
  openForm({
    title: "Add a visitor", intro: "The visitor will be added to the log immediately.",
    submitLabel: "Submit visitor",
    fields: [
      { name: "visitorName", label: "Visitor name", required: true, max: 100 },
      { name: "visitedAt", label: "Date & time", type: "datetime-local", required: true, value: localDateTimeValue() }
    ],
    onSubmit: async (v) => {
      const visitedAt = new Date(v.visitedAt).getTime();
      if (!Number.isFinite(visitedAt)) throw new Error("Enter a valid date and time.");
      await api("POST", "/api/me/visitors", { visitorName: v.visitorName, visitedAt });
      toast("Visitor added to the log.");
      await renderVisitors();
    }
  });
}

/* ---------- Curfew ---------- */
async function renderCurfew() {
  const { curfew } = await loadOverview();
  body("curfew").innerHTML = `
    <div class="card status-hero"><div class="big">${icon("clock")}</div><h2>Curfew schedule</h2>
      <p class="muted">Please be inside the dormitory by</p><strong class="curfew-schedule-time">${formatClock(curfew.curfewTime)}</strong></div>`;
}

/* ---------- More ---------- */
function renderMore() {
  const u = state.overview.user;
  body("more").innerHTML = `
    <div class="card"><div class="row">${avatar(u.name)}<div class="grow"><strong>${esc(u.name)}</strong><small>${esc(u.email || "No email on file")}</small></div></div>
      <div class="stat-line"><span>Username</span><strong>${esc(u.username)}</strong></div>
      ${u.phone ? `<div class="stat-line"><span>Phone</span><strong>${esc(u.phone)}</strong></div>` : ""}</div>
    <h2 class="section-title">Quick links</h2>
    <div class="module-grid">${MODULES.map(moduleButton).join("")}</div>
    <button class="btn btn-danger btn-block" type="button" id="signout">${icon("logout")} Sign out</button>`;
}

/* ---------- Routing ---------- */
const views = {
  home: renderHome, room: renderRoom, payments: renderPayments, announcements: renderAnnouncements, notifications: renderNotifications,
  reminders: renderReminders, visitors: renderVisitors, curfew: renderCurfew, more: renderMore, reports: renderReports
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
    if (name !== "notifications") await refreshResidentNotificationBadge();
  } catch (error) {
    if (token === routeToken) toast(error.message, true);
  }
}

function go(name) {
  if (location.hash === `#${name}` || (name === "home" && !location.hash)) route();
  else location.hash = name;
}

document.addEventListener("click", async (event) => {
  const t = event.target;
  const navigate = t.closest("[data-go]");
  if (navigate) return go(navigate.dataset.go);
  const submitOr = t.closest("[data-submit-payment-or]");
  if (submitOr) {
    const payment = state.overview?.payments.find((item) => String(item.id) === submitOr.dataset.submitPaymentOr);
    if (payment) return submitPaymentOr(payment);
  }
  const editPaymentOr = t.closest("[data-edit-payment-or]");
  if (editPaymentOr) {
    const payment = state.overview?.payments.find((item) => String(item.id) === editPaymentOr.dataset.editPaymentOr);
    if (payment) return submitPaymentOr(payment, true);
  }
  const readNotification = t.closest("[data-read-resident-notification]");
  if (readNotification) {
    try {
      await api("PATCH", `/api/me/notifications/${readNotification.dataset.readResidentNotification}`, {});
      await renderNotifications();
    } catch (error) { toast(error.message, true); }
    return;
  }
  if (t.closest("#add-my-visitor")) {
    try { return visitorForm(); } catch (error) { return toast(error.message, true); }
  }
  if (t.closest("#start-payment")) return residentPaymentForm();
  if (t.closest("#start-resident-report")) {
    try { return residentReportForm(); } catch (error) { return toast(error.message, true); }
  }
  if (t.closest("#signout")) {
    try {
      await api("POST", "/api/auth/logout", {});
      window.location.assign(appUrl("login.html"));
    } catch (error) {
      toast(error.message, true);
    }
  }
});

window.addEventListener("hashchange", route);

(async function start() {
  $("year").textContent = String(new Date().getFullYear());
  try {
    await loadOverview();
    const resident = state.overview.user;
    $("resident-sidebar-name").textContent = resident.name;
    $("resident-sidebar-avatar").textContent = initials(resident.name);
    $("resident-header-name").textContent = resident.name;
    $("resident-header-avatar").textContent = initials(resident.name);
  } catch (error) {
    // A 403 means this is an administrator account.
    if (/Administrator|Resident access/.test(error.message)) return window.location.replace(appUrl("index.html"));
    if (error.message.includes("sign in")) return;
    toast(error.message, true);
    return;
  }
  route();
  window.setInterval(() => {
    if (document.visibilityState === "visible") refreshResidentNotificationBadge().catch(() => {});
  }, 30000);
})();
