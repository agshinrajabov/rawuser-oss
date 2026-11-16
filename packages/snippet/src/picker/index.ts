/**
 * The picker (docs/specs/visual-picker.md), loaded by the snippet only in
 * pick mode. Reads the seed manifest from the edge under the one-time
 * token, outlines what the detector found, lets the operator reassign or
 * add elements by clicking on the page, and posts the result back.
 *
 * Everything the picker draws lives in a shadow root on one host element
 * so the site's CSS and the picker's CSS never meet. Hover and click are
 * captured in the capture phase and stopped, so the site's own handlers
 * do not fire while picking. Esc leaves pick mode.
 */

import { runCapture, showCaptureNote } from "../capture.ts";
import { shortShapeLine } from "../shape.ts";
import { measureMetrics } from "./metrics.ts";
import {
  COUNT_REFUSALS,
  clickTarget,
  describeButton,
  describeElement,
  holdsAccountDetail,
  isClickable,
  pathHoldsIdentifier,
  visibleText,
} from "./selector.ts";
import type { PickedEntry } from "./selector.ts";

/** How often and how long the picker watches a part for text that changes by itself. */
const ANIMATION_READ_MS = 250;
const ANIMATION_READS = 12;

interface Slot {
  path: string;
  label: string;
  conversion: boolean;
}

interface Seed {
  page_path: string;
  manifest: Record<string, PickedEntry | { css: string[]; text: string[]; structural: string }>;
  slots: Slot[];
  /** "count": one slot, the button to count (docs/specs/visual-picker.md §9). */
  mode?: "count" | "choice";
  /** "choice": the question to show on this page, for the operator only (direct-visitors.md §2). */
  choice?: unknown;
}

const HOST_ATTR = "data-rawuser-picker";

const PANEL_CSS = `
:host{all:initial}
*{box-sizing:border-box}
.panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:320px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;color:#111;font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;border:1px solid #ddd;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.18)}
.head{padding:12px 14px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between}
.head b{font-size:13px}
.hint{padding:8px 14px;color:#666;font-size:12px;border-bottom:1px solid #f3f3f3}
.slot{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid #f3f3f3}
.slot .name{flex:1;min-width:0}
.slot .name small{display:block;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}
.slot .name small.miss{color:#b45309}
button{font:inherit;border:1px solid #ccc;background:#fff;color:#111;border-radius:6px;padding:4px 8px;cursor:pointer}
button.primary{background:#111;color:#fff;border-color:#111}
button.active{background:#2563eb;color:#fff;border-color:#2563eb}
button:disabled{opacity:.5;cursor:default}
.foot{padding:12px 14px;display:flex;gap:8px;align-items:center;justify-content:space-between}
.msg{padding:10px 14px;font-size:12px;color:#444}
.box{position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #2563eb;border-radius:3px;background:rgba(37,99,235,.08)}
.box.set{border-color:#16a34a;background:rgba(22,163,74,.06)}
.tag{position:absolute;left:-2px;top:-22px;background:#2563eb;color:#fff;font:11px/1 system-ui,sans-serif;padding:4px 6px;border-radius:3px;white-space:nowrap}
.box.set .tag{background:#16a34a}
`;

function bootPicker(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  const token = script?.dataset.token ?? "";
  const edgeOrigin = script?.dataset.edgeOrigin ?? "";
  if (!token || !edgeOrigin) return;
  // Capture mode (script-first onboarding): the snippet's capture moved here
  // from the visitor's file (faster-tag.md D, 2026-10-25). Same code, same
  // one-time token, same request; no picker is drawn.
  if (script?.dataset.mode === "capture") {
    void runCapture(token, edgeOrigin, { doc: document, win: window, fetchFn: fetch }).then((r) =>
      showCaptureNote(document, r.message),
    );
    return;
  }
  if (document.querySelector(`[${HOST_ATTR}]`)) return;

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  // The page's CSP nonce the snippet gave our script, as a property only.
  if (script?.nonce) style.nonce = script.nonce;
  style.textContent = PANEL_CSS;
  root.appendChild(style);
  const panel = document.createElement("div");
  panel.className = "panel";
  root.appendChild(panel);
  const boxes = document.createElement("div");
  root.appendChild(boxes);
  document.body.appendChild(host);

  const assigned = new Map<string, Element>();
  const entries = new Map<string, PickedEntry>();
  let slots: Slot[] = [];
  // A count link: one button, a conversion target, never a manifest. No
  // measurement, no shape or template reading, nothing but selectors.
  let count = false;
  let picking: Slot | null = null;
  let hoverEl: Element | null = null;
  let status = "";

  const hoverBox = document.createElement("div");
  hoverBox.className = "box";
  hoverBox.style.display = "none";
  boxes.appendChild(hoverBox);

  function place(box: HTMLElement, el: Element, label: string, set: boolean): void {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${r.left - 2}px`;
    box.style.top = `${r.top - 2}px`;
    box.style.width = `${r.width + 4}px`;
    box.style.height = `${r.height + 4}px`;
    box.className = set ? "box set" : "box";
    box.textContent = "";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = label;
    box.appendChild(tag);
  }

  const setBoxes = new Map<string, HTMLElement>();
  function drawAssigned(): void {
    for (const [path, box] of setBoxes) {
      if (!assigned.has(path)) {
        box.remove();
        setBoxes.delete(path);
      }
    }
    for (const [path, el] of assigned) {
      let box = setBoxes.get(path);
      if (!box) {
        box = document.createElement("div");
        boxes.appendChild(box);
        setBoxes.set(path, box);
      }
      const slot = slots.find((s) => s.path === path);
      place(box, el, slot?.label ?? path, true);
    }
  }

  /** A quote, byline or author block: the text would carry someone's name. */
  function looksLikeAPerson(el: Element): boolean {
    if (
      el.closest("blockquote, cite, q, figcaption, [itemprop='author'], [rel='author'], address")
    ) {
      return true;
    }
    const t = ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
    return /^[\p{Lu}][\p{L}'.-]+\s+[\p{Lu}][\p{L}'.-]+,?\s*(?:CEO|CTO|CFO|COO|founder|co-founder|director|manager|head|lead|owner)\b/iu.test(
      t,
    );
  }

  function isOurs(el: Element | null): boolean {
    return !!el && (el === host || host.contains(el));
  }

  function pickable(el: Element | null): el is Element {
    if (!el || isOurs(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "html" || tag === "body" || tag === "script" || tag === "style") return false;
    // A count link picks links and buttons only (§9.8, condition 1): never a
    // paragraph, a heading, a field or an editable box with typed words.
    if (count) return isClickable(el);
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
    return text.length > 0;
  }

  /** What the cursor points at; on a count link, the link or button around it. */
  function under(x: number, y: number): Element | null {
    const el = document.elementFromPoint(x, y);
    return count && el && !isOurs(el) ? clickTarget(el) : el;
  }

  function describe(el: Element, conversion: boolean, animated = false): PickedEntry {
    return count
      ? (describeButton(document, el) as PickedEntry)
      : describeElement(document, el, conversion, animated);
  }

  function render(): void {
    panel.textContent = "";
    const head = document.createElement("div");
    head.className = "head";
    head.innerHTML = count
      ? "<b>Rawuser: the button to count</b>"
      : "<b>Rawuser: elements on this page</b>";
    const close = document.createElement("button");
    close.textContent = "Close";
    close.onclick = () => teardown();
    head.appendChild(close);
    panel.appendChild(head);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = picking
      ? `Click the ${picking.label.toLowerCase()} on the page. Esc to cancel.`
      : count
        ? "Press Pick, click the button you want counted, then Done. Your page and its versions stay as they are."
        : "Green outlines are what Rawuser found. Press Pick to point at the right element, then Done.";
    panel.appendChild(hint);

    for (const slot of slots) {
      const row = document.createElement("div");
      row.className = "slot";
      const name = document.createElement("div");
      name.className = "name";
      const el = assigned.get(slot.path);
      const entry = entries.get(slot.path);
      name.innerHTML = `${slot.label}<small class="${el ? "" : "miss"}"></small>`;
      const small = name.querySelector("small") as HTMLElement;
      const keeps = el ? shortShapeLine(entry?.inline) : "";
      small.textContent = el
        ? `${entry?.text[0] ?? entry?.css[0] ?? "assigned"}${keeps ? ` · ${keeps}` : ""}`
        : entry
          ? count
            ? "not on this page"
            : "found in HTML, not on this page"
          : "not set";
      row.appendChild(name);
      const pick = document.createElement("button");
      pick.textContent = picking?.path === slot.path ? "Picking…" : el ? "Change" : "Pick";
      pick.className = picking?.path === slot.path ? "active" : "";
      pick.onclick = () => {
        picking = picking?.path === slot.path ? null : slot;
        render();
      };
      row.appendChild(pick);
      if (el) {
        const clear = document.createElement("button");
        clear.textContent = "Clear";
        clear.onclick = () => {
          assigned.delete(slot.path);
          entries.delete(slot.path);
          drawAssigned();
          render();
        };
        row.appendChild(clear);
      }
      panel.appendChild(row);
    }

    if (status) {
      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = status;
      panel.appendChild(msg);
    }

    const foot = document.createElement("div");
    foot.className = "foot";
    const tally = document.createElement("span");
    tally.textContent = `${assigned.size} of ${slots.length} set`;
    foot.appendChild(tally);
    const done = document.createElement("button");
    done.className = "primary";
    done.textContent = "Done";
    done.disabled = assigned.size === 0;
    done.onclick = () => submit();
    foot.appendChild(done);
    panel.appendChild(foot);
  }

  function onMove(e: MouseEvent): void {
    if (!picking) return;
    const el = under(e.clientX, e.clientY);
    if (!pickable(el)) {
      hoverBox.style.display = "none";
      hoverEl = null;
      return;
    }
    hoverEl = el;
    place(hoverBox, el, picking.label, false);
  }

  function onClick(e: MouseEvent): void {
    if (!picking) return;
    if (isOurs(e.target as Element)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = hoverEl ?? under(e.clientX, e.clientY);
    if (!pickable(el)) {
      if (count) refuse(COUNT_REFUSALS.notButton);
      return;
    }
    const entry = describe(el, picking.conversion);
    // Nothing about one account: an account chip, a name, an address or a
    // long number in its words or selectors (§9.8, condition 2).
    if (count && (looksLikeAPerson(el) || [...entry.css, ...entry.text].some(holdsAccountDetail))) {
      refuse(COUNT_REFUSALS.account);
      return;
    }
    if (count && entry.css.length === 0) {
      // No selector names this element alone; the snippet could not count it.
      status =
        "Rawuser cannot tell this element apart from others like it. Pick the button itself.";
      render();
      return;
    }
    assigned.set(picking.path, el);
    entries.set(picking.path, entry);
    status =
      !count && looksLikeAPerson(el)
        ? "That looks like a quote or a person's name. Rawuser rewrites headings and buttons; pick one of those instead if you meant to."
        : "";
    picking = null;
    hoverBox.style.display = "none";
    drawAssigned();
    render();
  }

  /** A count pick refused: nothing is set, the line says why. */
  function refuse(line: string): void {
    status = line;
    render();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && picking) {
      picking = null;
      hoverBox.style.display = "none";
      render();
    }
  }

  function onScrollResize(): void {
    drawAssigned();
    if (picking && hoverEl) place(hoverBox, hoverEl, picking.label, false);
  }

  function teardown(): void {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScrollResize, true);
    window.removeEventListener("resize", onScrollResize);
    host.remove();
  }

  async function submit(): Promise<void> {
    // Only what is on this page goes back: a seed entry the page could
    // not host stays visible in the list but is not re-submitted.
    const manifest: Record<string, PickedEntry> = {};
    for (const [path, entry] of entries) if (assigned.has(path)) manifest[path] = entry;
    // An address that names one account never leaves the page (§9.8, 3;
    // a manifest pick too since event-paths.md §8, condition 3).
    if (pathHoldsIdentifier(location.pathname)) return refuse(COUNT_REFUSALS.path);
    if (count) {
      const b = Object.values(manifest)[0];
      if (b)
        await post({
          button: { css: b.css, text: b.text, structural: b.structural },
          page_path: location.pathname,
        });
      return;
    }
    // How the page wraps each headline at three widths, for the versions'
    // lengths (docs/specs/interactive-text.md §3.4). A few seconds; a page
    // that refuses to be framed is saved without it.
    status =
      "Measuring the page at three widths. Your page opens three more times, hidden; your own analytics may count these visits.";
    render();
    try {
      const heads = Object.entries(manifest)
        .filter(([p, e]) => p.endsWith(".headline") && e.css[0])
        .map(([path, e]) => ({ path, css: e.css[0] as string }));
      const measured = await measureMetrics(heads);
      for (const [path, m] of Object.entries(measured)) {
        const e = manifest[path];
        if (e) e.metrics = m;
      }
    } catch {
      // saved without the measurement
    }
    await post({ manifest });
  }

  async function post(payload: Record<string, unknown>): Promise<void> {
    status = "Saving…";
    render();
    try {
      const r = await fetch(`${edgeOrigin}/onboard/pick`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...payload }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      status = j.ok
        ? "Saved. Return to the dashboard; this panel closes in a moment."
        : `Could not save: ${j.error ?? "unknown error"}`;
      render();
      if (j.ok) setTimeout(teardown, 4000);
    } catch {
      status = "Could not save (network).";
      render();
    }
  }

  // Find the seed's elements on the page with the same rules the snippet
  // uses, so the outlines show what visitors would get.
  function locate(entry: { css: string[]; text: string[] }): Element | null {
    for (const sel of entry.css) {
      try {
        const m = document.querySelectorAll(sel);
        if (m.length === 1) return m[0] ?? null;
      } catch {}
    }
    for (const sig of entry.text) {
      const scope = document.querySelector("main") ?? document.body;
      const want = sig.replace(/\s+/g, " ").trim();
      for (const el of Array.from(scope.querySelectorAll("*"))) {
        if (isOurs(el)) continue;
        const have = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (have.startsWith(want)) return el;
      }
    }
    return null;
  }

  status = "Loading…";
  render();
  fetch(`${edgeOrigin}/onboard/pick?token=${encodeURIComponent(token)}`, {
    credentials: "omit",
    cache: "no-store",
  })
    .then((r) => r.json() as Promise<Seed | { error: string }>)
    .then((seed) => {
      if ("error" in seed) {
        status = `This link is not valid any more (${seed.error}). Create a new one in the dashboard.`;
        render();
        return;
      }
      // The preview of the visitor's own choice (docs/specs/direct-visitors.md
      // §2): no panel; the row from rich.js on this page, for this operator
      // only. Nothing is picked, kept or sent.
      if (seed.mode === "choice") {
        host.remove();
        const s = document.createElement("script");
        if (script?.nonce) s.nonce = script.nonce;
        s.src = `${edgeOrigin}/rich.js`;
        s.async = true;
        s.onload = () =>
          (
            globalThis as {
              __rwx?: { choice?: (q: unknown, p: { c: string; e: string }, a: () => void) => void };
            }
          ).__rwx?.choice?.(seed.choice, { c: "", e: edgeOrigin }, () => {});
        document.head.appendChild(s);
        return;
      }
      slots = seed.slots;
      count = seed.mode === "count";
      for (const slot of slots) {
        const entry = seed.manifest[slot.path];
        if (!entry) continue;
        const el = locate(entry);
        if (el) {
          assigned.set(slot.path, el);
          entries.set(slot.path, describe(el, slot.conversion));
        } else {
          entries.set(slot.path, entry as PickedEntry);
        }
      }
      // Entries the page could not host stay in the list as "found in
      // HTML, not on this page"; submit() skips them unless re-picked.
      // Text that changes by itself (typewriter, rotating words): read again
      // every quarter second for three seconds; any read that differs marks
      // the part, which is then left alone or written by its template. Two
      // reads 400 ms apart missed a word that rotates every two seconds (the
      // 2026-09-29 survey, three runs of three).
      const firstRead = new Map<string, string>();
      for (const [path, el] of assigned) firstRead.set(path, visibleText(el));
      const marked = new Set<string>();
      let reads = 0;
      // A count link reads no shape: nothing to watch.
      const watch = setInterval(() => {
        if (count) return clearInterval(watch);
        reads++;
        let changed = false;
        for (const [path, el] of assigned) {
          if (marked.has(path) || firstRead.get(path) === visibleText(el)) continue;
          const slot = slots.find((s) => s.path === path);
          entries.set(path, describeElement(document, el, slot?.conversion ?? false, true));
          marked.add(path);
          changed = true;
        }
        if (changed) render();
        if (reads >= ANIMATION_READS) clearInterval(watch);
      }, ANIMATION_READ_MS);
      status = "";
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", onScrollResize, true);
      window.addEventListener("resize", onScrollResize);
      drawAssigned();
      render();
    })
    .catch(() => {
      status = "Could not reach Rawuser. Check your connection and reload.";
      render();
    });
}

bootPicker();
