/**
 * Two-step recovery codes (docs/specs/security-hardening.md, section 1.4).
 *
 * Ten per user, 16 characters of Crockford Base32 (80 bits each), shown
 * once as XXXX-XXXX-XXXX-XXXX. Stored as SHA-256 hex of "user_id:CODE":
 * at 80 bits a fast hash is safe against offline guessing, and one hash
 * per try keeps the check cheap. Typing is forgiving: case, spaces and
 * dashes ignored, O read as 0, I and L as 1.
 */

import { hashSessionToken } from "./password.ts";

export const RECOVERY_CODE_COUNT = 10;
const CODE_LENGTH = 16;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Fresh codes, formatted for display. 256 is a multiple of 32, so `& 31` is uniform. */
export function newRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    let raw = "";
    for (const b of bytes) raw += CROCKFORD[b & 31];
    codes.push(raw.match(/.{4}/g)?.join("-") ?? raw);
  }
  return codes;
}

/** The canonical 16 characters, or null when it cannot be a recovery code. */
export function normalizeRecoveryCode(typed: string): string | null {
  const s = typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

export async function recoveryCodeHash(userId: string, normalized: string): Promise<string> {
  return hashSessionToken(`${userId}:${normalized}`);
}
