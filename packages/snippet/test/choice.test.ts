/**
 * The visitor's own choice as a bar at the bottom of the screen
 * (docs/specs/direct-visitors.md §2, mock overlay.html): its look is read
 * from the page (the paragraph's type and colour, the main button's corners,
 * the ground behind the hero); it sits over what is docked at the bottom,
 * waits while a consent banner is open, and is not shown when the bottom is
 * crowded or the text would be faint; one `choice` row with one fixed word;
 * an answer is one word in the tab's carry, then the pass runs again; asked
 * once per tab; the preview keeps and sends nothing.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Q = {
  t: "What brings you here?",
  a: [
    ["a", "I'm a broker"],
    ["b", "I run a PE fund"],
    ["c", "I'm selling my company"],
  ],
  s: ["a.cta"],
  // The customer keeps returning visitors (ADR 0039).
  m: 1 as const,
};
const HTML = `<section class="hero" style="background-color:rgb(246, 243, 236)">
  <div class="col" style="padding-left:56px;padding-right:56px;text-align:left">
    <h1 style="color:rgb(28, 42, 36)">Deal documents, written fast.</h1>
    <p style="font-family:Georgia;font-size:20px;color:rgb(20, 30, 40)">Information memoranda and buyer decks, drafted in days and checked line by line.</p>
    <div class="row"><a class="cta" href="#" style="font-family:Inter;border-top-left-radius:12px">Start</a></div>
  </div>
</section>`;

let sent: Array<Record<string, unknown>>;
let w: Window & typeof globalThis;
/** What `elementsFromPoint` finds at the bottom of the screen. */
let atBottom: Element[];

const box = (el: Element, r: { top: number; left?: number; width?: number; height?: number }) => {
  const left = r.left ?? 0;
  const width = r.width ?? 600;
  const height = r.height ?? 40;
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      top: r.top,
      bottom: r.top + height,
      left,
      right: left + width,
      width,
      height,
    }) as DOMRect;
};

function page(opts: { reserve?: boolean; html?: string } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head></head><body>${opts.html ?? HTML}</body></html>`,
    { url: "https://site.test/" },
  );
  w = dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(w, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(w, "innerWidth", { configurable: true, value: 1280 });
  for (const k of [
    "window",
    "document",
    "location",
    "sessionStorage",
    "localStorage",
    "Element",
    "Node",
  ])
    vi.stubGlobal(k, k === "window" ? w : (w as never)[k]);
  vi.stubGlobal("getComputedStyle", w.getComputedStyle.bind(w));
  vi.stubGlobal("navigator", { language: "en", sendBeacon: undefined });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.includes("/event")) sent.push(JSON.parse(String(init?.body ?? "{}")));
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  atBottom = [];
  w.document.elementsFromPoint = () => atBottom;
  if (opts.reserve) {
    const s = w.document.createElement("style");
    s.id = "__rawuser-q";
    w.document.head.appendChild(s);
  }
  const d = w.document;
  const col = d.querySelector(".col");
  if (col) box(col, { top: 80, left: 0, width: 760, height: 400 });
  const h1 = d.querySelector("h1");
  if (h1) box(h1, { top: 100, left: 56, height: 120 });
  const p = d.querySelector("p");
  if (p) box(p, { top: 240, left: 56, height: 60 });
  const cta = d.querySelector(".cta");
  if (cta) box(cta, { top: 330, left: 56, width: 120, height: 50 });
  return w;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  sent = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function run(q: unknown = Q, again = vi.fn()) {
  const { choice } = await import("../src/choice.ts");
  choice(q, { c: "acme", e: "https://edge.test" }, again);
  return again;
}
const bar = () => w.document.getElementById("__rawuser-ask");
const buttons = () => Array.from(bar()?.querySelectorAll("button") ?? []);
const answer = (text: string) => buttons().find((b) => b.textContent === text);
const shownRow = { event_type: "choice", page_path: "/", cohort: "no_signal", ch: "shown" };

describe("the bar takes the page's look", () => {
  it("comes up after the page shows, in the paragraph's type and colour, the button's corners", async () => {
    page();
    await run();
    expect(bar()?.style.visibility).toBe("hidden");
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(900);
    const el = bar() as HTMLElement;
    expect(el.style.visibility).toBe("");
    expect(el.style.position).toBe("fixed");
    expect(el.style.zIndex).toBe("2147483647");
    expect(el.style.fontFamily).toBe("Georgia");
    expect(el.style.fontSize).toBe("17px");
    expect(el.style.color).toBe("rgb(20, 30, 40)");
    expect(el.style.background).toContain("rgb(246, 243, 236)");
    expect(el.getAttribute("role")).toBe("region");
    expect(el.getAttribute("aria-label")).toBe("What brings you here?");
    const b = answer("I'm a broker") as HTMLButtonElement;
    expect(b.style.fontFamily).toBe("Inter");
    expect(b.style.borderRadius).toBe("12px");
    expect(b.style.border).toContain("rgba(20, 30, 40, 0.32)");
    // Close comes after the question in the page's order (first for a keyboard
    // after the question); on one line it is drawn last.
    expect(buttons().map((x) => x.textContent)).toEqual([
      "×",
      "I'm a broker",
      "I run a PE fund",
      "I'm selling my company",
    ]);
    // Left edge of the hero's text column, never over the page's own layout.
    expect(el.style.left).toBe("56px");
    expect(el.style.bottom).toBe("24px");
    expect(sent).toEqual([shownRow]);
    expect(sessionStorage.getItem("__rw_q")).toBe("1");
  });

  it("a centred hero gets a centred bar", async () => {
    page({
      html: HTML.replace("text-align:left", "text-align:center").replace(
        "<h1 ",
        '<h1 align="center" ',
      ),
    });
    (w.document.querySelector("h1") as HTMLElement).style.textAlign = "center";
    await run();
    await vi.advanceTimersByTimeAsync(900);
    // The column's middle (56 to 704 is 380), the bar's width 0 in jsdom.
    expect(bar()?.style.left).toBe("380px");
  });

  it("no main button: the paragraph's type and square corners", async () => {
    page();
    await run({ ...Q, s: ["button.none"] });
    await vi.advanceTimersByTimeAsync(900);
    const b = answer("I'm a broker") as HTMLButtonElement;
    expect(b.style.fontFamily).toBe("Georgia");
    expect(b.style.borderRadius).toBe("0px");
    expect(sent.map((e) => e.ch)).toEqual(["shown"]);
  });

  it("no confirmed button: the first filled one under the headline lends its look", async () => {
    page({
      html: HTML.replace(
        "font-family:Inter;",
        "font-family:Inter;background-color:rgb(31, 77, 58);",
      ),
    });
    await run({ ...Q, s: [] });
    await vi.advanceTimersByTimeAsync(900);
    const b = answer("I'm a broker") as HTMLButtonElement;
    expect(b.style.fontFamily).toBe("Inter");
    expect(b.style.borderRadius).toBe("12px");
  });

  it("no headline: `anchor`, nothing drawn, the tab asked", async () => {
    page({ html: '<p>Nothing here to read a look from.</p><a class="cta">Go</a>' });
    await run();
    await vi.advanceTimersByTimeAsync(900);
    expect(bar()).toBeNull();
    expect(sent.map((e) => e.ch)).toEqual(["anchor"]);
    expect(sessionStorage.getItem("__rw_q")).toBe("1");
  });

  it("white words over a hero photo on a white page: the page's own text colour", async () => {
    page({
      html: HTML.replace('style="background-color:rgb(246, 243, 236)"', "")
        .replace("color:rgb(20, 30, 40)", "color:rgb(255, 255, 255)")
        .replace("color:rgb(28, 42, 36)", "color:rgb(255, 255, 255)"),
    });
    w.document.body.style.backgroundColor = "rgb(255, 255, 255)";
    w.document.body.style.color = "rgb(51, 51, 51)";
    await run();
    await vi.advanceTimersByTimeAsync(900);
    expect(bar()?.style.color).toBe("rgb(51, 51, 51)");
    expect(sent.map((e) => e.ch)).toEqual(["shown"]);
  });

  it("text that would be faint on the ground: `fit`, nothing drawn", async () => {
    page({
      html: HTML.replace("color:rgb(20, 30, 40)", "color:rgb(230, 228, 222)").replace(
        "color:rgb(28, 42, 36)",
        "color:rgb(235, 232, 226)",
      ),
    });
    w.document.body.style.color = "rgb(240, 240, 240)";
    await run();
    expect(bar()).toBeNull();
    expect(sent.map((e) => e.ch)).toEqual(["fit"]);
  });

  it("a reserve left by a script from before the bar goes at once", async () => {
    page({ reserve: true });
    await run();
    expect(w.document.getElementById("__rawuser-q")).toBeNull();
  });
});

describe("every answer whole", () => {
  it("on a phone the answers wrap under the question, nothing scrolls sideways", async () => {
    page();
    Object.defineProperty(w, "innerWidth", { configurable: true, value: 390 });
    await run();
    await vi.advanceTimersByTimeAsync(900);
    const strip = answer("I'm a broker")?.parentElement as HTMLElement;
    expect(bar()?.style.flexWrap).toBe("wrap");
    expect(strip.style.flexWrap).toBe("wrap");
    expect(strip.style.overflowX).toBe("");
    expect(strip.style.flex).toBe("1 1 100%");
  });
});

describe("over what is docked, covering none", () => {
  it("sits above a chat bubble or a sticky bar at the bottom", async () => {
    page();
    const chat = w.document.createElement("div");
    chat.style.position = "fixed";
    w.document.body.appendChild(chat);
    box(chat, { top: 720, left: 1200, width: 56, height: 56 });
    atBottom = [chat];
    await run();
    await vi.advanceTimersByTimeAsync(900);
    // 800 - 720 + 24
    expect(bar()?.style.bottom).toBe("104px");
    expect(sent.map((e) => e.ch)).toEqual(["shown"]);
  });

  it("waits while a cookie banner is open, then comes up", async () => {
    page();
    const banner = w.document.createElement("div");
    banner.id = "cookie-notice";
    banner.style.position = "fixed";
    w.document.body.appendChild(banner);
    box(banner, { top: 700, width: 1280, height: 100 });
    atBottom = [banner];
    await run();
    await vi.advanceTimersByTimeAsync(5000);
    expect(bar()?.style.visibility).toBe("hidden");
    expect(sent).toEqual([]);
    banner.remove();
    atBottom = [];
    await vi.advanceTimersByTimeAsync(500);
    expect(bar()?.style.visibility).toBe("");
    expect(sent.map((e) => e.ch)).toEqual(["shown"]);
  });

  it("a banner that never closes: nothing shown, nothing sent", async () => {
    page();
    const banner = w.document.createElement("div");
    banner.className = "cc-consent-banner";
    banner.style.position = "fixed";
    w.document.body.appendChild(banner);
    box(banner, { top: 700, width: 1280, height: 100 });
    atBottom = [banner];
    await run();
    await vi.advanceTimersByTimeAsync(130000);
    expect(bar()).toBeNull();
    expect(sent).toEqual([]);
    expect(sessionStorage.getItem("__rw_q")).toBeNull();
  });

  it("a crowded bottom (the bar would rise over 45% of the screen): `fit`", async () => {
    page();
    const sheet = w.document.createElement("div");
    sheet.style.position = "fixed";
    w.document.body.appendChild(sheet);
    box(sheet, { top: 340, width: 1280, height: 460 });
    atBottom = [sheet];
    await run();
    await vi.advanceTimersByTimeAsync(900);
    expect(bar()).toBeNull();
    expect(sent.map((e) => e.ch)).toEqual(["fit"]);
  });
});

describe("answering and closing", () => {
  it("an answer is one word in the carry, the bar names it, the pass runs again, then it leaves", async () => {
    page();
    const again = await run();
    await vi.advanceTimersByTimeAsync(900);
    answer("I'm a broker")?.click();
    expect(JSON.parse(sessionStorage.getItem("__rw_carry") ?? "{}")).toMatchObject({
      i: "qa",
      s: "direct",
    });
    expect(sessionStorage.getItem("__rw_q")).toBe("a");
    // Remembered by the browser for a later visit: the visitor's own code,
    // its first page, the slot, when, and the answer as its latest reason.
    const pick = JSON.parse(localStorage.getItem("__rw_pick") ?? "{}");
    expect(Object.keys(pick)).toEqual(["p", "f", "s", "t", "k"]);
    expect(pick.s).toBe("a");
    expect(pick.k).toBe("ra:direct");
    expect(pick.p).toMatch(/^[0-9a-f]{32}$/);
    expect(again).toHaveBeenCalledTimes(1);
    expect(bar()?.textContent).toContain("✓ I'm a broker");
    expect(bar()?.querySelector("[aria-live]")?.textContent).toBe("I'm a broker");
    // One `answered` row: the slot and the visitor's code, nothing else about the click.
    const answered = { ...shownRow, ch: "answered", qa: "a", pid: pick.p };
    expect(sent).toEqual([shownRow, answered]);
    await vi.advanceTimersByTimeAsync(1300);
    expect(bar()).toBeNull();
    expect(sent).toEqual([shownRow, answered]);
    // A later answer in another tab keeps the same code.
    sessionStorage.clear();
    sent = [];
    await run();
    await vi.advanceTimersByTimeAsync(900);
    answer("I run a PE fund")?.click();
    expect(JSON.parse(localStorage.getItem("__rw_pick") ?? "{}")).toMatchObject({
      s: "b",
      p: pick.p,
      f: pick.f,
      k: "rb:direct",
    });
  });

  it("a customer that keeps no returning visitors: the answer lives in the tab only, no code", async () => {
    page();
    await run({ ...Q, m: undefined });
    await vi.advanceTimersByTimeAsync(900);
    answer("I'm a broker")?.click();
    expect(sessionStorage.getItem("__rw_q")).toBe("a");
    expect(localStorage.getItem("__rw_pick")).toBeNull();
    expect(sent).toEqual([shownRow, { ...shownRow, ch: "answered", qa: "a" }]);
  });

  it("close: `closed` once, gone, the tab asked", async () => {
    page();
    await run();
    await vi.advanceTimersByTimeAsync(900);
    answer("×")?.click();
    answer("×")?.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(bar()).toBeNull();
    expect(sent.map((e) => e.ch)).toEqual(["shown", "closed"]);
    expect(sessionStorage.getItem("__rw_q")).toBe("1");
  });

  it("the close button is named in the page's language", async () => {
    page();
    w.document.documentElement.lang = "az";
    await run();
    expect(answer("×")?.getAttribute("aria-label")).toBe("Bağla");
  });

  it("asked once per tab", async () => {
    page();
    sessionStorage.setItem("__rw_q", "1");
    await run();
    await vi.advanceTimersByTimeAsync(900);
    expect(bar()).toBeNull();
    expect(sent).toEqual([]);
  });

  it("a question it cannot read: nothing", async () => {
    page();
    await run({ t: "Q?", a: [], s: [] });
    await vi.advanceTimersByTimeAsync(900);
    expect(bar()).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("the preview", () => {
  it("draws at once, keeps and sends nothing", async () => {
    page();
    const again = await run({ ...Q, p: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(bar()?.style.visibility).toBe("");
    answer("I'm a broker")?.click();
    answer("×")?.click();
    expect(sent).toEqual([]);
    expect(sessionStorage.getItem("__rw_carry")).toBeNull();
    expect(sessionStorage.getItem("__rw_q")).toBeNull();
    expect(localStorage.getItem("__rw_pick")).toBeNull();
    expect(again).not.toHaveBeenCalled();
  });
});
