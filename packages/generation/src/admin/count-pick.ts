/**
 * Count-only pick, operator side (docs/specs/visual-picker.md §9).
 *
 *   POST /admin/conversions/pick-token  { customer_id, page_path?, group? }
 *     Mints a one-time count link for that page: the picker opens with one
 *     slot, "The button to count". 15 minutes, three seed reads, burned on
 *     Done. 409 while a test runs.
 *
 *   GET  /admin/conversions/pick-status?customer_id=X&page_path=Y
 *   GET  /admin/conversions/pick-status?customer_id=X&group=P
 *     When the picker has posted: one conversion target for the customer
 *     and the page the button was picked on (`section_path` "count:{path}"),
 *     made the counted button the way POST /admin/conversions/count does
 *     (one counted, the rest off), the visitor bundle rewritten, the KV key
 *     deleted. Answers { landed: true, page_path, target, items }, else
 *     { landed: false, page_path }. 409 while a test runs unless the pick
 *     is the button already counted.
 *
 * A page group (docs/specs/page-groups.md): with `group` (an accepted
 * pattern, `/products/*`) and `page_path` (one page of it; without one the
 * server opens the group's most loaded openable page, `lib/group-page.ts`,
 * or answers 409 `group_page_needed`), the link opens
 * that page and the pick is stored as one target with `section_path`
 * "count:{pattern}", counted on every page the pattern matches. A group's
 * pick ADDS a counted button: the customer's other counted buttons stay on
 * (the spec, "Decided after the first draft"). The privacy review's screens run
 * as for any pick: the identifier screen on the opened page at mint and on
 * the picked page at Done, links and buttons only and the account-style
 * words on the picked element (`validateCountPick`), and a pick inside
 * `header` or `nav` whose words come from `aria-label` alone is refused.
 * The sensitive 409 alone is checked on the pattern, never the page.
 *
 * A button on every page (visual-picker.md §9, "A button on every page",
 * 2026-10-13): with `scope: "site"` (and `page_path`, the page the operator
 * opens, default `/`) the same link and picker; at Done the pick is stored
 * as one target offered on every page, `section_path` "site:{slug of the
 * button's words}" (`site:contact`, `site:elaqe`; `-2` on a clash; never
 * the selector, never a path), enabled, ADDED to the counted buttons, at
 * most five per customer. The privacy review's screens run as for a group link.
 * A sensitive customer may pick one: the target names no page, and the
 * click's row stores the page by the existing rule (sensitive-customers.md:
 * a product page as its group or `/:item`), so nothing new sits beside the
 * marker. Until then the pilot's nav button was counted by typing its selector
 * into the section path by hand.
 *
 * Never reads or writes element_manifests' confirmation: a count pick
 * leaves every page's versions as they are.
 */

import {
  CONTACT_LABELS,
  COUNT_SLOT,
  type CountPick,
  GROUP_PATTERN_REFUSAL,
  type Goes,
  type Manifest,
  PICK_TTL_S,
  SITE_TARGETS_FULL_LINE,
  SITE_TARGETS_MAX,
  contactKindOf,
  countTargetPath,
  freeSiteTargetPath,
  isSiteTarget,
  normalizePath,
  pageGroupMatches,
  pagePathRefusal,
  pickCountKey,
  pickTokenKey,
  siteSlugOf,
  validPageGroupPattern,
  validateCountPick,
} from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";
import {
  GROUP_PAGE_NEEDED_CODE,
  GROUP_PAGE_NEEDED_LINE,
  chooseGroupPage,
} from "../lib/group-page.ts";
import { type ConversionLabel, conversionLabelOf } from "../lib/measure-proposal.ts";
import { acceptedGroups, groupAggregate, markGroupTargets } from "../lib/page-groups.ts";
import { sensitiveGroupRefusal, sensitivePageRefusal } from "../lib/sensitive-guard.ts";
import type { SessionUser } from "./auth.ts";
import {
  type ConversionsEnv,
  TEST_LOCK_REASON,
  countOnly,
  listTargetResponses,
  markedTargetResponses,
  testRunning,
} from "./conversions.ts";
import { jsonWithCors } from "./cors.ts";
import { writeVisitorBundle } from "./onboard.ts";
import { tagWithheldRefusal } from "./readiness.ts";
import { requireCustomerScope } from "./scope.ts";

export interface CountPickEnv extends ConversionsEnv {
  VARIANTS: KVNamespace;
}

/** The group link's lines, one plain sentence each. */
export const GROUP_UNKNOWN_PICK_LINE = "This page group is not on your list. Add it first.";
export const GROUP_PAGE_OUTSIDE_LINE = "This page is not one of the group's pages.";
export const GROUP_ARIA_ONLY_LINE =
  "This button has no words of its own. Pick a button with visible words.";

/**
 * Where a group link's opened page is kept for pick-status (the posted pick
 * is stored under that page by the edge), 15 minutes like the token.
 */
export function pickGroupKey(customerId: string, pattern: string): string {
  return `pick-count-group:${customerId}:${pattern}`;
}

/** The same for a site link: one at a time per customer. */
export function pickSiteKey(customerId: string): string {
  return `pick-count-site:${customerId}`;
}

export const SCOPE_LINE = 'scope must be "site" when given';
export const SCOPE_AND_GROUP_LINE = "A link is for a page group or for every page, not both.";
/** The label of a site-wide button without words of its own. */
const SITE_LABEL_WITHOUT_WORDS = "Button on every page";

/** The scope of a link's body or query: null without one, "site", or the 400 line. */
function scopeOf(raw: unknown): { scope: "site" | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { scope: null };
  return raw === "site" ? { scope: "site" } : { error: SCOPE_LINE };
}

export const SITE_PLACEMENT_LINE =
  "Pick a button from the menu or the footer, or a phone or email link.";
const LANDMARK_SCOPE = /\b(header|nav|footer)$/;
const LANDMARK_IN_CSS = /(^|[\s>])(header|nav|footer)(?=$|[\s>.#[:])/;

/**
 * The placement screen of a site link (privacy review,
 * condition 2): a button counted on every page must be one the site shows
 * on every page, so only an element inside `header`, `nav` or `footer`, or
 * a `tel:`/`mailto:` link, is admitted; a page-body button (a hero button,
 * a form's submit) takes the single-page pick. Told from the posted fields
 * alone: the structural description's scope (the nearest landmark the
 * picker climbs to: "first a in nav", "3rd a in footer") or a css candidate
 * that names one of the three as an ancestor. A link inside a `section` of
 * the footer reads "in section" and cannot be told, so it is refused unless
 * it is a phone or email link, which the `tel:`/`mailto:` rule admits
 * wherever it sits.
 */
export function sitePlacementAdmits(pick: Pick<CountPick, "css" | "text" | "structural">): boolean {
  if (contactKindOf(pick.text[0] ?? "", pick.css) !== null) return true;
  if (LANDMARK_SCOPE.test(pick.structural.trim())) return true;
  return pick.css.some((c) => LANDMARK_IN_CSS.test(c));
}

function siteLink(domain: string, pagePath: string, token: string): string {
  return `${siteOrigin(domain)}${pagePath}#rawuser_pick=${token}`;
}

interface StoredCount {
  id: string;
  enabled: number;
  css_selectors: string;
  text_selectors: string;
  structural_selector: string;
}

async function storedCount(
  db: D1Database,
  customerId: string,
  sectionPath: string,
): Promise<StoredCount | null> {
  const row = await db
    .prepare(
      `SELECT id, enabled, css_selectors, text_selectors, structural_selector
       FROM conversion_targets WHERE customer_id = ? AND section_path = ?`,
    )
    .bind(customerId, sectionPath)
    .first<StoredCount>();
  return row ?? null;
}

const words = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Privacy review condition 3 of page-groups.md, from the posted fields: the
 * picker names a button by its visible words, and only a button without
 * any takes its `aria-label` as its words; it also lists
 * `tag[aria-label="..."]` as a selector only when the label is not the
 * visible words. So a text signature that is the aria-label of one of its
 * own selectors is a button named by `aria-label` alone. Inside `header`
 * or `nav` (the structural description's scope) such a pick is refused on
 * a group link. A button with no words at all passes (its label is its
 * page).
 */
export function groupPickAriaOnly(pick: Pick<CountPick, "css" | "text" | "structural">): boolean {
  const signature = pick.text[0];
  if (!signature) return false;
  if (!/\b(header|nav)$/.test(pick.structural.trim())) return false;
  const sig = words(signature);
  return pick.css.some((c) => {
    const m = /\[aria-label="((?:[^"\\]|\\.)*)"\]/.exec(c);
    if (!m) return false;
    const label = words((m[1] ?? "").replace(/\\"/g, '"'));
    return label === sig || label.startsWith(sig);
  });
}

/** The group of a link's body, validated: null without `group`, or the 400 line. */
function groupOf(raw: unknown): { pattern: string | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { pattern: null };
  const pattern = validPageGroupPattern(raw);
  return pattern === null ? { error: GROUP_PATTERN_REFUSAL } : { pattern };
}

export async function handleCountPickToken(
  request: Request,
  env: CountPickEnv,
  user: SessionUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "Invalid JSON body" }, env, 400);
  }
  const p = (body ?? {}) as {
    customer_id?: unknown;
    page_path?: unknown;
    group?: unknown;
    scope?: unknown;
  };
  if (typeof p.customer_id !== "string" || p.customer_id === "") {
    return jsonWithCors({ error: "customer_id is required" }, env, 400);
  }
  const scope = requireCustomerScope(user, p.customer_id);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const group = groupOf(p.group);
  if ("error" in group) return jsonWithCors({ error: group.error }, env, 400);
  const site = scopeOf(p.scope);
  if ("error" in site) return jsonWithCors({ error: site.error }, env, 400);
  if (site.scope !== null && group.pattern !== null) {
    return jsonWithCors({ error: SCOPE_AND_GROUP_LINE }, env, 400);
  }

  const customer = await env.DB.prepare("SELECT id, domain FROM customers WHERE id = ?")
    .bind(p.customer_id)
    .first<{ id: string; domain: string }>();
  if (!customer) return jsonWithCors({ error: "Customer not found" }, env, 404);

  // The counted button cannot change while a test runs; say so before the
  // operator spends a minute picking.
  if (await testRunning(env.DB, customer.id)) {
    return jsonWithCors({ error: TEST_LOCK_REASON }, env, 409);
  }
  // No count link while the tag is withheld (readiness-check.md, condition 2).
  const withheld = await tagWithheldRefusal(env.DB, customer.id);
  if (withheld) return jsonWithCors(withheld, env, 409);

  const sent = typeof p.page_path === "string" && p.page_path.trim() !== "" ? p.page_path : null;
  let pagePath = normalizePath(sent);
  if (group.pattern !== null) {
    // The identifier screen on the page the operator opened (privacy review
    // condition 1), as the manifest pick runs it at mint.
    const refusal = pagePathRefusal(sent);
    if (refusal) return jsonWithCors({ error: refusal }, env, 400);
    if (!(await acceptedGroups(env.DB, customer.id)).includes(group.pattern)) {
      return jsonWithCors({ error: GROUP_UNKNOWN_PICK_LINE }, env, 409);
    }
    // The sensitive rule on the pattern, never on the page it opens.
    const kept = await sensitiveGroupRefusal(env.DB, customer.id, group.pattern);
    if (sent === null) {
      // No page sent (a sensitive customer's breakdown names none): the
      // most loaded page the link can open, screened as a sent one is.
      if (kept) return jsonWithCors(kept, env, 409);
      const chosen = await chooseGroupPage(env.DB, customer.id, group.pattern);
      if (chosen === null) {
        return jsonWithCors(
          { error: GROUP_PAGE_NEEDED_LINE, code: GROUP_PAGE_NEEDED_CODE },
          env,
          409,
        );
      }
      const chosenRefusal = pagePathRefusal(chosen);
      if (chosenRefusal) return jsonWithCors({ error: chosenRefusal }, env, 400);
      pagePath = chosen;
    }
    if (!pageGroupMatches(group.pattern, pagePath)) {
      return jsonWithCors({ error: GROUP_PAGE_OUTSIDE_LINE }, env, 409);
    }
    if (kept) return jsonWithCors(kept, env, 409);
  } else if (site.scope !== null) {
    // The identifier screen on the page the operator opens (privacy review
    // condition 1 of page-groups.md), as a group link runs it at mint. No
    // sensitive 409: the target names no page (see the header comment).
    const refusal = pagePathRefusal(sent);
    if (refusal) return jsonWithCors({ error: refusal }, env, 400);
    if ((await siteTargets(env.DB, customer.id)).length >= SITE_TARGETS_MAX) {
      return jsonWithCors({ error: SITE_TARGETS_FULL_LINE }, env, 409);
    }
  } else {
    // A sensitive customer counts a button only on `/` and its kept sections
    // (docs/specs/sensitive-customers.md, condition 2): a click counted on one
    // product page would name that page beside the visit's marker.
    const kept = await sensitivePageRefusal(env.DB, customer.id, pagePath);
    if (kept) return jsonWithCors(kept, env, 409);
  }
  // The current count target (the page's, or the group's), so the picker
  // outlines it. A site link adds a button and seeds nothing.
  const current =
    site.scope !== null
      ? null
      : await storedCount(env.DB, customer.id, countTargetPath(group.pattern ?? pagePath));
  let seed: Manifest = {};
  if (current) {
    try {
      seed = {
        [COUNT_SLOT.path]: {
          css: JSON.parse(current.css_selectors) as string[],
          text: JSON.parse(current.text_selectors) as string[],
          structural: current.structural_selector,
        },
      };
    } catch {
      seed = {};
    }
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  // A pick left from an earlier link must not land under this one.
  await env.VARIANTS.delete(pickCountKey(customer.id, pagePath));
  await env.VARIANTS.put(
    pickTokenKey(token),
    JSON.stringify({
      customer_id: customer.id,
      page_path: pagePath,
      manifest: seed,
      mode: "count",
      ...(group.pattern !== null ? { group: group.pattern } : {}),
      ...(site.scope !== null ? { scope: site.scope } : {}),
    }),
    { expirationTtl: PICK_TTL_S },
  );
  if (group.pattern !== null) {
    await env.VARIANTS.put(pickGroupKey(customer.id, group.pattern), pagePath, {
      expirationTtl: PICK_TTL_S,
    });
  }
  if (site.scope !== null) {
    await env.VARIANTS.put(pickSiteKey(customer.id), pagePath, { expirationTtl: PICK_TTL_S });
  }
  return jsonWithCors(
    {
      token,
      page_path: pagePath,
      ...(group.pattern !== null ? { group: group.pattern } : {}),
      ...(site.scope !== null ? { scope: site.scope } : {}),
      expires_in_s: PICK_TTL_S,
      link: siteLink(customer.domain, pagePath, token),
    },
    env,
    200,
  );
}

export async function handleCountPickStatus(
  request: Request,
  env: CountPickEnv,
  user: SessionUser,
): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  const group = groupOf(url.searchParams.get("group"));
  if ("error" in group) return jsonWithCors({ error: group.error }, env, 400);
  const site = scopeOf(url.searchParams.get("scope"));
  if ("error" in site) return jsonWithCors({ error: site.error }, env, 400);
  if (site.scope !== null && group.pattern !== null) {
    return jsonWithCors({ error: SCOPE_AND_GROUP_LINE }, env, 400);
  }
  if (group.pattern !== null) return groupPickStatus(env, customerId, group.pattern, url);
  if (site.scope !== null) return sitePickStatus(env, customerId, url);

  const pagePath = normalizePath(url.searchParams.get("page_path"));
  const key = pickCountKey(customerId, pagePath);

  // A pick minted before the customer was marked sensitive never lands on a
  // page outside its kept sections (condition 2): it is dropped unread.
  const kept = await sensitivePageRefusal(env.DB, customerId, pagePath);
  if (kept) {
    await env.VARIANTS.delete(key);
    return jsonWithCors(kept, env, 409);
  }

  const raw = await env.VARIANTS.get(key);
  if (raw === null) return jsonWithCors({ landed: false, page_path: pagePath }, env, 200);

  const pick = readPick(raw);
  if (pick === null) {
    await env.VARIANTS.delete(key);
    return jsonWithCors({ error: "picked button unreadable" }, env, 500);
  }

  // The page the button was picked on is the one stored: checked as well.
  const pickedKept = await sensitivePageRefusal(env.DB, customerId, pick.page_path);
  if (pickedKept) {
    await env.VARIANTS.delete(key);
    return jsonWithCors(pickedKept, env, 409);
  }

  const sectionPath = countTargetPath(pick.page_path);
  const css = JSON.stringify(pick.css);
  const text = JSON.stringify(pick.text);
  const existing = await storedCount(env.DB, customerId, sectionPath);

  if (await testRunning(env.DB, customerId)) {
    // Passes only when it is the button already counted, alone.
    const items = await listTargetResponses(env.DB, customerId);
    const same =
      existing !== null &&
      Number(existing.enabled) === 1 &&
      existing.css_selectors === css &&
      existing.text_selectors === text &&
      existing.structural_selector === pick.structural &&
      items.every((t) => t.enabled === (t.id === existing.id));
    await env.VARIANTS.delete(key);
    if (!same) return jsonWithCors({ error: TEST_LOCK_REASON }, env, 409);
    const target = items.find((t) => t.id === existing.id) ?? null;
    return jsonWithCors({ landed: true, page_path: pick.page_path, target, items }, env, 200);
  }

  await upsertCount(env.DB, customerId, sectionPath, pick);
  const row = await storedCount(env.DB, customerId, sectionPath);
  if (!row) return jsonWithCors({ error: "Pick saved but row not found" }, env, 500);
  // One counted, the rest off; the bundle is rewritten inside.
  await countOnly(env, customerId, row.id);
  await env.VARIANTS.delete(key);

  const items = await listTargetResponses(env.DB, customerId);
  const target = items.find((t) => t.id === row.id) ?? null;
  return jsonWithCors({ landed: true, page_path: pick.page_path, target, items }, env, 200);
}

/** The edge validated it; validate again before it reaches D1. */
function readPick(raw: string): CountPick | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CountPick>;
    return validateCountPick(
      { css: parsed.css, text: parsed.text, structural: parsed.structural },
      parsed.page_path,
    );
  } catch {
    return null;
  }
}

/**
 * Where a picked button goes (readiness-check.md, check 2), from what the
 * picker posts: a `tel:` or `mailto:` selector or a phone or address as its
 * words is `contact_link`; a button or input whose structural description
 * puts it in a form is `form`. The picker posts no href, so any other link
 * is not known and stays NULL.
 */
export function pickGoes(pick: CountPick): Goes | null {
  if (contactKindOf(pick.text[0] ?? "", pick.css) !== null) return "contact_link";
  if (/^(?:first|\d+(?:st|nd|rd|th)) (?:button|input) in form$/.test(pick.structural))
    return "form";
  return null;
}

/**
 * The button's own words name it; a button without words names its page.
 * The closed kind follows the words too (a Send button is `contact`), so a
 * re-pick sets it again; the dashboard can change it after. Enabled.
 */
async function upsertCount(
  db: D1Database,
  customerId: string,
  sectionPath: string,
  pick: CountPick,
  labelWithoutWords = `Button on ${pick.page_path}`,
  /** A label in place of the words, with its kind (a site link's phone or email). */
  named: { label: string; kind: ConversionLabel } | null = null,
): Promise<void> {
  const label = named?.label ?? pick.text[0] ?? labelWithoutWords;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO conversion_targets
       (customer_id, section_path, label, conversion_label, enabled,
        css_selectors, text_selectors, structural_selector, goes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id, section_path) DO UPDATE SET
       label = excluded.label,
       conversion_label = excluded.conversion_label,
       enabled = 1,
       css_selectors = excluded.css_selectors,
       text_selectors = excluded.text_selectors,
       structural_selector = excluded.structural_selector,
       goes = excluded.goes,
       updated_at = excluded.updated_at`,
    )
    .bind(
      customerId,
      sectionPath,
      label,
      named?.kind ?? conversionLabelOf(label),
      JSON.stringify(pick.css),
      JSON.stringify(pick.text),
      pick.structural,
      pickGoes(pick),
      now,
      now,
    )
    .run();
}

/**
 * pick-status for a group link: the pick landed under the page the link
 * opened (kept at `pickGroupKey`; `page_path` in the query names it too).
 * The picked page must be one of the group's; the pick becomes the group's
 * target and is ADDED to the counted buttons, nothing switched off.
 */
async function groupPickStatus(
  env: CountPickEnv,
  customerId: string,
  pattern: string,
  url: URL,
): Promise<Response> {
  const sectionPath = countTargetPath(pattern);
  const groupKey = pickGroupKey(customerId, pattern);
  const answer = (body: Record<string, unknown>, status = 200) =>
    jsonWithCors({ ...body, group: pattern }, env, status);

  if (!(await acceptedGroups(env.DB, customerId)).includes(pattern)) {
    return answer({ error: GROUP_UNKNOWN_PICK_LINE }, 409);
  }
  // The sensitive rule on the pattern; a pick minted before the mark is dropped.
  const kept = await sensitiveGroupRefusal(env.DB, customerId, pattern);
  if (kept) {
    await env.VARIANTS.delete(groupKey);
    return answer({ ...kept }, 409);
  }

  const queried = url.searchParams.get("page_path");
  const opened = queried !== null ? normalizePath(queried) : await env.VARIANTS.get(groupKey);
  if (opened === null) return answer({ landed: false, page_path: null });
  const key = pickCountKey(customerId, opened);
  const raw = await env.VARIANTS.get(key);
  if (raw === null) return answer({ landed: false, page_path: opened });

  const pick = readPick(raw);
  if (pick === null) {
    await env.VARIANTS.delete(key);
    return answer({ error: "picked button unreadable" }, 500);
  }
  // Picked on one of the group's pages (the identifier screen ran on it in
  // validateCountPick, condition 1); a button named by aria-label alone in
  // the header or nav is refused (condition 3).
  if (!pageGroupMatches(pattern, pick.page_path)) {
    await env.VARIANTS.delete(key);
    return answer({ error: GROUP_PAGE_OUTSIDE_LINE, page_path: pick.page_path }, 409);
  }
  if (groupPickAriaOnly(pick)) {
    await env.VARIANTS.delete(key);
    return answer({ error: GROUP_ARIA_ONLY_LINE, page_path: pick.page_path }, 409);
  }

  const existing = await storedCount(env.DB, customerId, sectionPath);
  const counts = (await groupAggregate(env.DB, customerId)).groups;
  if (await testRunning(env.DB, customerId)) {
    // Passes only when it is the group's button already counted, unchanged.
    const same =
      existing !== null &&
      Number(existing.enabled) === 1 &&
      existing.css_selectors === JSON.stringify(pick.css) &&
      existing.text_selectors === JSON.stringify(pick.text) &&
      existing.structural_selector === pick.structural;
    await env.VARIANTS.delete(key);
    await env.VARIANTS.delete(groupKey);
    if (!same) return answer({ error: TEST_LOCK_REASON }, 409);
    const items = markGroupTargets(await listTargetResponses(env.DB, customerId), counts);
    const target = items.find((t) => t.id === existing.id) ?? null;
    return answer({ landed: true, page_path: pick.page_path, target, items });
  }

  await upsertCount(env.DB, customerId, sectionPath, pick, `Button on ${pattern}`);
  const row = await storedCount(env.DB, customerId, sectionPath);
  if (!row) return answer({ error: "Pick saved but row not found" }, 500);
  // Added to the counted buttons: the others stay as they are. The bundle
  // carries the new target.
  await writeVisitorBundle(env, customerId);
  await env.VARIANTS.delete(key);
  await env.VARIANTS.delete(groupKey);

  const items = markGroupTargets(await listTargetResponses(env.DB, customerId), counts);
  const target = items.find((t) => t.id === row.id) ?? null;
  return answer({ landed: true, page_path: pick.page_path, target, items });
}

type SiteRow = StoredCount & { section_path: string };

/** The customer's `site:` rows. */
async function siteTargets(db: D1Database, customerId: string): Promise<SiteRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, section_path, enabled, css_selectors, text_selectors, structural_selector
       FROM conversion_targets WHERE customer_id = ? ORDER BY created_at ASC`,
    )
    .bind(customerId)
    .all<SiteRow>();
  return (rows.results ?? []).filter((r) => isSiteTarget(r.section_path));
}

/**
 * pick-status for a site link: the pick landed under the page the link
 * opened (kept at `pickSiteKey`; `page_path` in the query names it too).
 * The pick becomes one `site:{slug}` target, enabled, ADDED to the counted
 * buttons; a re-pick of a button already stored updates its row. The
 * the privacy review's screens as for a group link: the identifier screen on the
 * picked page and the account-style words in `validateCountPick`
 * (`readPick`), a header or nav button named by aria-label alone refused.
 */
async function sitePickStatus(env: CountPickEnv, customerId: string, url: URL): Promise<Response> {
  const siteKey = pickSiteKey(customerId);
  const answer = (body: Record<string, unknown>, status = 200) =>
    jsonWithCors({ ...body, scope: "site" }, env, status);

  const queried = url.searchParams.get("page_path");
  const opened = queried !== null ? normalizePath(queried) : await env.VARIANTS.get(siteKey);
  if (opened === null) return answer({ landed: false, page_path: null });
  const key = pickCountKey(customerId, opened);
  const raw = await env.VARIANTS.get(key);
  if (raw === null) return answer({ landed: false, page_path: opened });

  const pick = readPick(raw);
  if (pick === null) {
    await env.VARIANTS.delete(key);
    return answer({ error: "picked button unreadable" }, 500);
  }
  if (groupPickAriaOnly(pick)) {
    await env.VARIANTS.delete(key);
    return answer({ error: GROUP_ARIA_ONLY_LINE, page_path: pick.page_path }, 409);
  }
  if (!sitePlacementAdmits(pick)) {
    await env.VARIANTS.delete(key);
    await env.VARIANTS.delete(siteKey);
    return answer({ error: SITE_PLACEMENT_LINE, page_path: pick.page_path }, 400);
  }

  // A sensitive customer is not refused here: the row names no page, and a
  // click on this button is stored by the existing rule at /event (a product
  // page as its group or `/:item`), the same as for a hand-typed selector.
  const css = JSON.stringify(pick.css);
  const text = JSON.stringify(pick.text);
  const rows = await siteTargets(env.DB, customerId);
  const same =
    rows.find(
      (r) =>
        r.css_selectors === css &&
        r.text_selectors === text &&
        r.structural_selector === pick.structural,
    ) ?? null;

  if (await testRunning(env.DB, customerId)) {
    // Passes only when it is a site button already counted, unchanged.
    await env.VARIANTS.delete(key);
    await env.VARIANTS.delete(siteKey);
    if (same === null || Number(same.enabled) !== 1) {
      return answer({ error: TEST_LOCK_REASON }, 409);
    }
    const items = await markedTargetResponses(env.DB, customerId);
    const target = items.find((t) => t.id === same.id) ?? null;
    return answer({ landed: true, page_path: pick.page_path, target, items });
  }

  let sectionPath: string;
  if (same !== null) {
    sectionPath = same.section_path;
  } else {
    if (rows.length >= SITE_TARGETS_MAX) {
      await env.VARIANTS.delete(key);
      await env.VARIANTS.delete(siteKey);
      return answer({ error: SITE_TARGETS_FULL_LINE }, 409);
    }
    sectionPath = freeSiteTargetPath(
      siteSlugOf(pick.text[0] ?? "", pick.css),
      new Set(rows.map((r) => r.section_path)),
    );
  }
  // A phone number or an address is never the row's name either (condition
  // 1): the label is its kind, and such a link counts as contact.
  const kind = contactKindOf(pick.text[0] ?? "", pick.css);
  await upsertCount(
    env.DB,
    customerId,
    sectionPath,
    pick,
    SITE_LABEL_WITHOUT_WORDS,
    kind === null ? null : { label: CONTACT_LABELS[kind], kind: "contact" },
  );
  const row = await storedCount(env.DB, customerId, sectionPath);
  if (!row) return answer({ error: "Pick saved but row not found" }, 500);
  // Added to the counted buttons: the others stay as they are. The bundle
  // carries the new target, offered on every page by the edge.
  await writeVisitorBundle(env, customerId);
  await env.VARIANTS.delete(key);
  await env.VARIANTS.delete(siteKey);

  const items = await markedTargetResponses(env.DB, customerId);
  const target = items.find((t) => t.id === row.id) ?? null;
  return answer({ landed: true, page_path: pick.page_path, target, items });
}
