/**
 * Installs Rawuser into your own Cloudflare account.
 *
 *   pnpm self-host             the install; safe to run again
 *   pnpm self-host --dry-run   say what it would do, change nothing
 *   pnpm self-host --adopt     a new checkout takes over an install this
 *                              account already holds
 *
 * It makes one KV namespace, one D1 database, two Workers and one Pages
 * project, writes their ids into the two wrangler.toml files, and asks for
 * the model that writes your versions. You need to be logged in first
 * (`npx wrangler login`). With more than one account, name the one to use:
 * CLOUDFLARE_ACCOUNT_ID=<id> pnpm self-host.
 *
 * The steps are in scripts/lib/self-host.ts; this file only talks to the
 * terminal and runs the commands.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Io, type RunOptions, selfHost } from "./lib/self-host.ts";

const ROOT = resolve(__dirname, "..");

function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, [...args], {
      cwd: resolve(ROOT, options.cwd ?? "."),
      env: { ...process.env, ...options.env },
      stdio: [
        options.input !== undefined ? "pipe" : options.interactive ? "inherit" : "ignore",
        "pipe",
        "pipe",
      ],
    });
    let out = "";
    const take = (chunk: Buffer) => {
      out += chunk.toString();
      // A command that asks the person something must be seen asking.
      if (options.interactive) process.stdout.write(chunk);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    if (options.input !== undefined) child.stdin?.end(`${options.input}\n`);
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) return done(out);
      // The command and its last lines; never what was sent to its input.
      const tail = out.trim().split("\n").slice(-12).join("\n");
      fail(new Error(`${command} ${args.join(" ")} failed (${code})\n${tail}`));
    });
  });
}

function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const hint = fallback ? ` [${fallback}]` : "";
  return new Promise((done) => {
    rl.question(`${question}${hint}: `, (answer) => {
      rl.close();
      done(answer.trim() === "" ? (fallback ?? "") : answer.trim());
    });
  });
}

/** Reads a line without showing it. */
function askSecret(question: string): Promise<string> {
  return new Promise((done) => {
    const input = process.stdin;
    process.stdout.write(`${question}: `);
    let value = "";
    const raw = input.isTTY;
    if (raw) input.setRawMode(true);
    input.resume();
    const onData = (chunk: Buffer) => {
      for (const c of chunk.toString()) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          if (raw) input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          return done(value);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    };
    input.on("data", onData);
  });
}

async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} (y/N)`));
}

const io: Io = {
  run,
  ask,
  askSecret,
  confirm,
  log: (line) => console.log(line),
  readFile: (path) => readFileSync(resolve(ROOT, path), "utf8"),
  writeFile: (path, text) => writeFileSync(resolve(ROOT, path), text),
  randomKey: () => randomBytes(32).toString("base64"),
  fetchText: async (url) => {
    try {
      const res = await fetch(url);
      return { status: res.status, body: await res.text() };
    } catch {
      return { status: 0, body: "" };
    }
  },
};

selfHost(
  io,
  { dryRun: process.argv.includes("--dry-run"), adopt: process.argv.includes("--adopt") },
  process.env,
).catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  console.error("\nNothing is lost: fix what it says and run pnpm self-host again.");
  process.exit(1);
});
