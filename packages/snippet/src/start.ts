/**
 * The start of the snippet, before anything is written (docs/specs/faster-tag.md,
 * step 4, C): read the configuration, leave the page alone where it must,
 * hide the parts this page rewrites, start the reveal cap and ask `/select`.
 *
 * Since 2026-10-25 a customer's tag (`/s/{id}.js`, the normal policy) is a
 * small boot (entry-boot.ts) that runs this and nothing else, then inserts
 * the shared core (`/s/_core/{hash}.js`, index.ts), which takes over the
 * pass through the `Page` it is handed. Since step 6's E1 every customer
 * script is the boot, whatever its policy; only the generic `/snippet.js`
 * runs this and the core in one file, at once (index.ts).
 *
 * The boot reveals by itself, never waiting for the core, when nothing will
 * be written: `/select` failed, the answer keeps the original (no signal,
 * the holdout, a deleted customer), the cap fired, or the core could not
 * load (entry-boot.ts). Once the core has taken a pass over (`core`), it
 * owns the timer and the reveal, as before the split.
 *
 * Nothing here reads or sends anything the snippet did not before the split.
 */

import { easeIn, hiddenParts, injectHideStyle, settle } from "./boot.ts";
import { carryOff, closeTab } from "./carry.ts";
import { fetchVariant } from "./fetch.ts";
import { tagIsLate } from "./late-tag.ts";
import { keepNonce } from "./nonce.ts";
import { normalizePath } from "./path.ts";
import { CAPTURE_PARAM, PICK_PARAM, tokenFrom } from "./pick-loader.ts";
import { revealAll } from "./reveal.ts";
import { loadRich, richListed } from "./rich-loader.ts";
import { restartAnimations } from "./template.ts";
import type { SelectResponse } from "./types.ts";
import { ensureVisit } from "./visit.ts";

/** Config the per-customer script (`/s/{customer}.js`) sets before the snippet body runs. */
export interface QuietConfig {
  c?: string;
  e?: string;
  /** path → selectors to hide before first paint (docs/specs/quiet-swap.md). */
  h?: Record<string, string[]>;
  /**
   * Every confirmed page's path, also one with no rule in `h` (quiet-swap.md
   * 2b). Absent from a script made before the edge sent it: as before then.
   */
  p?: string[];
  /** 1 when the customer turned the carries off (body carry, condition 6). */
  nc?: number;
  /** 1 when the edge does not read the ad keyword: utm_term is not forwarded (keyword-intent.md). */
  nt?: number;
  /** Pages that need the rich writers, `/rich.js` (rich-loader.ts). */
  x?: string[];
  /** 1 for a deleted customer: record nothing, ask nothing (closeTab). */
  off?: number;
  /** An audit's domain: this page's host must be it or a subdomain (ai-traffic-audit.md §3.4). */
  ad?: string;
  /** An audit's end, unix ms: from then on the page is left as built. */
  ae?: number;
}

/**
 * The handoff's version. A core takes over only a boot of its own number;
 * any other, it shows the page as built. The edge serves every boot its own
 * core build (`/s/_core/{hash}.js`, kept for days), so a mismatch is only a
 * safety net. Raise it whenever `Page` or `Pass` changes shape or meaning.
 */
export const PROTOCOL = 1;

/**
 * How long the initial load may wait for the edge before we reveal the
 * original anyway. Measured from the founder's machine on 2026-09-13: /select answers in
 * 265 to 600 ms, so the earlier 300 ms window opened the original text for
 * up to 300 ms and then swapped it, which read as "the default opens
 * first". Only the rewritten elements are hidden, with their box kept, so
 * the cost of waiting is one second of invisible hero text when the edge
 * is down; the CSS fallback in boot.ts is the backstop after that.
 */
export const LOAD_SAFETY_MS = 1500;
/** How long a client-side route may take to render before we reveal anyway. */
export const SPA_SAFETY_MS = 1500;
/** The pause before `/select` is asked again after a network failure. */
const SELECT_RETRY_MS = 250;

/** One page load: what the boot learned, shared with the core that takes over. */
export interface Page {
  v: number;
  cfg: QuietConfig;
  /** The customer id and the edge's origin. */
  c: string;
  e: string;
  /** Our own tag (`document.currentScript` of the boot): its nonce, its async/defer. */
  script: HTMLScriptElement | null;
  /**
   * The page was left or hidden while a pass asked the edge: presence only,
   * set by the two exit listeners and by nothing else, never a time
   * (privacy review Q5). A page that loaded hidden sets nothing.
   */
  left: boolean;
  /** `/select` is on its way. */
  asking: boolean;
  /** The core's part of an exit (the snippet issues), once it is here. */
  leave?: (gone: boolean) => void;
  /** The `/rich.js` load the boot started, for the core to wait on. */
  rich?: Promise<void>;
  /** The load's own pass, started by the boot. */
  first: Pass;
  /**
   * The late-tag rule of a boot that knows the pasted style (the two-part
   * tag, pre.ts, docs/specs/faster-tag.md step 6); `tagIsLate` when absent
   * (the single file, a boot from before step 6). Read for the load's own
   * pass only, in the boot: a core never needs it.
   */
  late?: typeof tagIsLate;
}

/**
 * The handoff in pick or capture mode (operator only): the boot has taken
 * the token out of the address already (scrubOperator) and hands it to the
 * core, which loads the operator module (index.ts). Removed when read, or
 * when the core fails to load.
 */
export interface Op {
  v: number;
  /** The one-time token. */
  op: string;
  /** A capture's token, not a pick's. */
  cap: boolean;
  e: string;
}

/** One personalisation pass: the load's, or a client-side route's. */
export interface Pass {
  spa: boolean;
  /** `location.pathname` as the pass began, for its events. */
  path: string;
  /** The normalised path the pass writes. */
  here: string;
  /** A page of the site's own to write (quiet-swap.md 2b). */
  own: boolean;
  /** Painted before our script ran (late-tag.md): left as built. */
  lateTag: boolean;
  /** Left as built on this pass: painted first, or not the site's own. */
  asBuilt: boolean;
  /** The page's own selectors hidden on this pass. */
  rules: string[];
  hideStyle: HTMLStyleElement | null;
  /** When the cap reveals (a Date.now() time), and its timer. */
  capAt: number;
  timer?: ReturnType<typeof setTimeout>;
  /**
   * The cap itself showed the page. From then on the visitor has seen the
   * original, so this load writes nothing more (Late answers, quiet-swap.md).
   */
  capFired: boolean;
  revealed: boolean;
  /** The core owns this pass: its timer and its reveal. */
  core: boolean;
  /** The tab's visit marker, drawn when the pass asked (visit-marker.md). */
  visit?: string | null;
  answer?: Promise<SelectResponse>;
  /** The 5 s abort of the ask, to tell our timeout from a network failure. */
  ctl?: AbortController;
}

/**
 * The site's own page to write (quiet-swap.md 2b): a confirmed one. On any
 * other page of a customer that has confirmed pages nothing is hidden and
 * nothing is written; the home page's version does not fit a route that
 * never has its parts (a pilot site, 2026-10: 20 of 38 `reveal_cap` rows).
 * Every page is, for a customer with none (a hand-tagged site) and under a
 * script that does not say (`p` absent).
 */
export const ownPage = (cfg: QuietConfig, path: string) =>
  !cfg.p?.length || cfg.p.includes(path) || !!cfg.h?.[path];
/** A listed page with no rule of its own hides nothing of the home page's. */
export const hideRulesFor = (cfg: QuietConfig, path: string) =>
  cfg.h?.[path] ?? (cfg.p?.length ? [] : cfg.h?.["/"]) ?? [];

/**
 * The page's parts come into view: the hide style goes, at once and not
 * after the page's own transition (boot.ts, settle); what we held plays its
 * own entrance again (a warm Webflow load started its GSAP slide while we
 * waited for the edge, and a visitor with no signal saw only two thirds of
 * it, 2026-09-29; our words, where written, restarted it already); a block
 * whose own entrance ended while we held its parts lets them in with a
 * short fade (boot.ts, easeIn). Once per pass.
 */
export function show(p: Pass): void {
  if (p.revealed) return;
  p.revealed = true;
  clearTimeout(p.timer);
  // A page left as built hid nothing: its entrance already played in view.
  const held = p.asBuilt ? [] : hiddenParts(p.rules);
  revealAll(p.hideStyle);
  settle(held);
  for (const el of held) restartAnimations(el);
  easeIn(held);
}

/**
 * Hide what will change and start the cap (the first half of a pass).
 * On the initial load the hide style is the first DOM mutation, before any
 * body content is painted (the tag lives first in <head>, not async). On a
 * client-side navigation the new route renders under these rules.
 */
export function begin(page: Page, spa: boolean): Pass {
  const here = normalizePath(location.pathname);
  // A page that was painted before our script ran stays as built for this
  // load (docs/specs/late-tag.md): nothing hidden, nothing written, nothing
  // changed under a reader's eyes. The edge is still asked and the tab
  // still keeps the carry and the copy, so the visit's next page can be
  // written at once. Decided once, at load, from presence only; a
  // client-side route renders after us, as today.
  // Never asked of a page that is not the site's own: nothing would have
  // been hidden or written there, so no `late_tag` and no `lp` either.
  const rules = hideRulesFor(page.cfg, here);
  const own = ownPage(page.cfg, here);
  const lateTag = own && !spa && (page.late ?? tagIsLate)(page.script, rules);
  const asBuilt = lateTag || !own;
  const ms = spa ? SPA_SAFETY_MS : LOAD_SAFETY_MS;
  const p: Pass = {
    spa,
    path: location.pathname || "/",
    here,
    own,
    lateTag,
    asBuilt,
    rules,
    hideStyle: asBuilt ? null : injectHideStyle(rules),
    capAt: Date.now() + ms,
    capFired: false,
    revealed: false,
    core: false,
  };
  // A page built word by word or cut into lines needs the rich writers:
  // they load now, alongside /select, so the answer finds them in place.
  if (!asBuilt && richListed(page.cfg.x, here, page.cfg.h)) page.rich = loadRich(page.e);
  // Safety timer: if the edge is slow or errors, reveal anyway. Blank
  // screen is never acceptable; original content is always the fallback.
  // Not on a page left as built: nothing is hidden, so there is nothing to
  // reveal. The core replaces it with its own when it takes the pass over.
  if (!asBuilt)
    p.timer = setTimeout(() => {
      p.capFired = true;
      show(p);
    }, ms);
  return p;
}

/**
 * Fetch the resolved variant from the edge (5 s hard timeout). A network
 * failure is asked once more after a short pause, inside the same 5 s and
 * under the same cap (a late answer keeps the original): about 3% of loads
 * on two pilot sites failed so, evenly across days, and a dropped mobile
 * request often goes through the second time (2026-10-18). Never after our
 * timeout, an unusable answer (fetch.ts marks it `http`), an exit or a
 * change of path.
 *
 * Until the core has the pass, the boot reveals on an answer that writes
 * nothing, and on a failure.
 */
export function ask(page: Page, p: Pass): Promise<SelectResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  // The tab's visit marker (docs/specs/visit-marker.md), drawn on the
  // first pass, reused while the tab is active.
  const visit = ensureVisit();
  const go = () => fetchVariant(page.c, page.e, ctl.signal, visit, page.cfg.nt === 1);
  const fail = (e: unknown) =>
    ctl.signal.aborted ||
    (e as { http?: number } | null)?.http ||
    page.left ||
    normalizePath(location.pathname) !== p.here;
  page.left = false;
  page.asking = true;
  const answer = go().catch(async (e: unknown) => {
    if (fail(e)) throw e;
    await new Promise((r) => setTimeout(r, SELECT_RETRY_MS));
    if (fail(e)) throw e;
    return go();
  });
  const settled = (r?: SelectResponse) => {
    clearTimeout(timer);
    page.asking = false;
    if (p.core) return;
    // A deleted customer: the tab's keys go now (the core sends nothing).
    if (r?.off === 1) closeTab();
    if (!r || r.off === 1 || r.source === "holdout" || !(r.source !== "original" && r.variant))
      show(p);
  };
  answer.then(settled, () => settled());
  p.visit = visit;
  p.ctl = ctl;
  p.answer = answer;
  return answer;
}

/**
 * Pick or capture mode: the operator opened their own page with a one-time
 * token from the dashboard. Visitors never carry either parameter.
 */
export const operatorToken = (): string | null =>
  tokenFrom(location, PICK_PARAM) ?? tokenFrom(location, CAPTURE_PARAM);

/**
 * The boot itself: configuration, the checks that come before anything is
 * asked, the exit listeners and the load's pass. Null when nothing is to be
 * done on this page (no configuration, a deleted customer or an audit off
 * its host or past its end), and in pick or capture mode, where `operator`
 * runs instead: the core's file loads the operator module, the boot's
 * removes the token from the address and hands it to the core (entry-boot.ts).
 *
 * `load` (the boot's file only) sends for the core as soon as the page is
 * known to need it, before the hide rules and `/select` are worked out, so
 * the core's download starts a few milliseconds sooner; the core runs in a
 * later task, by when the pass is in place. When it cannot send for it
 * (a Trusted Types policy refuses the address), nothing is hidden and
 * nothing is asked: no answer could be used.
 */
export function startBoot(
  operator?: (token: string, edge: string) => void,
  load?: (page: Page) => boolean,
): Page | null {
  // Configuration: the per-customer script sets window.__rw; the generic
  // /snippet.js tag carries data-* attributes instead. Both keep working.
  // The picker's measuring frame (docs/specs/interactive-text.md §3.4): the
  // page as built, no version, no event.
  if (window.name === "rawuser-measure") return null;
  const cfg = ((window as unknown as { __rw?: QuietConfig }).__rw ?? {}) as QuietConfig;
  const script = document.currentScript as HTMLScriptElement | null;
  // The page's CSP nonce, copied as a property onto what we insert (E1).
  keepNonce(script);
  const c = cfg.c ?? script?.dataset.customerId ?? "";
  const e = cfg.e ?? script?.dataset.edgeOrigin ?? "";
  // No configuration: nothing to do. Do not hide anything.
  if (!c || !e) return null;

  // A deleted customer, or an audit's tag on another host or past its end
  // (privacy review condition 1: checked before any visit marker or request):
  // clear what the tab kept, hide nothing, ask the edge nothing, leave the
  // page as built.
  const host = location.hostname;
  if (
    cfg.off === 1 ||
    (cfg.ad != null && host !== cfg.ad && !host.endsWith(`.${cfg.ad}`)) ||
    (cfg.ae != null && Date.now() >= cfg.ae)
  ) {
    closeTab();
    return null;
  }

  // The customer turned the carries off: remove what the tab kept.
  if (cfg.nc === 1) carryOff();

  // Pick or capture mode: hide nothing, ask the edge for no version.
  const token = operatorToken();
  if (token) {
    operator?.(token, e);
    return null;
  }

  const page = { v: PROTOCOL, cfg, c, e, script, left: false, asking: false } as Page;
  if (load && !load(page)) return null;
  // A visitor who leaves, or hides the tab (the last event a phone gives),
  // while we ask: noted here, presence only; the core sends the load's
  // snippet issues (index.ts, `page.leave`).
  const leave = (gone: boolean) => {
    page.left = true;
    page.leave?.(gone);
  };
  window.addEventListener("pagehide", () => leave(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) leave(false);
  });
  page.first = begin(page, false);
  ask(page, page.first);
  return page;
}
