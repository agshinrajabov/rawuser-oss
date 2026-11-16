import {
  REVERT_WINDOW_MS,
  allTargetElements,
  declared,
  holdVariant,
  lastSkip,
  reserveRotations,
  targetElements,
} from "./apply.ts";
import { clearBody, keptPaths, readBody, storeBodies } from "./body-carry.ts";
import { carryOff, closeTab, readCarry, writeCarry } from "./carry.ts";
import { installConversionListeners } from "./conversions.ts";
import { type Early, earlyApply, earlyVerdict } from "./early.ts";
import { fireEvent, pagePath } from "./events.ts";
import { fetchBodies, ownSignal } from "./fetch.ts";
import { isReactSite, waitForHydration, waitUntil } from "./hydration.ts";
import {
  dropIssues,
  flushIssues,
  leftAsking,
  noteError,
  noteIssue,
  startIssues,
  watchShift,
} from "./issues.ts";
import { keepNonce } from "./nonce.ts";
import { normalizePath } from "./path.ts";
import { applyWhenReady, fontsReady } from "./ready.ts";
import { dropReserve } from "./reserve.ts";
import { revealAll } from "./reveal.ts";
import { linesSettled, rich as richIn } from "./rich-api.ts";
import { adoptRich, loadRich, richWait, targetsNeedRich } from "./rich-loader.ts";
import { afterRender, watchNavigation } from "./spa.ts";
import { type Page, type Pass, ask, begin, show } from "./start.ts";
import type { Provenance, SelectResponse } from "./types.ts";

/** How long after the reveal the other pages' copy is asked for (body carry prefetch). */
const PREFETCH_DELAY_MS = 1500;

/**
 * On a React site, how long the initial load waits for hydration once the
 * version is in hand, elements still hidden. Writing before React hydrates
 * makes React discard the server DOM and render the page again (error
 * #418): dead buttons, stalled entrance animations. Measured on a pilot site:
 * hydration lands 1.6 to 3 s after navigation. See hydration.ts.
 */
const HYDRATION_WAIT_MS = 2500;
/** The snippet issues of a load are sent this long after its reveal (docs/specs/snippet-issues.md). */
const ISSUE_SEND_MS = 1000;

/**
 * The core: everything after the start of a pass (start.ts), for the load's
 * own pass handed over by the boot and for every client-side route after
 * it. Apply, hydration wait, hold, events, conversions, snippet issues,
 * body carry. Runs in the same file as the boot (only the generic
 * `/snippet.js` since step 6's E1) or in its own (`/s/_core/{hash}.js`,
 * entry index.ts), the same either way.
 */
export function runCore(page: Page): void {
  const { cfg, c: customerId, e: edgeOrigin } = page;
  // A core in its own file has its own copies of the modules the boot used:
  // the nonce, the carry switch and the rich load are taken over from it.
  keepNonce(page.script);
  if (cfg.nc === 1) carryOff();
  adoptRich(page.rich);

  // A visitor who leaves, or hides the tab (the last event a phone gives),
  // before the load's issues went out: sent now, once. A `/select` still on
  // its way when the page goes is the exit's failure, not the edge's; when
  // the tab is only hidden it may still answer, so the list waits for it.
  // A network failure noted and not yet sent is settled here, at the send:
  // the exit reaches some engines after the request they killed has been
  // rejected (WebKit; the pilot, 2026-10-13: 13 of 14 "network" rows were lone
  // loads whose issue row still arrived), so it is the exit's too.
  // The boot's listeners set `page.left` and call this (start.ts).
  page.leave = (gone: boolean) => {
    leftAsking(gone && page.asking);
    if (gone || !page.asking) flushIssues();
  };

  /**
   * What the edge decided for a signal-bearing landing, kept so the next
   * page in this tab can carry it (the site's own language switch drops the
   * parameters; docs/specs/session-carry.md). The visit's, not the page's:
   * kept also when the tab moved on while we asked.
   */
  const keepCarry = (r: SelectResponse) => {
    if (r.carry_off) carryOff();
    // The edge's own word when it gives one (`kc`, "" for nothing:
    // docs/specs/direct-visitors.md §6), else the selection as before.
    const k =
      r.kc ??
      (r.source !== "original" && r.selection && r.selection.intent_dim !== "none" && !r.carried
        ? `${r.selection.intent_dim}:${r.selection.source_dim}`
        : "");
    const [i, s] = k.split(":");
    if (i && s) writeCarry(i, s);
  };
  /** The edge said the customer was deleted: no later pass asks again. */
  let closed = false;
  /** Stops the hold of the page the tab leaves: its words are that page's alone. */
  let stopHold: () => void = () => {};
  /** Ends the pass under way when the path changes under it (quiet-swap.md 2b). */
  let endPass: () => void = () => {};

  /**
   * One personalisation pass, with its own snippet-issues list: sent a
   * second after the reveal; when the hold ran, its count of restores
   * follows alone once the ten seconds are counted
   * (docs/specs/snippet-issues.md). Always as text/plain, a request that
   * needs no preflight, so it is out before a visitor who leaves next.
   * Never carries the visit marker (privacy review condition 1).
   */
  async function personalize(spa: boolean, pre?: Pass, now?: boolean): Promise<void> {
    const path = pre ? pre.path : pagePath();
    const done = { k: "", held: false, over: false };
    const send = startIssues((issues) =>
      fireEvent(
        edgeOrigin,
        customerId,
        {
          event_type: "snippet_issue",
          page_path: path,
          variant_key: done.k || undefined,
          properties: { issues },
        },
        true,
      ),
    );
    try {
      await pass(spa, path, done, pre, now);
    } finally {
      done.over = true;
      // A deleted customer's page sends nothing, issues included.
      if (!closed) {
        setTimeout(() => send(!done.held), ISSUE_SEND_MS);
        if (done.held) setTimeout(send, REVERT_WINDOW_MS);
      }
    }
  }

  /**
   * One personalisation pass for the current path: hide what will change,
   * ask the edge, apply, tell the analytics, reveal. Runs at load and again
   * on every client-side navigation (docs/specs/session-carry.md).
   */
  async function pass(
    spa: boolean,
    path: string,
    done: { k: string; held: boolean; over: boolean },
    pre?: Pass,
    now?: boolean,
  ): Promise<void> {
    if (closed) return;
    // 1. The hide style, the late-tag rule and the cap (start.ts, begin):
    //    already done by the boot for the load's own pass, done here for a
    //    client-side route. From here the core owns the pass.
    const p = pre ?? begin(page, spa);
    const { here, own, lateTag, asBuilt } = p;
    if (lateTag) noteIssue("late_tag");
    /** The one bit on this load's exposure: `tagIsLate` and nothing else, never a time. */
    const lp = lateTag ? { lp: 1 as const } : {};

    /** Something of the page was written by us on this pass. */
    let wrote = false;
    /** The tab's carried copy, written as the page parses (body carry). */
    let early: Early | null = null;
    const reveal = () => {
      if (p.revealed) return;
      show(p);
      // The swap window's layout shift, only on a load that wrote a part
      // (snippet issues, privacy review condition 3): a part hidden and shown again
      // as built keeps its box and moves nothing, so a shift on such a load is
      // the page's own (its fonts arriving, seen on a bot's load, 2026-10-12).
      // After the reveal, never before.
      if (wrote || early?.applied) watchShift();
    };
    /** Which cap the safety timer is (snippet issues, reveal_cap): 1 load, 2 SPA, 3 hydration. */
    let capKind = spa ? 2 : 1;
    // `p.capFired`: the safety timer itself revealed the page (not a cap
    // that was moved and cleared). From then on the visitor has seen the
    // original, so this load writes nothing more: a version arriving later
    // would change the headline in front of them (Late answers,
    // docs/specs/quiet-swap.md).
    const capped = () => {
      p.capFired = true;
      noteIssue("reveal_cap", undefined, capKind);
      // From here the page is in view: the tab's copy is neither written nor
      // fitted any more (a stylesheet that lands now changes nothing of ours).
      early?.stop();
      reveal();
    };
    // The core's own timer from here, at the same moment (start.ts): a cap
    // that fired before the core came is this load's cap all the same. Not
    // on a page left as built (nothing hidden), nor one already in view.
    p.core = true;
    clearTimeout(p.timer);
    if (p.capFired) noteIssue("reveal_cap", undefined, capKind);
    else if (!asBuilt && !p.revealed) p.timer = setTimeout(capped, p.capAt - Date.now());
    /** When the safety timer reveals: the rich wait never runs past it. */
    let capAt = p.capAt;

    // A later page of the visit without a signal of its own: write the
    // tab's carried copy as the page parses, before its own scripts split
    // the text (body carry). The edge's answer below still decides.
    // Never on a page left as built, nor once the page is in view (the boot
    // showed it before the core came), nor on a path the tab has left.
    const kept =
      !spa && !asBuilt && !p.revealed && normalizePath(location.pathname) === here && !ownSignal()
        ? readBody(here)
        : null;
    if (kept && targetsNeedRich(kept.targets)) void loadRich(edgeOrigin);
    try {
      early = kept ? earlyApply(kept) : null;
    } catch {
      noteError();
      early = null;
    }

    /** The path changed under this pass: from then on it writes and sends nothing. */
    let gone = false;
    // Its hide goes, its timer and its early copy stop, and what it noted is
    // dropped (an abandoned pass has no exposure to be a share of). A copy
    // already written is not put back: the router may have given those nodes
    // to the new route. Nothing once the pass is over.
    const quit = () => {
      if (done.over) return;
      done.over = gone = true;
      page.asking = false;
      clearTimeout(p.timer);
      early?.stop();
      revealAll(p.hideStyle);
      dropIssues();
    };
    endPass = quit;
    /** Asked after every wait; a navigation we were told of has ended the pass already. */
    const moved = () => {
      if (normalizePath(location.pathname) !== here) quit();
      return gone;
    };

    // On a client-side navigation, let the router render the new route
    // first: the page language and the new hero exist after that. The load's
    // own pass was asked by the boot (start.ts, ask). A visitor's answer to
    // the question (`now`, choice.ts) changes no route: asked at once (the
    // wait was for a mutation that never came, 400 + 60 ms, measure-lab
    // 2026-11-03).
    if (spa) {
      if (!now) await afterRender();
      if (moved()) return;
      ask(page, p);
    }

    let response: SelectResponse;
    try {
      response = await (p.answer as Promise<SelectResponse>);
    } catch (e) {
      // On any error or abort: reveal original. Never leave the page blank.
      // No exposure event on fetch failure: the outcome is "original page
      // shown without our involvement", the same as no snippet at all. The
      // edge did not confirm a carried copy either, so it goes. The snippet
      // issues list gets the kind only: 1 our timeout, 3 the edge answered
      // unusably (fetch.ts marks it `http`), 4 the page was left or hidden
      // while we asked (F1), else 2 network, provisional until the list is
      // sent: an exit before then makes it 4 (`page.leave` above).
      if (moved()) return;
      page.asking = false;
      noteIssue(
        "select_failed",
        undefined,
        p.ctl?.signal.aborted ? 1 : (e as { http?: number } | null)?.http ? 3 : page.left ? 4 : 2,
      );
      if (early?.applied) early.revert();
      early?.stop();
      reveal();
      return;
    }
    // The tab is on another page: the visit keeps its carry, the pass ends.
    if (moved()) {
      // A deleted customer closes the tab whichever page asked (the privacy review
      // on `71238e8`): no carry is kept, and no later pass asks again.
      if (response.off === 1) {
        closed = true;
        closeTab();
        return;
      }
      return keepCarry(response);
    }
    page.asking = false;
    early?.stop();
    // A deleted customer (a tag on the generic form, or a script cached from
    // before the delete): put back anything written early, clear the tab,
    // send nothing.
    if (response.off === 1) {
      closed = true;
      dropIssues();
      if (early?.applied) early.revert();
      closeTab();
      reveal();
      return;
    }
    done.k = response.variant_key ?? "";
    keepCarry(response);
    // The visitor's own choice (docs/specs/direct-visitors.md §2): the row
    // comes with rich.js, after the answer; an answer reruns this pass.
    // A rich.js that did not load draws nothing: its reserve goes (reserve.ts).
    if (response.q)
      void loadRich(edgeOrigin).then(() =>
        (richIn()?.choice ?? dropReserve)(response.q, page, chosen),
      );

    // The edge decides (condition 6): a carried copy it does not confirm
    // with a personalized answer is put back as the page built it.
    const verdict = earlyVerdict(early, response);
    const confirmed = verdict === "keep";
    if (verdict === "revert" && early) {
      early.revert();
      clearBody();
    }
    // The visit's arm and the version's id ride on every event of this page,
    // conversions included (docs/specs/proof-engine.md, C). A page written
    // early from the tab's copy reports the words it showed.
    const prov: Provenance = {
      arm: response.arm,
      body_id: (confirmed && kept?.body_id) || response.body_id,
      // N1, N3: what the edge said about this request, repeated on its events.
      source_name: response.source_name,
      tagged: response.tagged ? 1 : undefined,
      site_path: response.site_path ? 1 : undefined,
      // Audits: how the edge recognised the source, repeated like source_name.
      found_by: response.found_by,
      // Why a visit with no signal got this answer (direct-visitors.md §6).
      nd: response.nd,
      // The tab's visit marker (docs/specs/visit-marker.md), on every event
      // of the page but the snippet issues.
      visit: p.visit || undefined,
    };

    // Keep this page's copy for the rest of the visit: served and confirmed
    // pages only, the allowed fields only (body carry, conditions 1 and 2).
    const carryable =
      (response.source === "kv" || response.source === "kv-sentinel") &&
      response.cohort === "personalized" &&
      !response.language_mismatch &&
      response.carryable === true &&
      !!response.variant;
    // Stored once the write is decided: a version the visitor never saw (a
    // late answer) is not kept for the next page.
    const keepBody = () => {
      if (carryable && response.variant)
        storeBodies({
          [here]: {
            sections: response.variant.sections,
            targets: response.targets,
            prompt_hash: response.variant.prompt_hash,
            body_id: response.body_id,
          },
        });
    };

    /** The cell the page's events name: the version's key and the selection. */
    const cell = {
      variant_key: response.variant_key ?? "",
      intent_dim: response.selection?.intent_dim,
      source_dim: response.selection?.source_dim,
    };

    // 4a. Holdout: the visit's coin said holdout. Do not mutate the DOM;
    //     report the impression as holdout; install the conversion listeners
    //     so the control arm's clicks count.
    if (response.source === "holdout") {
      fireEvent(edgeOrigin, customerId, {
        event_type: "variant_shown",
        page_path: path,
        ...cell,
        cohort: "holdout",
        carried: response.carried ? 1 : undefined,
        ...lp,
        ...prov,
      });
      installConversionListeners(response.conversion_targets ?? [], {
        edgeOrigin,
        customerId,
        cohort: "holdout",
        prov: { ...prov, ...cell },
      });
      reveal();
      return;
    }

    /** The cap showed the original before the write started: this load writes nothing. */
    let late = false;
    // 4b. Apply the variant, unless the edge said "no meaningful signal,
    //     leave the original alone" (source: "original", variant: null).
    if (response.source !== "original" && response.variant) {
      // The answer needs the rich writers on a page the list missed (a
      // stale key): they load now, one round trip on this load only.
      if (!asBuilt && targetsNeedRich(response.targets)) void loadRich(edgeOrigin);
      // The version is in hand, so the network is no longer what we wait
      // for. On a React site the initial load also waits for hydration
      // (hydration.ts): the elements stay hidden, the reveal moves out.
      // Not when the cap already revealed the page: nothing is written then.
      // The answer can come before the page is parsed far enough to tell
      // (the boot asks from the head): React's marks in the body, the parts
      // not there yet. Then the decision waits for every part, or the end of
      // the parse, under the load cap, the parts hidden; the fonts wait runs
      // meanwhile, so a page that is not React writes no later than before
      // once its parts are in (Framer, 2026-10-25: written at 1,347 ms, the
      // h1 parsed at 1,097 and hydrated at 3,098, 9 recoverable errors).
      const variant = response.variant;
      const all = () => allTargetElements(variant, response.targets);
      const answered = Date.now();
      let fonts: Promise<unknown> | undefined;
      if (
        !spa &&
        !asBuilt &&
        !p.capFired &&
        !isReactSite() &&
        document.readyState === "loading" &&
        !all()
      ) {
        fonts = fontsReady();
        await waitUntil(
          () => p.capFired || document.readyState !== "loading" || !!all(),
          capAt - answered,
        );
        if (moved()) return;
      }
      if (!spa && !asBuilt && !p.capFired && isReactSite()) {
        fonts = undefined;
        clearTimeout(p.timer);
        capKind = 3;
        // At most HYDRATION_WAIT_MS after the version arrived, as before.
        capAt = answered + HYDRATION_WAIT_MS;
        const ms = capAt - Date.now();
        p.timer = setTimeout(capped, ms);
        // While the page parses: every part, or none yet (a part React has
        // not reached cannot pass for hydrated beside one it has). Parts the
        // site owner declared, every one of them (`data-rawuser-early` beside
        // React's `suppressHydrationWarning`, apply.ts `declared`), end
        // the wait at once: written as on a page that is not React
        // (faster-tag.md E3).
        // Answered once, when the page is parsed (every part holds all its nodes).
        let early: boolean | undefined;
        await waitForHydration(
          () =>
            document.readyState === "loading"
              ? (all() ?? [])
              : targetElements(variant, response.targets),
          ms,
          () => {
            if (document.readyState !== "loading") early ??= declared(variant, response.targets);
            return early;
          },
        );
        if (moved()) return;
      }
      // Already written from the tab's copy and confirmed by the edge: the
      // lengths were fitted behind the hide as soon as the page's styles
      // were in (early.ts, A10); a part not fitted yet is fitted now, and
      // the rotation reserve measured, in the page's fonts, as on a first
      // page. Not once the cap has shown the page: what the visitor reads
      // stays as it is.
      // The rich writers, when this page needs them, until the reveal cap.
      // A page left as built is not written at all.
      let applied = false;
      if (!asBuilt)
        try {
          const rich = richWait(capAt);
          if (confirmed) {
            await Promise.all([fontsReady(), rich]);
            if (moved()) return;
            if (!p.capFired) early?.fit();
            reserveRotations(response.variant, response.targets);
          }
          // Another copy, or the same words for other parts: the early write
          // goes back in place just before the edge's copy is written, so that
          // copy is measured against the page's own words and the hold watches
          // for them, as on a first page, and a part the edge no longer names
          // is left as the page built it.
          applied = confirmed
            ? true
            : await applyWhenReady(
                response,
                spa,
                rich,
                // Asked before every try: a route the tab has left is not written.
                () => p.capFired || moved(),
                verdict === "reapply" ? early?.undo : undefined,
                fonts,
              );
          if (moved()) return;
        } catch {
          // The write threw: the code and the part only, never the error
          // (privacy review condition 4). What was written stays, as before.
          noteError();
          wrote = true;
          keepBody();
          reveal();
          return;
        }
      // Late: the cap revealed the page before the write started, so the
      // visitor has the original and keeps it. A carried copy already on the
      // page and confirmed by the edge is not late (it showed at the reveal);
      // one the edge does not confirm goes back as the page built it.
      late = !applied && p.capFired;
      if (late && verdict === "reapply" && early) {
        early.revert();
        clearBody();
      }
      if (!late) keepBody();
      // The page needed the rich writers and they were not here by the cap.
      if (!asBuilt && targetsNeedRich(response.targets) && !richIn()) noteIssue("rich_failed");
      wrote = applied;
      // Keep the swap for the page's life (client-rendered sites revert).
      // A late load wrote nothing, so there is nothing to hold.
      if (applied) {
        done.held = true;
        stopHold = holdVariant(response.targets, undefined, undefined, undefined, (paths) => {
          fireEvent(edgeOrigin, customerId, {
            event_type: "personalization_partial",
            page_path: path,
            ...cell,
            cohort: "personalized",
            paths,
            ...prov,
          });
        });
      }
      // The event is gated on whether mutation actually happened: a
      // pre-flight abort means the visitor saw the ORIGINAL (QA-3).
      const cohort = applied ? "personalized" : "skipped";
      fireEvent(edgeOrigin, customerId, {
        event_type: applied ? "variant_shown" : "personalization_skipped",
        page_path: path,
        ...cell,
        cohort,
        // The selection came from the tab's carry, not this page's signals.
        carried: response.carried ? 1 : undefined,
        // The words came from the tab's carried copy (body carry, condition 5).
        body_carry: confirmed ? 1 : undefined,
        // Why the page stayed as built (interactive text §5): a page fact,
        // or `late`: the visitor was already reading the original, because
        // the version came after the cap revealed it or, with `lp`, because
        // the page was painted before our script ran. A page that is not the
        // site's own has none of the parts: `missing`, as a full load said.
        ...(applied
          ? {}
          : { kind: late || lateTag ? ("late" as const) : own ? lastSkip() : "missing" }),
        ...lp,
        ...prov,
      });
      // Conversion targets are operator-confirmed CTAs; install regardless
      // of `applied` (the variant may have had unrelated mismatched paths).
      // A late load converts as `skipped`: the visitor saw the original.
      installConversionListeners(response.conversion_targets ?? [], {
        edgeOrigin,
        customerId,
        cohort,
        prov: { ...prov, ...cell },
      });
    } else if (response.source === "original") {
      // The arm of a learned default's original (direct-visitors.md §3),
      // its `nd` and the marker; never a source on a page without one.
      const ns = { arm: response.arm, nd: response.nd, visit: prov.visit };
      // Naked direct visit / no meaningful signal. Fire passthrough so the
      // analytics aggregator has the no-signal denominator for lift.
      fireEvent(edgeOrigin, customerId, {
        event_type: "no_signal_passthrough",
        page_path: path,
        cohort: "no_signal",
        // L2 Layer D: the edge's verdict on whether this untagged visit
        // looks like an app that hid the referrer. A flag, not a source.
        dark_social: response.dark_social_probable ? 1 : undefined,
        // Language gate: the versions are in another language than this page.
        language_mismatch: response.language_mismatch ? 1 : undefined,
        ...ns,
      });
      // Clicks count on pages without a version too (proof engine, fault 2):
      // a treat or holdout visit may convert here, and the no-signal visits
      // are the natural lift's baseline. Same label, page and marker.
      installConversionListeners(response.conversion_targets ?? [], {
        edgeOrigin,
        customerId,
        cohort: "no_signal",
        prov: ns,
      });
    }
    // The pass has spoken: a navigation from here only reveals it now.
    endPass = reveal;
    // A page that fits its font to our lines does it in the next frames:
    // revealed after, not during (at most 120 ms).
    await Promise.race([linesSettled(), new Promise((r) => setTimeout(r, 120))]);
    reveal();

    // After the reveal, the same segment's copy for the other confirmed
    // pages, so page two of the visit can be written before it splits
    // (body carry prefetch: customer id and the two labels only).
    // Any personalized page of the visit asks, not only a confirmed one: a
    // visitor may land on a page without its own manifest (a blog post, a
    // campaign page) and go on to confirmed ones. What is stored is still
    // only confirmed pages' copy, which is all /carry returns. Not after a
    // late answer: this page showed the original, so nothing is fetched for
    // the next ones (privacy review, 2026-10-02).
    const carry = readCarry();
    const personalized =
      response.cohort === "personalized" && !response.language_mismatch && !!response.variant;
    if (personalized && carry && !late && keptPaths().length <= 1) {
      setTimeout(() => {
        fetchBodies(customerId, edgeOrigin, carry.intent_dim, carry.source_dim)
          .then((bodies) => {
            // The other pages only. This page's copy is the one the edge
            // served here, with the parts it named; /carry reads the
            // manifests themselves and can be ahead of /select's bundle.
            delete bodies[here];
            storeBodies(bodies);
          })
          .catch(() => {});
      }, PREFETCH_DELAY_MS);
    }
  }

  void personalize(false, page.first);

  // Client-side navigations (the site's own links and language switch on a
  // Next.js/Nuxt site) never reload the page; personalise the new route too.
  // The page that is left ends here: its pass when still under way, and its
  // hold, so nothing of it is written on the next route (quiet-swap.md 2b).
  function navigated(now?: boolean) {
    endPass();
    stopHold();
    void personalize(true, undefined, now);
  }
  /** The visitor answered the question: this page again, with the answer in the carry. */
  function chosen() {
    navigated(true);
  }
  watchNavigation(() => navigated());
  // A route the page took before a core in its own file came (it watches
  // from here on): the load's pass ends as it would have, the route gets its own.
  if (normalizePath(location.pathname) !== page.first.here) navigated();
}
