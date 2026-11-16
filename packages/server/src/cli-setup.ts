/**
 * Sets Rawuser up on this machine (docs/self-hosting.md).
 *
 *   pnpm server:setup
 *
 * It asks for the three addresses people will reach it at and for the model
 * that writes your versions, writes them to `.env`, builds the dashboard
 * for those addresses, and makes your sign-in. Safe to run again: it keeps
 * the keys it made before.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelAnswers, modelProblem, modelVars } from "../../../scripts/lib/self-host.ts";
import { build } from "./build.ts";
import { openDatabase } from "./d1.ts";
import { settingsFrom } from "./main.ts";
import { migrate } from "./migrate.ts";
import { ask, askUnseen } from "./prompt.ts";
import { setFirstUser } from "./user.ts";

/** `.env` as its lines, with these names set: changed where they are, added at the end where not. */
export function withValues(text: string, values: Record<string, string>): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`;
    const at = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    if (at === -1) lines.push(line);
    else lines[at] = line;
  }
  return `${lines.join("\n")}\n`;
}

/** The value of a name in `.env` text, or undefined. */
export function valueIn(text: string, name: string): string | undefined {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m").exec(text);
  if (!m) return undefined;
  const v = (m[1] ?? "").trim();
  return /^".*"$/.test(v) ? (JSON.parse(v) as string) : v;
}

async function main(): Promise<void> {
  const had = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  const was = (name: string, fallback: string) => valueIn(had, name) ?? fallback;

  console.log("\n1. Where people will reach it. Each needs its own address: a host, or a port.");
  const edgeOrigin = await ask(
    "   The address your site's visitors' browsers call",
    was("EDGE_ORIGIN", "http://localhost:8787"),
  );
  const apiOrigin = await ask(
    "   The address the dashboard calls",
    was("API_ORIGIN", "http://localhost:8788"),
  );
  const dashboardOrigin = await ask(
    "   The dashboard's own address",
    was("DASHBOARD_ORIGIN", "http://localhost:8789"),
  );

  console.log("\n2. The model that writes your versions: any OpenAI-compatible endpoint.");
  let answers: ModelAnswers;
  for (;;) {
    answers = {
      route: "endpoint",
      baseUrl: await ask("   The endpoint, without /chat/completions", was("MODEL_BASE_URL", "")),
      modelId: await ask("   The model id", was("MODEL_ID", "")),
      fallbackId: await ask(
        "   A second model on the same endpoint, or nothing",
        was("MODEL_FALLBACK_ID", ""),
      ),
      key:
        (await askUnseen("   The endpoint's key (not shown; Enter keeps the one in .env)")) ||
        was("MODEL_API_KEY", ""),
    };
    const problem = modelProblem(answers);
    if (!problem) break;
    console.log(`   ${problem}`);
  }

  const values: Record<string, string> = {
    EDGE_ORIGIN: edgeOrigin.replace(/\/+$/, ""),
    API_ORIGIN: apiOrigin.replace(/\/+$/, ""),
    DASHBOARD_ORIGIN: dashboardOrigin.replace(/\/+$/, ""),
    ...modelVars(answers),
    MODEL_API_KEY: answers.key,
    // Seals stored two-step secrets: made once, and never replaced.
    MFA_ENCRYPTION_KEY: was("MFA_ENCRYPTION_KEY", randomBytes(32).toString("base64")),
  };
  writeFileSync(".env", withValues(had, values));
  // The file holds the model's key: for this user to read, and nobody else.
  chmodSync(".env", 0o600);
  console.log("\n   wrote .env");
  process.loadEnvFile(".env");

  console.log("\n3. The dashboard, built for those addresses");
  const settings = settingsFrom(process.env);
  build(settings);

  console.log("\n4. Your sign-in");
  mkdirSync(settings.dataDir, { recursive: true });
  const db = openDatabase(join(settings.dataDir, "main.sqlite"));
  migrate(db, settings.migrationsDir);
  const email = await ask("   Email");
  const password = await askUnseen("   Password (12 characters or more, not shown)");
  await setFirstUser(db, email, password);
  db.close();

  console.log(`
Done. Start it with:

  pnpm server:start

  Dashboard   ${settings.dashboardOrigin}
  API         ${settings.apiOrigin}
  Visitors    ${settings.edgeOrigin}

Sign in to the dashboard, add your site, and it gives you the tag to paste.
Nothing is sent to us. This install talks to your model, and looks your
site's address up in public DNS before it reads a page.`);
}

// Run as a program, not imported by a test.
if (process.argv[1]?.endsWith("cli-setup.ts")) {
  main().catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
