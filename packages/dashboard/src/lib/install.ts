/**
 * The install wording (docs/specs/install-friction.md B, C, D, G; mock
 * design/mock/sales-readiness/install-friction.html, approved 2026-10-04).
 *
 * Pure functions over the probe's answer, so the Connect screen, TagStatus
 * on /onboard, the 45-second line, the apply done screen and the Pages card
 * say the same thing, and the copy is tested without a browser.
 *
 * Text marks code with backticks: "Open `app/layout.tsx`". The screens
 * render those spans in the mono face (components/onboard/Codey.tsx).
 */

import type {
  CspWhere,
  InstallCsp,
  InstallFacts,
  InstallHosting,
  InstallPlatform,
  ProbeResponse,
  TagFlag,
  TagPosition,
} from "@/types/api";
import { olderTagScript, operatorDoes, operatorOrUs } from "./identity";
import { withoutPreAsync } from "./pre-paste";

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

const NAME: Record<InstallPlatform, string> = {
  webflow: "Webflow",
  framer: "Framer",
  wix: "Wix",
  squarespace: "Squarespace",
  shopify: "Shopify",
  wordpress: "WordPress",
  lovable: "Lovable",
  nextjs: "Next.js",
  vercel: "Vercel",
  other: "plain HTML",
};

/** "Webflow", "Next.js". */
export function platformName(p: InstallPlatform): string {
  return NAME[p];
}

/** The row in the platform list. */
export function pickerLabel(p: InstallPlatform): string {
  if (p === "vercel") return "Vercel, without Next.js";
  if (p === "other") return "Something else, or plain HTML";
  return NAME[p];
}

/** The order of the platform list, the probe's guess on top. */
const PICKER_ORDER: InstallPlatform[] = [
  "webflow",
  "framer",
  "lovable",
  "nextjs",
  "wordpress",
  "shopify",
  "wix",
  "squarespace",
  "vercel",
  "other",
];

export function pickerOrder(guess: InstallPlatform | null): InstallPlatform[] {
  if (!guess || guess === "other") return PICKER_ORDER;
  return [guess, ...PICKER_ORDER.filter((p) => p !== guess)];
}

/** "We see a Webflow site." Null when the probe saw nothing it can name. */
export function seenLine(p: InstallPlatform, hosting: InstallHosting | null): string | null {
  if (p === "other") return null;
  if (p === "vercel") return "We see a site on Vercel.";
  if (p === "nextjs" && hosting === "vercel") return "We see a Next.js site on Vercel.";
  return `We see a ${NAME[p]} site.`;
}

/** "Not Webflow?" opens the platform list. */
export function notLine(p: InstallPlatform | null): string {
  if (!p || p === "other") return "Pick your platform";
  if (p === "vercel") return "Not on Vercel?";
  return `Not ${NAME[p]}?`;
}

/** One letter in the small square before the platform line. */
export function platformMark(p: InstallPlatform): string {
  return NAME[p].charAt(0).toUpperCase();
}

export type WebflowPlan = "paid" | "free";

/**
 * Webflow cannot tell us the plan, so the customer picks it. Free is
 * preselected until the tag is found; a tag found in the head selects
 * Paid by itself (mock, call 4).
 */
export function defaultWebflowPlan(position: TagPosition | null | undefined): WebflowPlan {
  return position === "head_first" || position === "head_late" ? "paid" : "free";
}

export interface ConnectSteps {
  /** The step's heading, which follows where the tag goes. */
  heading: string;
  steps: string[];
  /** One short sentence on what this place costs, or what the plan needs. */
  cost: string | null;
  /** A caveat behind a disclosure: the summary and the one line it opens. */
  more: { summary: string; text: string } | null;
  /** Lovable: the customer sends a message, not a bare tag. */
  message: boolean;
}

const HEAD_HEADING = "Paste this line into your site's `<head>`";

/** Step 1 of Connect for a platform (spec D, "Steps per platform"). */
export function connectSteps(p: InstallPlatform | null, plan: WebflowPlan = "free"): ConnectSteps {
  switch (p) {
    case "webflow":
      return plan === "free"
        ? {
            heading: "Put this line at the top of your page's body",
            steps: [
              "In the Designer, open the page Rawuser should change.",
              "Drag a Code Embed to the very top of the body, above the nav and everything else.",
              "Paste the line below into it, save, and Publish.",
            ],
            cost: "The free plan has no head code. At the top of the body nothing flashes, as long as nothing sits above the Embed.",
            more: {
              summary: "More than one page?",
              text: "Repeat on each page Rawuser changes, or put the Embed in a Symbol at the top of every page.",
            },
            message: false,
          }
        : {
            heading: HEAD_HEADING,
            steps: [
              "Open Site settings, then Custom code.",
              "Paste the line as the first line of Head code.",
              "Save, then Publish.",
            ],
            cost: null,
            more: null,
            message: false,
          };
    case "framer":
      return {
        heading: HEAD_HEADING,
        steps: [
          "Open Settings, then Code, then Add script.",
          "Set Placement to Start of `<head>` and Run to Once, paste the line, then Add.",
          "Publish.",
        ],
        cost: null,
        more: null,
        message: false,
      };
    case "wix":
      return {
        heading: HEAD_HEADING,
        steps: [
          "Open Settings, then Custom code, and choose Add code.",
          "Paste the line. Set it to load once, on all pages, in Head.",
          "Apply, then Publish.",
        ],
        cost: "Wix may ask for a Premium plan with a connected domain first.",
        more: null,
        message: false,
      };
    case "squarespace":
      return {
        heading: HEAD_HEADING,
        steps: [
          "Open Settings, Advanced, then Code injection.",
          "Paste the line as the first line of Header.",
          "Save.",
        ],
        cost: "Code injection needs the Core plan or above.",
        more: null,
        message: false,
      };
    case "shopify":
      return {
        heading: HEAD_HEADING,
        steps: [
          "Open Online Store, Themes, then Edit code.",
          "Open `layout/theme.liquid` and paste the line right after `<head>`.",
          "Save.",
        ],
        cost: null,
        more: null,
        message: false,
      };
    case "wordpress":
      return {
        heading: HEAD_HEADING,
        steps: [
          "Add the line with a header plugin such as WPCode, at the highest priority, or right after `<head>` in `header.php`.",
          "Using WP Rocket, LiteSpeed or Autoptimize? Exclude this script from delay and combine.",
          "Save and clear the site's cache.",
        ],
        cost: "On WordPress.com, the WPCode plugin needs the Personal plan or above.",
        more: null,
        message: false,
      };
    case "lovable":
      return {
        heading: "Ask Lovable to add this line",
        steps: [
          "Copy the message below, with the tag in it.",
          "Paste it into Lovable's chat and send.",
          "Publish when Lovable is done.",
        ],
        cost: null,
        more: null,
        message: true,
      };
    case "nextjs":
      return {
        heading: HEAD_HEADING,
        steps: [
          "Open `app/layout.tsx` (or `pages/_document.tsx` on the Pages Router).",
          "Paste it first inside `<head>` as a plain script tag, not `next/script`, which runs late.",
          "Deploy.",
        ],
        cost: null,
        more: null,
        message: false,
      };
    case "vercel":
    case "other":
      return {
        heading: HEAD_HEADING,
        steps: [
          "Open the HTML of the page Rawuser should change, often `index.html` or a layout.",
          "Paste the line first inside `<head>`, exactly as written, without async or defer.",
          "Publish or deploy.",
        ],
        cost: null,
        more: null,
        message: false,
      };
    default:
      return {
        heading: HEAD_HEADING,
        steps: [],
        cost: null,
        more: null,
        message: false,
      };
  }
}

/** What the customer pastes into Lovable's chat. */
export function lovableMessage(tag: string): string {
  return `Add this script as the first line inside <head> in index.html, exactly as written, without async or defer:\n${tag}`;
}

/** Lovable, the older async tag: swap it for the new one. */
export function lovableSwapMessage(tag: string): string {
  return `In index.html, remove the script tag that loads ${olderTagScript()}. Add this script as the first line inside <head>, exactly as written, without async or defer:\n${tag}`;
}

// ---------------------------------------------------------------------------
// The security policy
// ---------------------------------------------------------------------------

/**
 * sha256 of the snippet's one hide style; the probe adds it to style-src when
 * the policy blocks the style element (packages/generation/src/lib/csp.ts).
 */
export const HIDE_STYLE_HASH = "'sha256-uUswyaXbEHXp14LMbwYoLUMHybPzmIVetSQk2E7czKY='";

/** Where the customer puts their page's nonce in the tag (same word as the probe's line). */
export const NONCE_PLACEHOLDER = "YOUR-PAGE-NONCE";

/**
 * The tag with a nonce slot, after data-cfasync, as the probe writes it for
 * plain HTML (generation `nonceTagLine`). Used only when an older worker
 * answers a nonce style policy with no line.
 */
export function nonceTag(tag: string): string {
  const after = '<script data-cfasync="false" ';
  return tag.startsWith(after)
    ? tag.replace(after, `${after}nonce="${NONCE_PLACEHOLDER}" `)
    : tag.replace("<script ", `<script nonce="${NONCE_PLACEHOLDER}" `);
}

const COUNT_WORD = ["No", "One", "Two", "Three", "Four", "Five", "Six"];

/** "Two lines for your policy", "One line for your policy". */
export function linesLabel(n: number, tail = " for your policy"): string {
  const word = COUNT_WORD[n] ?? String(n);
  return `${word} line${n === 1 ? "" : "s"}${tail}`;
}

/** Lowercase count for running text: "two lines". */
export function linesWord(n: number): string {
  const word = (COUNT_WORD[n] ?? String(n)).toLowerCase();
  return `${word} line${n === 1 ? "" : "s"}`;
}

/**
 * Where the policy most likely lives (spec B, "Where the policy lives"), in
 * one short line. The platform line above already names the platform.
 */
export function whereText(where: CspWhere | null, n: number): string {
  const keep = n === 1 ? "Change this line, keep the rest." : "Change these lines, keep the rest.";
  switch (where) {
    case "next_config":
      return `Most likely in \`next.config.js\`, inside \`async headers()\`. ${keep}`;
    case "next_middleware":
      return `Your policy carries a nonce, so most likely in \`middleware.ts\`. ${keep}`;
    case "next_layout":
      return "In `app/layout.tsx`, read the nonce from the request headers and put it on the tag, first inside `<head>`.";
    case "vercel_json":
      return `Most likely in \`vercel.json\`, under \`headers\`. ${keep}`;
    case "netlify_headers":
      return `In \`_headers\` in your publish folder, under \`/*\`. ${keep}`;
    case "cloudflare_headers":
      return `In \`_headers\` at the root of your build output, under \`/*\`. ${keep}`;
    case "meta_tag":
      return `In the policy's \`<meta>\` tag in your page's HTML. ${keep}`;
    default:
      return `In your site's Content-Security-Policy header. ${keep}`;
  }
}

/** True when the line carries our hash (the hide style). */
export function isHashLine(line: string): boolean {
  return /'sha256-/.test(line);
}

/** True when the line is the tag itself (a nonce policy), not a directive. */
export function isTagLine(line: string): boolean {
  return line.trimStart().startsWith("<script");
}

/**
 * The caveats about a policy that need no change today (spec B and C), one
 * short sentence each, shown behind a disclosure.
 */
export function policyNotes(csp: InstallCsp | null | undefined): string[] {
  if (!csp) return [];
  const out: string[] = [];
  if (csp.notes.includes("frames_blocked"))
    out.push("It blocks frames, so Rawuser picks lengths by characters, not by your page's lines.");
  if (csp.notes.includes("style_attr_blocked"))
    out.push("It blocks inline styles, so a headline built word by word may lose its entrance.");
  if (csp.notes.includes("trusted_types") || csp.verdict.trusted_types)
    out.push(
      "It requires Trusted Types, so the picker cannot run yet. Write to us if you need it.",
    );
  return out;
}

// ---------------------------------------------------------------------------
// The tag's state (TagStatus)
// ---------------------------------------------------------------------------

export type LateCause =
  | "older"
  | "async"
  | "defer"
  | "module"
  | "gtm"
  | "rocket_loader"
  | "body_late"
  | "blocking_script_before";

/**
 * Why the tag runs after the page appears, the strongest cause first, or
 * null when it runs in time. The older generic tag has no hide rules, so
 * it is late whatever its attributes.
 */
export function lateCause(
  position: TagPosition | null | undefined,
  flags: TagFlag[] | null | undefined,
  tagForm: "script" | "generic" | null | undefined,
): LateCause | null {
  const f = new Set(flags ?? []);
  if (f.has("gtm")) return "gtm";
  if (position === "not_found" || !position) return null;
  if (f.has("rocket_loader")) return "rocket_loader";
  if (tagForm === "generic") return "older";
  if (f.has("async")) return "async";
  if (f.has("defer")) return "defer";
  if (f.has("module")) return "module";
  if (position === "body_late") return "body_late";
  if (f.has("blocking_script_before")) return "blocking_script_before";
  return null;
}

export type Tone = "ok" | "warn" | "err";

export type TagCondition =
  | { kind: "found"; tone: "ok"; line: string }
  | { kind: "runs"; tone: "ok"; line: string; meta: string | null }
  | { kind: "missing"; tone: "warn"; line: string }
  | { kind: "other_customer"; tone: "err"; line: string }
  | { kind: "unreachable"; tone: "warn"; line: string; meta: string }
  | { kind: "off_host"; tone: "warn"; line: string; meta: string }
  | { kind: "bot_protection"; tone: "warn"; line: string; note: string }
  | { kind: "blocked"; tone: "err"; line: string; body: string; found: boolean }
  | { kind: "hash_only"; tone: "err"; line: string; body: string }
  | { kind: "needs_nonce"; tone: "err"; line: string; body: string }
  | { kind: "report_only"; tone: "warn"; line: string; body: string }
  | { kind: "degrades"; tone: "warn"; line: string; body: string; nonce: boolean }
  | { kind: "late"; tone: "warn"; line: string; body: string; cause: LateCause };

function inHtml(r: ProbeResponse): boolean {
  return r.status === "active" || r.status === "stale" || r.status === "never";
}

function otherCustomer(r: ProbeResponse): boolean {
  return r.status === "removed" && /another customer/i.test(r.reason);
}

function attrName(cause: "async" | "defer" | "module"): string {
  return cause === "module" ? '`type="module"`' : `\`${cause}\``;
}

function lateLine(cause: LateCause, domain: string): string {
  switch (cause) {
    case "gtm":
      return "Tag runs through Google Tag Manager.";
    case "rocket_loader":
      return `Tag found on ${domain}, but Cloudflare Rocket Loader delays it.`;
    case "body_late":
      return `Tag found on ${domain}, but it sits at the end of your page.`;
    case "blocking_script_before":
      return `Tag found on ${domain}, but a script above it in the head delays it.`;
    default:
      return `Tag found on ${domain}, but it runs after your page appears.`;
  }
}

/**
 * A page painted before the tag ran stays as built for that load (the
 * founder's yes of 2026-10-12, docs/specs/late-tag.md): nothing changes
 * under a reader's eyes. Until then the words were swapped in place.
 */
function lateBody(
  cause: LateCause,
  platform: InstallPlatform | null,
  flags: TagFlag[] | null | undefined,
): string {
  switch (cause) {
    case "older": {
      const asy = (flags ?? []).includes("async") ? " with `async`" : "";
      const fix =
        platform === "lovable"
          ? "Ask Lovable to swap it for the new one."
          : "Replace it with this one, first inside `<head>`.";
      return `It is the older tag${asy}, so your page can appear first and then stays as you built it. ${fix}`;
    }
    case "async":
    case "defer":
    case "module":
      return `With ${attrName(cause)}, your page can appear first and then stays as you built it. Remove ${cause === "module" ? "it" : "the attribute"} and keep the tag first inside \`<head>\`.`;
    case "gtm":
      return "It works, but your page can appear first and then stays as you built it. Move the tag from Tag Manager to the head.";
    case "rocket_loader":
      return "Your page can appear first and then stays as you built it. This tag asks Rocket Loader to leave it alone.";
    case "body_late":
      return platform === "webflow"
        ? "Your hero is drawn first, so those visits see your page as you built it. Move the Code Embed to the very top of the body."
        : "Your hero is drawn first, so those visits see your page as you built it. Move the line first inside `<head>`, without async.";
    case "blocking_script_before":
      return "That script downloads first, so on a slow connection your page can appear first and stay as you built it. Move the tag above it.";
  }
}

/**
 * The one state the tag line shows, the most serious first: another
 * customer's tag, a policy that stops it, then whether it is found, runs
 * late, or will be stopped later.
 */
export function tagCondition(probe: ProbeResponse, domain: string): TagCondition {
  // A current two-part paste makes `async` the two-part tag, not a late tag.
  const r = withoutPreAsync(probe);
  const install = r.install ?? null;
  const csp = install?.csp ?? null;
  const found = inHtml(r);
  const runs = r.tag_runs === true;

  if (otherCustomer(r)) {
    return {
      kind: "other_customer",
      tone: "err",
      line: `A Rawuser tag is on ${domain}, but with a different customer id. Paste this one.`,
    };
  }

  if (csp?.blocks) {
    const script = csp.verdict.enforced?.script;
    const on = found ? `Tag found on ${domain}, but your` : "Your";
    if (script === "hash_only" || csp.notes.includes("hash_only")) {
      return {
        kind: "hash_only",
        tone: "err",
        line: `${on} security policy only runs scripts it knows by hash.`,
        body: `A hash cannot cover Rawuser's tag, because it changes each time you confirm a page. Write to ${operatorOrUs()} and we find the way in with you.`,
      };
    }
    if (script === "needs_nonce") {
      return {
        kind: "needs_nonce",
        tone: "err",
        line: `${on} security policy runs only scripts that carry its nonce.`,
        body: "The browser refuses the tag without it, so visitors see your page as built. Put the page's nonce on the tag.",
      };
    }
    const n = linesWord(csp.lines.length);
    return found || runs
      ? {
          kind: "blocked",
          tone: "err",
          found: true,
          line: `Tag found on ${domain}, but your site's security policy blocks it.`,
          body: `The browser refuses to run it, so visitors see your page as built. Add Rawuser's address to ${n} of the policy.`,
        }
      : {
          kind: "blocked",
          tone: "err",
          found: false,
          line: `Not on ${domain} yet, and your site's security policy would block it.`,
          body: `Once the tag is on, the browser would refuse it. Add Rawuser's address to ${n} of the policy too.`,
        };
  }

  if (
    r.status === "unknown" ||
    r.read === "failed" ||
    r.read === "bot_protection" ||
    r.read === "off_host"
  ) {
    if (runs) {
      return {
        kind: "runs",
        tone: "ok",
        line: `Tag runs on ${domain}. Your page reached Rawuser.`,
        meta: null,
      };
    }
    if (r.read === "off_host") {
      return {
        kind: "off_host",
        tone: "warn",
        line: `${domain} redirects to another site.`,
        meta: "Rawuser reads only your own addresses.",
      };
    }
    if (r.read === "bot_protection" || /bot protection/i.test(r.reason)) {
      return {
        kind: "bot_protection",
        tone: "warn",
        line: "Your site's bot protection turned our check away.",
        note: "So we cannot see the tag from here. Paste it, then open your page in step 2. If the tag runs, this turns green.",
      };
    }
    return {
      kind: "unreachable",
      tone: "warn",
      line: `Could not read ${domain}.`,
      meta: "Is the site public and up?",
    };
  }

  const cause = lateCause(install?.tag_position, install?.tag_flags, r.tag_form ?? null);
  if (cause && (found || (cause === "gtm" && runs))) {
    return {
      kind: "late",
      tone: "warn",
      cause,
      line: lateLine(cause, domain),
      body: lateBody(cause, install?.platform ?? null, install?.tag_flags),
    };
  }

  if (!found) {
    if (runs) {
      return {
        kind: "runs",
        tone: "ok",
        line: `Tag runs on ${domain}.`,
        meta: "Not in the page's HTML, but it reached Rawuser.",
      };
    }
    return { kind: "missing", tone: "warn", line: `Not on ${domain} yet.` };
  }

  if (csp?.report_only_blocks) {
    return {
      kind: "report_only",
      tone: "warn",
      line: `Tag found on ${domain}. It runs today, but your policy will block it once switched on.`,
      body: "Your policy only reports breaks for now. Add these lines, so turning it on does not switch Rawuser off.",
    };
  }

  if (csp?.degrades) {
    // On a nonce policy the snippet copies its own nonce to the hide style,
    // so the tag needs the page's nonce. The probe sends the tag with a nonce
    // slot as the line; an older worker sent no line.
    const nonce =
      csp.notes.includes("style_nonce") && (csp.lines.length === 0 || csp.lines.some(isTagLine));
    return {
      kind: "degrades",
      tone: "warn",
      nonce,
      line: `Tag found on ${domain}, but your policy blocks the style that hides what Rawuser rewrites.`,
      body: nonce
        ? "Visitors see your original words for a moment. Put your page's nonce on the tag, and nothing flashes."
        : "Visitors see your original words for a moment. Add the line below, and nothing flashes.",
    };
  }

  const where = install?.tag_position === "body_top" ? ", at the top of the body." : ".";
  return { kind: "found", tone: "ok", line: `Tag found on ${domain}${where}` };
}

/** The lines a condition asks for: policy directives, or the tag with a nonce. */
export function conditionLines(
  c: TagCondition,
  csp: InstallCsp | null | undefined,
  tag?: string,
): string[] {
  if (!csp) return [];
  if (c.kind === "report_only") return csp.report_only_lines;
  if (c.kind === "degrades" && c.nonce) {
    if (csp.lines.length > 0) return csp.lines;
    return tag ? [nonceTag(tag)] : [];
  }
  if (c.kind === "blocked" || c.kind === "needs_nonce" || c.kind === "degrades") return csp.lines;
  return [];
}

/** Where to make the change a condition asks for, in one short line. */
export function conditionWhere(
  c: TagCondition,
  install: InstallFacts | null | undefined,
  n: number,
): string {
  const where = install?.csp.where ?? null;
  const nonceTagAsked = c.kind === "needs_nonce" || (c.kind === "degrades" && c.nonce);
  if (nonceTagAsked && where !== "next_layout") {
    return n > 1
      ? `Put your page's nonce in place of \`${NONCE_PLACEHOLDER}\`, and add the policy line.`
      : `Put your page's nonce in place of \`${NONCE_PLACEHOLDER}\`.`;
  }
  return whereText(where, n);
}

/** Keep polling while the line can still turn green by itself (a deploy, a capture). */
export function keepsChecking(c: TagCondition): boolean {
  return c.kind !== "found" && c.kind !== "runs";
}

/** The tag counts as on the page (step 1 done). */
export function tagIsOn(c: TagCondition): boolean {
  return (
    c.kind === "found" ||
    c.kind === "runs" ||
    c.kind === "late" ||
    c.kind === "report_only" ||
    c.kind === "degrades"
  );
}

// ---------------------------------------------------------------------------
// Step 2: 45 seconds and no capture
// ---------------------------------------------------------------------------

/** How long Connect waits for a capture before it names the likely cause. */
export const CAPTURE_WAIT_MS = 45_000;

export interface WaitLine {
  kind: "blocked" | "missing" | "off_host" | "gtm" | "late" | "fine";
  text: string;
  /** "fine": the capture link goes under the text. */
  showLink: boolean;
}

/**
 * The amber line after 45 seconds, from the last probe. The button under
 * it reads the page from its address, so the line only names the cause.
 */
export function waitLine(r: ProbeResponse | null, domain: string): WaitLine {
  const base = "Nothing came back in 45 seconds.";
  const c = r ? tagCondition(r, domain) : null;
  if (c && (c.kind === "blocked" || c.kind === "needs_nonce" || c.kind === "hash_only")) {
    return {
      kind: "blocked",
      text: `${base} Your security policy blocks the tag (step 1).`,
      showLink: false,
    };
  }
  if (c && c.kind === "late" && c.cause === "gtm") {
    return {
      kind: "gtm",
      text: `${base} Tag Manager loads the tag late, or a blocker stops it. Reload the page once.`,
      showLink: false,
    };
  }
  if (c && c.kind === "late") {
    return {
      kind: "late",
      text: `${base} Your tag runs late and may have missed it. Reload the page once.`,
      showLink: false,
    };
  }
  if (c && c.kind === "off_host") {
    return {
      kind: "off_host",
      text: `${base} ${domain} redirects to another site, which Rawuser does not read.`,
      showLink: false,
    };
  }
  if (c && (c.kind === "missing" || c.kind === "unreachable" || c.kind === "bot_protection")) {
    return {
      kind: "missing",
      text: `${base} The last check did not find the tag on ${domain}. Just published? Reload the page in a minute.`,
      showLink: false,
    };
  }
  return {
    kind: "fine",
    text: `${base} If your page opened, reload it once. If not, paste this into a private window:`,
    showLink: true,
  };
}

// ---------------------------------------------------------------------------
// The apply done screen
// ---------------------------------------------------------------------------

/** What the done screen's second step is: the policy lines, a word with us, or nothing. */
export type DonePolicy = "lines" | "write" | null;

export function donePolicy(install: InstallFacts | null | undefined): DonePolicy {
  const csp = install?.csp;
  if (!csp?.blocks) return null;
  if (csp.verdict.enforced?.script === "hash_only" || csp.notes.includes("hash_only"))
    return "write";
  return csp.lines.length > 0 ? "lines" : null;
}

/** The lede under "You're in." */
export function doneLede(install: InstallFacts | null | undefined): string {
  const two = donePolicy(install) !== null;
  const next = two
    ? `Two changes on your side, then ${operatorDoes("sets up", "set up")} your first versions with you.`
    : `Put the tag on, and ${operatorDoes("sets up", "set up")} your first versions with you.`;
  if (!install || install.platform === "other") return next;
  return `Your site runs on ${platformName(install.platform)}. ${next}`;
}

/** Where the tag goes, in one line, for the done screen. */
export function doneTagStep(install: InstallFacts | null | undefined): string {
  switch (install?.platform) {
    case "webflow":
      return "On a paid site plan, the first line of Head code (Site settings, Custom code). On the free plan, a Code Embed as the first element of the body, on each page you want changed.";
    case "nextjs":
      return "First inside `<head>` in `app/layout.tsx`, as a plain script tag, not `next/script`, which runs late.";
    case "lovable":
      return "Ask Lovable to add it as the first line inside `<head>` in `index.html`, without async or defer. Then publish.";
    case "framer":
      return "In Settings, Code, Add script: Placement Start of `<head>`, Run Once. Then publish.";
    case "wix":
      return "In Settings, Custom code, add it to load once, on all pages, in Head.";
    case "squarespace":
      return "In Settings, Advanced, Code injection, paste it as the first line of Header.";
    case "shopify":
      return "In Online Store, Themes, Edit code, paste it right after `<head>` in `layout/theme.liquid`.";
    case "wordpress":
      return "With a header plugin such as WPCode at the highest priority, or right after `<head>` in `header.php`. Exclude it from delay and combine settings.";
    case "vercel":
    case "other":
      return "Paste it first inside your page's `<head>`, without async.";
    default:
      return "Paste it first inside your page's `<head>`. On Webflow's free plan, use a Code Embed at the top of the body.";
  }
}

/** The second step on the done screen, when the read saw a blocking policy. */
export function donePolicyStep(install: InstallFacts): string {
  if (donePolicy(install) === "write") {
    return `Your policy runs only scripts it knows by hash, which cannot cover Rawuser's tag. Write to ${operatorOrUs()} and we find the way in with you.`;
  }
  const n = install.csp.lines.length;
  const these = n === 1 ? "this line" : "these lines";
  const lead = "Your Content-Security-Policy would block the tag.";
  switch (install.csp.where) {
    case "next_config":
      return `${lead} In \`next.config.js\`, inside \`async headers()\`, change ${these} and keep the rest.`;
    case "next_middleware":
      return `${lead} In \`middleware.ts\`, change ${these} and keep the rest.`;
    case "next_layout":
      return `${lead} It runs only scripts with the page's nonce, so the tag goes in \`app/layout.tsx\` with it.`;
    case "vercel_json":
      return `${lead} In \`vercel.json\`, under \`headers\`, change ${these} and keep the rest.`;
    case "netlify_headers":
      return `${lead} In \`_headers\` in your publish folder, change ${these} and keep the rest.`;
    case "cloudflare_headers":
      return `${lead} In \`_headers\` at the root of your build output, change ${these} and keep the rest.`;
    case "meta_tag":
      return `${lead} In its \`<meta>\` tag in your page's HTML, change ${these} and keep the rest.`;
    default:
      return `${lead} In its header, change ${these} and keep the rest.`;
  }
}

// ---------------------------------------------------------------------------
// Small formatting
// ---------------------------------------------------------------------------

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri 2 Oct, 14:00" in the reader's own time. */
export function dayTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}, ${hh}:${mm}`;
}

/** Split text into plain and `code` parts. */
export function codeParts(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const parts = text.split("`");
  parts.forEach((t, i) => {
    if (t) out.push({ code: i % 2 === 1, text: t });
  });
  return out;
}
