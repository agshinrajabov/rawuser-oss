/**
 * Provision the first (or update an existing) superadmin user in D1.
 *
 * Usage:
 *   pnpm gen:create-superadmin                 # local D1 (default)
 *   D1_TARGET=remote pnpm gen:create-superadmin # production D1
 *
 * Prompts for email and password interactively.
 * The password is NEVER echoed to the terminal or logged to stdout/stderr.
 *
 * Idempotent: if the email already exists, prompts to update the password instead.
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { hashPassword } from "../packages/generation/src/auth/password.ts";

const WRANGLER_CONFIG = "packages/generation/wrangler.toml";
const DB_NAME = "rawuser_db";
const TARGET_FLAG = process.env.D1_TARGET === "remote" ? "--remote" : "--local";

// ---------------------------------------------------------------------------
// D1 helpers (the same helpers as the seed script)
// ---------------------------------------------------------------------------

function d1Execute(sql: string): string {
  return execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DB_NAME,
      TARGET_FLAG,
      "--config",
      WRANGLER_CONFIG,
      "--command",
      sql,
    ],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env:
        TARGET_FLAG === "--local"
          ? { ...process.env, CLOUDFLARE_API_TOKEN: "local" }
          : { ...process.env },
    },
  );
}

function d1Query(sql: string): Array<Record<string, unknown>> {
  const raw = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DB_NAME,
      TARGET_FLAG,
      "--config",
      WRANGLER_CONFIG,
      "--command",
      sql,
      "--json",
    ],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env:
        TARGET_FLAG === "--local"
          ? { ...process.env, CLOUDFLARE_API_TOKEN: "local" }
          : { ...process.env },
    },
  );
  // wrangler --json returns an array of result sets; we want the first one's results.
  const parsed = JSON.parse(raw) as Array<{ results: Array<Record<string, unknown>> }>;
  return parsed[0]?.results ?? [];
}

// ---------------------------------------------------------------------------
// Terminal I/O helpers
//
// Interactive (TTY) prompts use raw mode for password fields (no echo)
// and a simple readline question() for plain text.
//
// Non-TTY / piped mode: reads ALL of stdin upfront into a line queue, then
// dequeues one line per prompt.  This is the only reliable way to handle
// multiple sequential prompts with piped input in Node — readline's
// interface drains stdin when the first .question() fires.
// ---------------------------------------------------------------------------

/** Line queue pre-loaded when stdin is not a TTY. */
let _lineQueue: string[] | null = null;

async function loadLineQueue(): Promise<void> {
  if (process.stdin.isTTY) return; // TTY: nothing to pre-load.
  _lineQueue = [];
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      (_lineQueue as string[]).push(line.trim());
    });
    rl.on("close", () => resolve());
  });
}

function dequeue(question: string): string {
  process.stdout.write(question);
  const line = (_lineQueue as string[]).shift();
  if (line === undefined) {
    throw new Error("Unexpected end of piped input.");
  }
  process.stdout.write("\n");
  return line;
}

/** Prompt for plain text (TTY: echoed; non-TTY: dequeue). */
function prompt(question: string): Promise<string> {
  if (_lineQueue !== null) {
    return Promise.resolve(dequeue(question));
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a password without echoing characters (TTY only).
 * Non-TTY path dequeues from the pre-loaded line queue.
 *
 * TTY path: puts stdin into raw mode so keystrokes are not echoed.
 * Restores normal mode on Enter or Ctrl-C.
 */
function promptPassword(question: string): Promise<string> {
  if (_lineQueue !== null) {
    // Non-TTY: pull from the queue (no echo, same as a hidden prompt).
    return Promise.resolve(dequeue(question));
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(question);

    let password = "";

    const CTRL_C = "";
    const BACKSPACE = "";
    const BACKSPACE_ALT = "\b";

    const onData = (buf: Buffer) => {
      const char = buf.toString("utf-8");
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("error", onError);
        process.stdout.write("\n");
        resolve(password);
      } else if (char === CTRL_C) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("error", onError);
        process.stdout.write("\n");
        reject(new Error("Interrupted"));
      } else if (char === BACKSPACE || char === BACKSPACE_ALT) {
        password = password.slice(0, -1);
      } else {
        password += char;
      }
    };

    const onError = (err: Error) => {
      reject(err);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Pre-load stdin if we are not in a TTY (piped / automated).
  await loadLineQueue();

  const mode = TARGET_FLAG === "--remote" ? "REMOTE (production)" : "LOCAL";
  console.log(`\nCreate superadmin — D1 target: ${mode}\n`);

  // 1. Collect email.
  const email = await prompt("Email: ");
  if (!isValidEmail(email)) {
    console.error("Invalid email address. Aborting.");
    process.exit(1);
  }

  // 2. Collect password (hidden, confirmed).
  const password = await promptPassword("Password (typing hidden): ");
  if (password.length < 12) {
    console.error("Password must be at least 12 characters. Aborting.");
    process.exit(1);
  }
  const confirm = await promptPassword("Confirm password: ");
  if (password !== confirm) {
    console.error("Passwords do not match. Aborting.");
    process.exit(1);
  }

  // 3. Hash the password via Web Crypto.
  const passwordHash = await hashPassword(password);

  // 4. Check whether the user already exists.
  const safeEmail = email.replace(/'/g, "''");
  const existing = d1Query(`SELECT id FROM superadmin_users WHERE email = '${safeEmail}'`);

  if (existing.length > 0) {
    console.log("\nUser with that email already exists.");
    const choice = await prompt("Update password instead? [y/N]: ");
    if (choice.toLowerCase() !== "y") {
      console.log("No changes made. Exiting.");
      process.exit(0);
    }
    // UPDATE password only.
    d1Execute(
      `UPDATE superadmin_users SET password_hash = '${passwordHash.replace(/'/g, "''")}' WHERE email = '${safeEmail}'`,
    );
    console.log(`\nPassword updated for ${email}.`);
    return;
  }

  // 5. INSERT new superadmin user.
  const id = crypto.randomUUID();
  const now = Date.now();
  d1Execute(
    `INSERT INTO superadmin_users (id, email, password_hash, role, created_at)
     VALUES (
       '${id}',
       '${safeEmail}',
       '${passwordHash.replace(/'/g, "''")}',
       'superadmin',
       ${now}
     )`,
  );

  console.log(`\nCreated superadmin user ${email}.`);
}

main().catch((err: unknown) => {
  if (err instanceof Error && err.message === "Interrupted") {
    console.log("\nAborted.");
    process.exit(1);
  }
  console.error("create-superadmin failed:", err);
  process.exit(1);
});
