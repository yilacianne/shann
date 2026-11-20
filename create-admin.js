const readline = require("node:readline/promises");
const { PASSWORD_MAX, PASSWORD_MIN, createAccount, isUniqueError, openStore } = require("./store");

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(prompt).finally(() => rl.close());
}

function askHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Run this command in an interactive terminal so the password can be hidden."));
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          reject(new Error("Admin setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  const username = (await ask("Admin username: ")).trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    throw new Error("Username must be 3-32 letters, numbers, dots, dashes or underscores.");
  }

  const password = await askHidden(`Admin password (${PASSWORD_MIN}+ characters): `);
  if ([...password].length < PASSWORD_MIN || [...password].length > PASSWORD_MAX) {
    throw new Error(`Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`);
  }

  const confirmation = await askHidden("Confirm password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");

  const db = openStore();
  try {
    const account = createAccount(db, { username, name: "Residence Administrator", password, role: "admin" });
    console.log(`Admin account created. Sign in as "${account.username}" using the Admin tab.`);
  } catch (error) {
    if (isUniqueError(error, "accounts.username")) throw new Error("That username is already taken.");
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
