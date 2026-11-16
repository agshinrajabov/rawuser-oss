/**
 * Password hashing + verification + session-token hashing.
 *
 * Hashing: PBKDF2-SHA256, 100k iterations, 16-byte random salt.
 * Storage format: "<salt-b64url>.<hash-b64url>" — single TEXT column.
 *
 * Session tokens: 32-byte random → SHA-256 hex for the stored hash.
 * Per-request lookup is microseconds; no brute-force surface (256 bits of input entropy).
 *
 * Web Crypto only — works in Cloudflare Workers AND Node 22 (where the
 * create-superadmin script runs). No bcryptjs, no node:crypto, no deps.
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

function b64urlEncode(bytes: Uint8Array): string {
  // Build a binary string from bytes, then btoa, then make URL-safe and strip padding.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(s: string): Uint8Array {
  // Re-pad to multiple of 4, then restore standard base64 chars before atob.
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const standard = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    HASH_BITS,
  );
  return `${b64urlEncode(salt)}.${b64urlEncode(new Uint8Array(hashBuf))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(".");
  if (!saltB64 || !hashB64) return false;
  const salt = b64urlDecode(saltB64);
  const expected = b64urlDecode(hashB64);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const actualBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    HASH_BITS,
  );
  const actual = new Uint8Array(actualBuf);
  // Constant-time compare — never short-circuit on mismatch.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] as number) ^ (expected[i] as number);
  return diff === 0;
}

/** Generate a fresh client-facing session token (raw, base64url, 43 chars). */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64urlEncode(bytes);
}

/** Hash a client session token for D1 storage (SHA-256 hex, 64 chars). */
export async function hashSessionToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
