const form = document.getElementById("login-form");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const statusEl = document.getElementById("status");
const submitButton = document.getElementById("submit");
const toggleButton = document.getElementById("toggle-password");
toggleButton.addEventListener("click", () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  toggleButton.setAttribute("aria-pressed", String(show));
  toggleButton.setAttribute("aria-label", show ? "Hide password" : "Show password");
  toggleButton.innerHTML = `<span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[show ? "eyeOff" : "eye"]}</svg></span>`;
});

form.addEventListener("input", () => { statusEl.textContent = ""; });

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  if (!username || !passwordInput.value) {
    statusEl.textContent = "Enter your username and password.";
    (username ? passwordInput : usernameInput).focus();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Signing in…";
  try {
    const { user } = await api("POST", "/api/auth/login", {
      username, password: passwordInput.value, remember: document.getElementById("remember").checked
    });
    window.location.assign(appUrl(user.role === "admin" ? "index.html" : "resident.html"));
  } catch (error) {
    statusEl.textContent = error.message;
    submitButton.disabled = false;
    submitButton.textContent = "Login";
  }
});
