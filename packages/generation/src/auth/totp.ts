/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), Web Crypto only
 * (docs/specs/security-hardening.md, section 1.4).
 *
 * HMAC-SHA-1, 6 digits, 30-second steps, one step of drift either way.
 * SHA-1 is what every authenticator app supports; HMAC-SHA-1 is not
 * affected by SHA-1 collisions. A code is accepted once: the caller keeps
 * the last accepted step and passes it in, and a code at or below it is
 * refused.
 */

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now: one, so a code lives 60 to 90 seconds. */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits, the RFC 4226 recommendation and what the apps expect for SHA-1. */
export const TOTP_SECRET_BYTES = 20;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 Base32, no padding (what otpauth URIs carry). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 back to bytes; spaces, dashes and padding ignored, case-insensitive. Null on a bad character. */
export function base32Decode(s: string): Uint8Array | null {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES));
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
}

async function hotpWithKey(key: CryptoKey, counter: number, digits: number): Promise<string> {
  // 8-byte big-endian counter; split so counters past 2^32 stay exact.
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const bin =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** RFC 4226 HOTP value for one counter. */
export async function hotp(
  secret: Uint8Array,
  counter: number,
  digits = TOTP_DIGITS,
): Promise<string> {
  return hotpWithKey(await hmacKey(secret), counter, digits);
}

/** The 30-second step a unix-ms time falls in. */
export function totpCounter(unixMs: number): number {
  return Math.floor(unixMs / 1000 / TOTP_STEP_S);
}

/** RFC 6238 TOTP value at a unix-ms time. */
export async function totpAt(
  secret: Uint8Array,
  unixMs: number,
  digits = TOTP_DIGITS,
): Promise<string> {
  return hotp(secret, totpCounter(unixMs), digits);
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The step a typed code matches within the drift window, or null. Steps at
 * or below `lastCounter` never match (one use per code). Spaces in the typed
 * code are ignored; anything but six digits is refused without a hash.
 */
export async function matchTotp(
  secret: Uint8Array,
  typed: string,
  nowMs: number,
  lastCounter: number | null,
): Promise<number | null> {
  const code = typed.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const key = await hmacKey(secret);
  const now = totpCounter(nowMs);
  let found: number | null = null;
  // Every candidate is computed, so the time taken does not say which one matched.
  for (let d = -TOTP_DRIFT_STEPS; d <= TOTP_DRIFT_STEPS; d++) {
    const counter = now + d;
    const expected = await hotpWithKey(key, counter, TOTP_DIGITS);
    if (sameString(expected, code) && (lastCounter === null || counter > lastCounter)) {
      found = counter;
    }
  }
  return found;
}

/** The otpauth URI an authenticator app reads from the QR code. Holds the secret: never send it to a third party. */
export function otpauthUri(secretBase32: string, account: string, issuer = "Rawuser"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_S),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
