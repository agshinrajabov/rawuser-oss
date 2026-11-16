import { type IntentDim, parseServed } from "@rawuser/shared";

/**
 * The intents this customer's site serves (docs/specs/site-shaped-intents.md
 * §7): null (all six) when the map is off, never read, or the columns are
 * not there yet.
 */
export async function loadServedIntents(
  customerId: string,
  db: D1Database,
): Promise<IntentDim[] | null> {
  try {
    const row = await db
      .prepare("SELECT served_intents, site_map_off FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{ served_intents: string | null; site_map_off: number | null }>();
    if (!row || row.site_map_off === 1) return null;
    return parseServed(row.served_intents);
  } catch {
    return null;
  }
}
