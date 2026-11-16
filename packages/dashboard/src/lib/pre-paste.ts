/**
 * The two-part tag on the Pages card (docs/specs/faster-tag.md, step 6,
 * "API contract (generation)"; mock design/mock/sales-readiness/two-part-tag.html,
 * approved 2026-10-26 with the founder's four decisions): only after go
 * live, never on Connect; plain HTML, Webflow and Framer first, Lovable and
 * Next.js "not yet". The calls and the copy, pure where they can be, so the
 * states are tested without a browser.
 */

import type {
  InstallPlatform,
  PreFormId,
  PrePasteResponse,
  PreWhere,
  ProbeResponse,
} from "@/types/api";

/** The founder's line (decision 2). Never "page shows faster". */
export const PRE_LEAD = "Your page appears at once; only the rewritten lines wait.";

/** Privacy review condition 1, word for word, above every style offered. */
export const PRE_CONSENT_LINE =
  "If your Rawuser tag loads only after consent, do not paste the style.";

/** Under "Before you choose" (the privacy review's build ruling). */
export const PRE_BACKSTOP_LINE =
  "If our script does not load, those parts show as built after 1.5 seconds.";

export const PRE_REPASTE_COST_LINE =
  "When the parts Rawuser writes change, you paste a new style. We tell you here.";

export const PRE_STALE_LINE = "Your pasted style is out of date. Paste the new one.";
export const PRE_CURRENT_LINE = "Both parts found. The style is up to date.";
export const PRE_REFUSED_LINE = "Your policy blocks the style. Add the line beside it.";
export const PRE_NONE_LINE = "The style is not on your page yet.";
export const PRE_CHECK_FAILED = "Rawuser could not check your page just now.";

/** Read the answer from the last read of the homepage. Null on any failure. */
export async function readPre(
  customerId: string,
  fetcher: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<PrePasteResponse | null> {
  try {
    const r = await fetcher<PrePasteResponse>(
      `/admin/install/pre?customer_id=${encodeURIComponent(customerId)}`,
    );
    return r && typeof r.available === "boolean" ? r : null;
  } catch {
    return null;
  }
}

/** Read the homepage now; the answer carries the exact policy lines. Null on failure. */
export async function checkPre(
  customerId: string,
  fetcher: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<PrePasteResponse | null> {
  try {
    const r = await fetcher<PrePasteResponse>("/admin/install/pre/check", {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId }),
    });
    return r && typeof r.available === "boolean" ? r : null;
  } catch {
    return null;
  }
}

const FORM_NAMES: Record<PreFormId, string> = {
  html: "Plain HTML",
  webflow: "Webflow",
  framer: "Framer",
  lovable: "Lovable",
  nextjs: "Next.js",
};

export function formName(id: PreFormId): string {
  return FORM_NAMES[id];
}

const PLATFORM_NAMES: Partial<Record<InstallPlatform, string>> = {
  lovable: "Lovable",
  nextjs: "Next.js",
  vercel: "Vercel",
  wordpress: "WordPress",
  wix: "Wix",
  squarespace: "Squarespace",
  shopify: "Shopify",
};

/** One step per `where` word. The words are the API's; the steps are ours. */
export const WHERE_STEPS: Record<PreWhere, string> = {
  head_first: "Paste both parts first inside `<head>`, after `<meta charset>`, style first.",
  head_code:
    "Paid plan: Site settings, Custom code, Head code. Both parts as the first lines, style first.",
  body_embed_top:
    "Free plan: a Code Embed at the very top of the body, above the hero. Both parts, style first.",
  start_of_head:
    "Site settings, General, Custom code, Start of `<head>`. Both parts in one script, style first.",
};

export type PreView =
  /** Nothing on the card: not live, an audit, an ended customer, no parts. */
  | { kind: "hidden" }
  /** The detected platform does not take it yet (decision 3). */
  | { kind: "not_yet"; platform: string }
  /** The offer: no paste on the page, or no read yet. */
  | { kind: "offer" }
  | { kind: "current" }
  | { kind: "stale" };

/** Which of the card's states the answer is. */
export function preView(a: PrePasteResponse | null): PreView {
  if (!a || !a.available || !a.paste) return { kind: "hidden" };
  if (a.stale || a.state === "stale") return { kind: "stale" };
  if (a.state === "current") return { kind: "current" };
  if (a.platform.ready === false) {
    const d = a.platform.detected;
    return { kind: "not_yet", platform: (d && PLATFORM_NAMES[d]) ?? "your platform" };
  }
  return { kind: "offer" };
}

/**
 * The policy line to show beside the style: only when the API says the
 * site needs it and a check has read the exact lines. Never a bare
 * `style-src` built here (it would refuse the site's other styles).
 */
export function preCspLines(a: PrePasteResponse | null): string[] {
  const csp = a?.csp;
  if (!csp || csp.needed !== true || !csp.lines_read) return [];
  return csp.lines.filter((l) => typeof l === "string" && l.length > 0);
}

/** True when a check must run before the policy line can be said (needed true or unknown). */
export function preNeedsCheck(a: PrePasteResponse | null): boolean {
  const csp = a?.csp;
  if (!csp) return false;
  return csp.needed !== false && !csp.lines_read;
}

/** The status line under the paste, or null where there is nothing to say. */
export function preStatus(
  a: PrePasteResponse | null,
): { tone: "ok" | "warn" | "muted"; text: string } | null {
  if (!a?.available) return null;
  if (a.state === "stale") return { tone: "warn", text: PRE_STALE_LINE };
  if (a.csp?.refused) return { tone: "warn", text: PRE_REFUSED_LINE };
  if (a.state === "current") return { tone: "ok", text: PRE_CURRENT_LINE };
  if (a.state === "none") return { tone: "muted", text: PRE_NONE_LINE };
  return null;
}

/** The forms to choose between, the detected one first chosen; "not yet" ones shown greyed. */
export function preForms(a: PrePasteResponse): {
  chosen: PreFormId;
  forms: { id: PreFormId; name: string; ready: boolean; where: PreWhere[] }[];
} {
  const forms = a.platforms.map((p) => ({
    id: p.id,
    name: formName(p.id),
    ready: p.status === "ready",
    where: [...p.where],
  }));
  const chosen = a.platform.form ?? "html";
  return { chosen, forms };
}

/**
 * The probe's tag condition with the two-part tag in mind: a current paste
 * makes `async` the two-part tag, not the late-tag warning (contract: hide
 * that amber line when `state` is `current`).
 */
export function withoutPreAsync(r: ProbeResponse): ProbeResponse {
  if (r.pre?.state !== "current" || !r.install) return r;
  const flags = r.install.tag_flags.filter((f) => f !== "async");
  if (flags.length === r.install.tag_flags.length) return r;
  return { ...r, install: { ...r.install, tag_flags: flags } };
}
