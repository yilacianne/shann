/* Shared helpers used by the login, administrator and resident pages. */
const APP_BASE = new URL(".", window.location.href).pathname;
const appUrl = (path) => `${APP_BASE}${String(path).replace(/^\/+/, "")}`;
const THEME_KEY = "dms-theme";

function currentTheme() {
  return document.documentElement.dataset.theme || "dark";
}

function setTheme(theme) {
  const selectedTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selectedTheme;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === selectedTheme));
  });
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = selectedTheme === "light" ? "#f6f1e8" : "#3f1421";
  localStorage.setItem(THEME_KEY, selectedTheme);
}

setTheme(localStorage.getItem(THEME_KEY) || "dark");
document.addEventListener("click", (event) => {
  const choice = event.target.closest("[data-theme-choice]");
  if (choice) setTheme(choice.dataset.themeChoice);
});

function downloadCsv(filename, headers, rows) {
  const cell = (value) => {
    let text = String(value ?? "");
    if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const ICONS = {
  home: '<path d="m3 11 9-8 9 8v10h-6v-6H9v6H3V11Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="8" r="4"/><path d="M21 21v-2a4 4 0 0 0-3-3.9M16 4.1a4 4 0 0 1 0 7.8"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="8" r="4"/>',
  bed: '<path d="M3 20V6M3 16h18v4M21 16v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="12" r="2"/>',
  wallet: '<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M16 14.5h2"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9a2.8 2.8 0 0 0-2.8-1.6c-1.7 0-2.8.9-2.8 2.1 0 3 5.6 1.5 5.6 4.5 0 1.2-1.2 2.1-2.8 2.1a3 3 0 0 1-3-1.7M12 6v1.4M12 16.6V18"/>',
  megaphone: '<path d="m3 11 15-6v14L3 13v-2Z"/><path d="M7 13.5V18a2 2 0 0 0 4 0v-2.5M21 9v6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10.3 20a2 2 0 0 0 3.4 0"/>',
  card: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 17c.6-2 2-2.8 3.5-2.8s2.9.8 3.5 2.8M15 9.5h3M15 13h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.2"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.2v.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.3 6.4A16.6 16.6 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6"/>',
  building: '<path d="M4 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17M15 9h4a1 1 0 0 1 1 1v11M2 21h20M8 7h3M8 11h3M8 15h3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'
};

function icon(name) {
  return `<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[name] || ""}</svg></span>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[el.dataset.icon] || ""}</svg>`;
    el.classList.add("ico");
    el.removeAttribute("data-icon");
  });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((p) => p[0] || "").join("").toUpperCase() || "?";
}

function avatar(name, seed = 0) {
  let hash = seed;
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return `<span class="avatar c${(hash % 5) + 1}" aria-hidden="true">${esc(initials(name))}</span>`;
}

const peso = (amount) => `₱${Number(amount || 0).toLocaleString("en-PH")}`;

function formatDate(value) {
  if (value === null || value === undefined || value === "") return "";
  const timestamp = typeof value === "number" || /^\d{10,}$/.test(String(value));
  const date = timestamp ? new Date(Number(value)) : new Date(`${value}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(ms) {
  const d = new Date(typeof ms === "string" && /^\d{10,}$/.test(ms) ? Number(ms) : ms);
  return `${formatDate(ms)} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function formatClock(time) {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function localDateTimeValue(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

const STATUS_LABELS = { paid: "Paid", pending: "Due", overdue: "Overdue", on_time: "On time", late: "Late", available: "Available", occupied: "Occupied", maintenance: "Maintenance" };

async function api(method, url, body) {
  const options = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url.startsWith("/") ? appUrl(url) : url, options);
  } catch {
    throw new Error("Can't reach the server. Make sure it is running (npm start) and try again.");
  }
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON response */ }
  if (response.status === 401 && !url.startsWith("/api/auth/login")) {
    window.location.replace(appUrl("login.html"));
    throw new Error("Please sign in to continue.");
  }
  if (!response.ok) throw new Error((data && data.error) || "Something went wrong. Please try again.");
  return data;
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(message, isError = false) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 3200);
}

/* ---------- Dialogs ---------- */
function getDialog(id) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = id;
    dlg.addEventListener("click", (event) => { if (event.target === dlg) dlg.close(); });
    document.body.append(dlg);
  }
  return dlg;
}

function confirmAction(message, confirmLabel = "Delete") {
  return new Promise((resolve) => {
    const dlg = getDialog("confirm-dialog");
    dlg.innerHTML = `<div class="dlg"><div class="dlg-head"><h2>Are you sure?</h2></div><p class="muted">${esc(message)}</p>
      <div class="dlg-actions"><button class="btn btn-ghost" type="button" data-answer="no">Cancel</button><button class="btn btn-danger" type="button" data-answer="yes">${esc(confirmLabel)}</button></div></div>`;
    let answer = false;
    dlg.onclick = (event) => {
      if (event.target === dlg) dlg.close();
      const button = event.target.closest("[data-answer]");
      if (button) { answer = button.dataset.answer === "yes"; dlg.close(); }
    };
    dlg.onclose = () => resolve(answer);
    dlg.showModal();
  });
}

function randomPassword(length = 14) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function fieldHtml(field) {
  const id = `f-${field.name}`;
  const common = `id="${id}" name="${esc(field.name)}"${field.required ? " required" : ""}`;
  let control;
  if (field.type === "checkbox") {
    control = `<input type="checkbox" ${common} value="true"${field.checked ? " checked" : ""}>`;
  } else if (field.type === "select") {
    control = `<select ${common}>${field.options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(field.value ?? "") ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
  } else if (field.type === "textarea") {
    control = `<textarea ${common} maxlength="${field.max || 1000}" placeholder="${esc(field.placeholder || "")}">${esc(field.value ?? "")}</textarea>`;
  } else if (field.type === "file") {
    control = `<input type="file" ${common}${field.accept ? ` accept="${esc(field.accept)}"` : ""}>`;
  } else {
    const attrs = [
      `type="${field.type || "text"}"`, common,
      `value="${esc(field.value ?? "")}"`,
      field.placeholder ? `placeholder="${esc(field.placeholder)}"` : "",
      field.min !== undefined ? `min="${field.min}"` : "",
      field.max !== undefined ? `max="${field.max}"` : "",
      field.minlength ? `minlength="${field.minlength}"` : "",
      field.maxlength ? `maxlength="${field.maxlength}"` : "",
      field.autocomplete ? `autocomplete="${field.autocomplete}"` : "",
      field.accept ? `accept="${esc(field.accept)}"` : "",
      field.readonly ? "readonly" : ""
    ].join(" ");
    control = field.generate || field.showPassword
      ? `<span class="with-btn"><input ${attrs}>${field.showPassword ? `<button class="btn btn-ghost small" type="button" data-toggle-password="${id}" aria-label="Show password" aria-pressed="false">Show</button>` : ""}${field.generate ? `<button class="btn btn-ghost small" type="button" data-generate="${id}">Generate</button>` : ""}</span>`
      : `<input ${attrs}>`;
  }
  return `<label class="field"><span>${esc(field.label)}</span>${control}${field.help ? `<small>${esc(field.help)}</small>` : ""}</label>`;
}

/* Opens a modal form. onSubmit(values) may throw to show an error; resolving closes the dialog. */
function openForm({ title, intro, fields, submitLabel = "Save", onSubmit, onDelete, deleteLabel = "Delete" }) {
  const dlg = getDialog("form-dialog");
  dlg.innerHTML = `<form class="dlg" novalidate>
    <div class="dlg-head"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-close aria-label="Close">${icon("close")}</button></div>
    ${intro ? `<p class="muted small">${esc(intro)}</p>` : ""}
    ${fields.map(fieldHtml).join("")}
    <p class="form-status" role="alert"></p>
    <div class="dlg-actions">
      ${onDelete ? `<button class="btn btn-danger" type="button" data-delete>${esc(deleteLabel)}</button>` : ""}
      <button class="btn btn-ghost" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="submit">${esc(submitLabel)}</button>
    </div></form>`;
  const form = dlg.querySelector("form");
  const status = form.querySelector(".form-status");
  const submit = form.querySelector('[type="submit"]');

  fields.forEach((field) => {
    if (field.onChange) form.elements[field.name].addEventListener("change", (e) => field.onChange(e.target.value, form));
    if (field.onInput) form.elements[field.name].addEventListener("input", (e) => field.onInput(e.target.value, form));
  });
  form.addEventListener("click", async (event) => {
    if (event.target.closest("[data-close]")) return dlg.close();
    const toggle = event.target.closest("[data-toggle-password]");
    if (toggle) {
      const input = form.querySelector(`#${toggle.dataset.togglePassword}`);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Hide" : "Show";
      toggle.setAttribute("aria-label", `${show ? "Hide" : "Show"} password`);
      toggle.setAttribute("aria-pressed", String(show));
      return;
    }
    const gen = event.target.closest("[data-generate]");
    if (gen) {
      const input = form.querySelector(`#${gen.dataset.generate}`);
      input.value = randomPassword();
      input.type = "text";
      const toggle = form.querySelector(`[data-toggle-password="${gen.dataset.generate}"]`);
      if (toggle) {
        toggle.textContent = "Hide";
        toggle.setAttribute("aria-label", "Hide password");
        toggle.setAttribute("aria-pressed", "true");
      }
      return;
    }
    if (event.target.closest("[data-delete]")) {
      if (!(await confirmAction("This cannot be undone.", deleteLabel))) return;
      try { await onDelete(); dlg.close(); } catch (error) { status.textContent = error.message; }
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form).entries());
    submit.disabled = true;
    try {
      await onSubmit(values);
      dlg.close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  dlg.showModal();
  const first = form.querySelector("input:not([readonly]), select, textarea");
  if (first) first.focus();
  return form;
}

document.addEventListener("DOMContentLoaded", () => hydrateIcons());
