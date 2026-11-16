/**
 * The first sign-in of an install on a server: one account that can do
 * everything, made or given a new password.
 */

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { hashPassword } from "../../generation/src/auth/password.ts";

export async function setFirstUser(
  db: DatabaseSyncType,
  email: string,
  password: string,
  now: number = Date.now(),
): Promise<"created" | "updated"> {
  // As typed: sign-in looks the address up exactly.
  const address = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("that is not an email address");
  if (password.length < 12) throw new Error("the password needs 12 characters or more");
  const hash = await hashPassword(password);
  const existing = db.prepare("SELECT id FROM superadmin_users WHERE email = ?").get(address);
  if (existing) {
    db.prepare("UPDATE superadmin_users SET password_hash = ? WHERE email = ?").run(hash, address);
    return "updated";
  }
  db.prepare(
    "INSERT INTO superadmin_users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'superadmin', ?)",
  ).run(crypto.randomUUID(), address, hash, now);
  return "created";
}
