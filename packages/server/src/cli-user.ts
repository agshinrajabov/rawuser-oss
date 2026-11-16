/**
 * Makes the first sign-in of an install on a server, or gives it a new
 * password.
 *
 *   pnpm server:user
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./d1.ts";
import { settingsFrom } from "./main.ts";
import { migrate } from "./migrate.ts";
import { ask, askUnseen } from "./prompt.ts";
import { setFirstUser } from "./user.ts";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const settings = settingsFrom(process.env);
  mkdirSync(settings.dataDir, { recursive: true });
  const db = openDatabase(join(settings.dataDir, "main.sqlite"));
  migrate(db, settings.migrationsDir);
  const email = await ask("Email");
  const password = await askUnseen("Password (12 characters or more, not shown)");
  const did = await setFirstUser(db, email, password);
  db.close();
  console.log(
    did === "created" ? `Made the sign-in for ${email}.` : `New password set for ${email}.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
