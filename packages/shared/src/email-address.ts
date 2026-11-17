/**
 * One plain email address, or null (the pilot invite, docs/specs/invite-email.md;
 * the pilot form's confirmation, docs/specs/pilot-auto-reply.md). Refuses
 * lists, display names, quotes and line breaks, so nothing typed can add a
 * recipient or a header.
 */

const MAX_ADDRESS = 254;
const ADDRESS_RE = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]{2,}$/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0 || v.length > MAX_ADDRESS) return null;
  if (!ADDRESS_RE.test(v)) return null;
  return v;
}
