const form = document.getElementById("register-form");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirm-password");
const statusEl = document.getElementById("register-status");
const submitButton = document.getElementById("register-submit");
const loginLink = document.getElementById("register-login");

form.addEventListener("input", () => {
  statusEl.textContent = "";
  statusEl.classList.remove("ok");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  if (passwordInput.value !== confirmPasswordInput.value) {
    statusEl.textContent = "Passwords do not match.";
    confirmPasswordInput.focus();
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Creating account…";
  try {
    const { user } = await api("POST", "/api/auth/register", {
      name: document.getElementById("name").value.trim(),
      username: document.getElementById("username").value.trim(),
      email: document.getElementById("email").value.trim(),
      phone: document.getElementById("phone").value.trim(),
      password: passwordInput.value
    });
    statusEl.textContent = `Account created for ${user.name}. You can now sign in.`;
    statusEl.classList.add("ok");
    loginLink.hidden = false;
    submitButton.textContent = "Account created";
  } catch (error) {
    statusEl.textContent = error.message;
    submitButton.disabled = false;
    submitButton.textContent = "Create account";
  }
});
