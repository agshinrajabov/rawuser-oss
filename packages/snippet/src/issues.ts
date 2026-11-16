/**
 * What went wrong on this page load, for us to fix before the customer sees
 * it (docs/specs/snippet-issues.md). Closed codes, a slot from our own
 * manifest paths and a coarse closed number; at most three per load, sent
 * as `snippet_issue` a second after the reveal, nothing on a clean load.
 * Never an error message, a stack, page text, a selector, a URL or a device
 * value (privacy review conditions 1 to 4). Every function here is safe to call
 * from anywhere: it cannot throw into the page.
 *
 * One send per load, with one exception (F7, 2026-10-12): a written load
 * used to hold its list for the ten seconds the hold counts its restores,
 * and a visitor who left inside them took the list along wherever the
 * browser sends nothing from a page that is going (WebKit to another site:
 * 0 of 4, whatever the transport). Now the list goes a second after the
 * reveal on every load, and `reverted`, the one code that needs the ten
 * seconds, follows alone in a second event when it happened.
 */

export type IssueCode =
  | "select_failed"
  | "reveal_cap"
  | "apply_error"
  | "rich_failed"
  | "lines_changed"
  | "swap_shift"
  | "reverted"
  | "late_tag";

export interface Issue {
  c: IssueCode;
  s?: string;
  n?: number;
}

/** The edge's slot rule: one of our own manifest paths, at most 40 characters. */
const SLOT = /^[a-z_]+(\.[a-z_]+){1,3}$/;
const MAX = 3;

let list: Issue[] = [];
let open = false;
let hooks: Array<() => void> = [];
let send: ((issues: Issue[]) => void) | undefined;
/** The load's first send has gone: only the hold's count may still follow. */
let sentOnce = false;
/** The part being written now, for an exception whose slot the catch does not know. */
let writing: string | undefined;
/**
 * The frames that render this load's writes, on the page's own clock: from
 * a write to the animation frame after the one that renders it (watchShift).
 * A shift outside them is the page's own. Local, never sent.
 */
let frames: Array<[number, number]> = [];
/** A write's window is open and its frame not yet begun: a write now lands in the same frame. */
let pend = false;

/**
 * Note one issue. The same code and slot again updates its number (a fit
 * again after the page's fonts arrive is the truth); a number of 0 takes it
 * back (the lines held after all). A slot outside the rule is left off.
 */
export function noteIssue(c: IssueCode, s?: string, n?: number): void {
  // After the first send a code already sent is never sent again for this
  // load, so nothing but `reverted` is taken.
  if (!open || (sentOnce && c !== "reverted")) return;
  const slot = s && s.length <= 40 && SLOT.test(s) ? s : undefined;
  const i = list.findIndex((x) => x.c === c && x.s === slot);
  const had = list[i];
  if (had) {
    if (n === 0) list.splice(i, 1);
    else if (n !== undefined) had.n = n;
    return;
  }
  if (n === 0 || list.length >= MAX) return;
  const it: Issue = { c };
  if (slot) it.s = slot;
  if (n !== undefined) it.n = n;
  list.push(it);
}

/** An exception in the write path. The caught error itself is never read (condition 4). */
export function noteError(s = writing): void {
  noteIssue("apply_error", s);
}

/** The part the write path is on now (apply.ts), or undefined between parts. */
export function setWriting(s?: string): void {
  writing = s;
  // A part is written: the frame that renders it is where our shift is.
  if (s && !pend) {
    pend = true;
    const w: [number, number] = [performance.now(), Number.POSITIVE_INFINITY];
    frames.push(w);
    try {
      requestAnimationFrame(() => {
        pend = false;
        // Called before the next frame's layout: its shifts come after this.
        requestAnimationFrame(() => {
          w[1] = performance.now();
        });
      });
    } catch {
      // No frames here: the window stays open to the observer's end.
    }
  }
}

/** Runs once just before the send (a counter or an observer closing its window). */
export function onIssueFlush(fn: () => void): void {
  if (open) hooks.push(fn);
}

/**
 * Send what this load has noted; nothing when that is nothing. `last` (the
 * default) first lets every counter close its window, then closes the list.
 * Not last: the list stays open for the hold's count alone.
 */
export function flushIssues(last = true): void {
  if (last) {
    const h = hooks;
    hooks = [];
    for (const f of h) {
      try {
        f();
      } catch {
        // a hook that fails adds nothing
      }
    }
  }
  const l = list;
  const s = send;
  list = [];
  sentOnce = true;
  if (last) {
    open = false;
    send = undefined;
  }
  if (l.length > 0 && s) {
    try {
      s(l);
    } catch {
      // analytics is best effort
    }
  }
}

/**
 * The visitor is leaving the page (or hiding the tab) with `/select` still
 * on its way (`pending`, only when the page goes), or after it failed as a
 * network error not yet sent: that failure is the exit's, not the edge's
 * (F1, `select_failed` 4). A 2 is provisional until its list is sent, so
 * the kind is settled here, at the exit's own send, or stays 2 at the timed
 * one. Never over our own timeout (1) or an answer we could not use (3),
 * and never after the list went (`noteIssue` takes no more). Presence only:
 * no time is read or kept.
 */
export function leftAsking(pending: boolean): void {
  const had = list.find((x) => x.c === "select_failed");
  if (had ? had.n === 2 : pending) noteIssue("select_failed", undefined, 4);
}

let load = 0;

/**
 * A new load (or a client-side route): the previous one is sent first.
 * Returns this load's own send, a no-op once a later load has started.
 */
/** A deleted customer's load: what was noted is discarded, never sent. */
export function dropIssues(): void {
  hooks = [];
  list = [];
  open = false;
  send = undefined;
}

export function startIssues(sender: (issues: Issue[]) => void): (last?: boolean) => void {
  flushIssues();
  const mine = ++load;
  send = sender;
  open = true;
  sentOnce = false;
  frames = [];
  pend = false;
  return (last) => {
    if (mine === load) flushIssues(last);
  };
}

interface Shift {
  value: number;
  hadRecentInput: boolean;
  startTime: number;
}

/**
 * Layout shift of our writes (condition 3): shifts without recent input in
 * a frame that renders a write of ours, up to 1,000 ms after the reveal,
 * summed here and sent as a bucket only. Reads `value`, `hadRecentInput` and `startTime` of each
 * entry and nothing else (never `sources`, rects or nodes). Nothing where
 * the engine has no layout-shift entries (WebKit).
 *
 * Our shift is one in the frame that renders a write of ours (`frames`):
 * a write moves the page in the next frame it renders, nowhere else. Before
 * it we had changed nothing but `visibility`, which keeps the box (A11,
 * the pilot site's own font shift, 2026-10-12); after it the page moves by
 * itself (Framer's own layout after hydration, which our write waits for:
 * 0.0107 at 1280 on 18 of 18 written loads, 2026-10-25).
 */
export function watchShift(): void {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes("layout-shift")) return;
    const t0 = performance.now();
    let sum = 0;
    let done = false;
    const add = (entries: PerformanceEntryList) => {
      for (const e of entries as unknown as Shift[]) {
        const t = e.startTime;
        if (!e.hadRecentInput && t <= t0 + 1000 && frames.some(([a, b]) => t >= a && t < b))
          sum += e.value;
      }
    };
    const po = new PerformanceObserver((l) => add(l.getEntries()));
    po.observe({ type: "layout-shift", buffered: true });
    const end = () => {
      if (done) return;
      done = true;
      try {
        add(po.takeRecords());
      } catch {
        // the records already delivered stand
      }
      po.disconnect();
      const b = sum > 0.25 ? 4 : sum > 0.1 ? 3 : sum > 0.05 ? 2 : sum > 0.01 ? 1 : 0;
      if (b) noteIssue("swap_shift", undefined, b);
    };
    setTimeout(end, 1000);
    onIssueFlush(end);
  } catch {
    // no observer here: nothing measured, nothing sent
  }
}
