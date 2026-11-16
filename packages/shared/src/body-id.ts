/**
 * The id of a version body (docs/specs/proof-engine.md, section C).
 *
 * 16 lowercase hex characters: the first 64 bits of SHA-256 over canonical
 * JSON (keys sorted) of the cell and the served sections. `generated_at`,
 * `prompt_hash` and `body_id` itself are left out, so the same words in the
 * same cell get the same id whatever run wrote them, and two cells with the
 * same words never share one. A fact about our content, never about a
 * visitor. Works in Workers and Node (Web Crypto).
 */

export const BODY_ID_SHAPE = /^[0-9a-f]{16}$/;

/** The id when it has the right shape, else undefined. */
export function parseBodyId(raw: unknown): string | undefined {
  return typeof raw === "string" && BODY_ID_SHAPE.test(raw) ? raw : undefined;
}

/** JSON with object keys sorted at every depth; undefined values dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

export interface BodyCell {
  customer_id: string;
  page_path: string;
  intent_dim: string;
  source_dim: string;
}

/** The body id of `sections` served in `cell`. */
export async function computeBodyId(cell: BodyCell, sections: unknown): Promise<string> {
  const input = canonicalJson({
    customer_id: cell.customer_id,
    page_path: cell.page_path,
    intent_dim: cell.intent_dim,
    source_dim: cell.source_dim,
    sections,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest).slice(0, 8);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
