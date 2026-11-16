/**
 * A contact form's Send button as the counted action, as a click only
 * (docs/specs/pilot-gaps.md, E1.1; the privacy review's Q3, four
 * conditions). The first two are proved here:
 *
 * 1. Click only. The whole snippet boots on a page with a contact form
 *    (name, phone, message), the fields hold distinctive typed strings, and
 *    the Send button is clicked: on a child node of a `<button>`, as the
 *    synthetic click a browser fires on the default button when Enter is
 *    pressed in a field, and on an `<input type=submit>`. The conversion
 *    payload has exactly the proof engine's keys, and no typed string, nor
 *    any 4-character window of one, is in any request body or URL the
 *    snippet sends. It fires on an invalid form too (a required field
 *    empty): the click is counted, never the form's outcome.
 * 2. Static. The built core, rich.js and the per-customer script's prefix
 *    register listeners only for a closed list of event names: never
 *    `input`, `change`, `keydown`, `keyup`, `focus`, `blur` or `submit`;
 *    and the core holds no `FormData`, `checkValidity` or `requestSubmit`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRich, buildSnippet } from "../build.ts";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";
const BODY_ID = "fedcba9876543210";
const CONV = [
  {
    section_path: "count:/",
    conversion_label: "contact",
    css: ["#send"],
    text: ["Göndər"],
    structural: "",
  },
  {
    section_path: "forms.submit_label",
    conversion_label: "contact",
    css: ["#send2"],
    text: ["Göndər"],
    structural: "",
  },
];
const variant = {
  customer_id: "acme",
  profile_key: "intent:problem",
  sections: { hero: { kind: "hero", headline: "New headline" } },
  generated_at: 0,
  prompt_hash: "h",
  body_id: BODY_ID,
};
const treat = {
  source: "kv",
  cohort: "personalized",
  arm: "treat",
  body_id: BODY_ID,
  variant_key: "v1:variant:acme:problem:ai",
  selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
  variant,
  targets: { "hero.headline": { css: ["h1.hero"], text: [], structural: "" } },
  carryable: true,
  conversion_targets: CONV,
};

/** What a visitor types: nothing of it may leave the page. */
const TYPED = {
  name: "Qəribov Zülfüqar",
  phone: "+000 55 555 01 12",
  message: "Sabah saat on birdə zəng edin, qiymət soruşuram",
};

const HTML = `<h1 class="hero">Old headline</h1>
<form id="f" action="/thanks" method="post">
  <input id="name" name="name" required>
  <input id="phone" name="phone" type="tel">
  <textarea id="message" name="message"></textarea>
  <button type="submit" id="send"><span class="ico">→</span> Göndər</button>
</form>
<form id="g" action="/thanks2" method="post">
  <input id="q" name="q" required>
  <input type="submit" id="send2" value="Göndər">
</form>`;

interface Sent {
  url: string;
  raw: string;
  body: Record<string, unknown>;
}
let sent: Sent[];
let urls: string[];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function page() {
  // jsdom cannot navigate: a valid form's submission after the click is
  // "not implemented", which is noise here, not a failure.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${HTML}</body></html>`, {
    url: "https://site.test/",
    virtualConsole,
  });
  const w = dom.window;
  parsing(w.document);
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", w.document);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("history", w.history);
  vi.stubGlobal("sessionStorage", w.sessionStorage);
  vi.stubGlobal("navigator", { language: "en", sendBeacon: undefined });
  vi.stubGlobal("MutationObserver", w.MutationObserver);
  vi.stubGlobal("Element", w.Element);
  vi.stubGlobal("Node", w.Node);
  vi.stubGlobal("HTMLElement", w.HTMLElement);
  vi.stubGlobal("HTMLAnchorElement", w.HTMLAnchorElement);
  vi.stubGlobal("HTMLButtonElement", w.HTMLButtonElement);
  vi.stubGlobal("getComputedStyle", w.getComputedStyle.bind(w));
  vi.stubGlobal("PerformanceObserver", undefined);
  (w as unknown as { __rw: unknown }).__rw = { c: "acme", e: EDGE, h: { "/": ["h1.hero"] } };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    urls.push(url);
    if (url.startsWith(`${EDGE}/select`)) return Promise.resolve(json(treat));
    if (url.startsWith(`${EDGE}/carry`)) return Promise.resolve(json({ bodies: {} }));
    const raw = String(init?.body ?? "");
    if (url.startsWith(`${EDGE}/event`)) {
      sent.push({ url, raw, body: JSON.parse(raw) as Record<string, unknown> });
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

const conversions = () => sent.filter((s) => s.body.event_type === "conversion");
const el = <T extends Element>(sel: string) => document.querySelector(sel) as T;

/** The exact keys of a conversion sent from a treat page (proof-engine.md, C). */
const CONVERSION_KEYS = [
  "arm",
  "body_id",
  "cohort",
  "conversion_label",
  "event_type",
  "intent_dim",
  "page_path",
  "source_dim",
  "variant_key",
  "visit",
];

/** Every window of 4 characters of a typed string: none may be sent. */
function windows(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 4 <= s.length; i++) out.push(s.slice(i, i + 4));
  return out;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  urls = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function boot(ms = 5000) {
  await import("../src/index.ts");
  await vi.advanceTimersByTimeAsync(ms);
}

describe("condition 1: a form's Send button counts as a click only", () => {
  it("counts the click on a child node, the Enter-key click and a submit input; nothing typed leaves; invalid forms count too", async () => {
    const w = page();
    await boot();
    expect(document.querySelector("h1")?.textContent).toBe("New headline");

    // The visitor types; the name stays empty, so the first form is invalid.
    el<HTMLInputElement>("#phone").value = TYPED.phone;
    el<HTMLTextAreaElement>("#message").value = TYPED.message;
    expect(el<HTMLFormElement>("#f").checkValidity()).toBe(false);

    // 1. The arrow inside the button: closest() resolves the button.
    el<HTMLElement>("#send .ico").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    expect(conversions()).toHaveLength(1);

    // 2. Enter in a field: the browser fires a synthetic click on the
    //    default button (no coordinates). The field now holds the name.
    el<HTMLInputElement>("#name").value = TYPED.name;
    el<HTMLInputElement>("#q").value = TYPED.name;
    el<HTMLElement>("#send2").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    expect(conversions()).toHaveLength(2);

    // 3. A plain click on the <input type=submit>, the second form still invalid.
    el<HTMLInputElement>("#q").value = "";
    el<HTMLInputElement>("#send2").click();
    expect(conversions()).toHaveLength(3);

    for (const c of conversions()) {
      expect(Object.keys(c.body).sort()).toEqual(CONVERSION_KEYS);
      expect(c.body).toMatchObject({
        event_type: "conversion",
        conversion_label: "contact",
        page_path: "/",
        cohort: "personalized",
        arm: "treat",
        body_id: BODY_ID,
      });
      expect(c.url).toBe(`${EDGE}/event?cid=acme`);
    }

    // Nothing typed, nor any 4-character piece of it, in any body or URL.
    const everything = [...urls, ...sent.map((s) => s.raw)].join("\n");
    expect(everything.length).toBeGreaterThan(0);
    for (const typed of Object.values(TYPED)) {
      expect(everything).not.toContain(typed);
      for (const win of windows(typed)) expect(everything, win).not.toContain(win);
    }
  });

  it("a click outside the counted buttons, inside the form, counts nothing", async () => {
    const w = page();
    await boot();
    el<HTMLInputElement>("#name").value = TYPED.name;
    el<HTMLElement>("#name").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    el<HTMLElement>("#f").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    expect(conversions()).toHaveLength(0);
  });

  it("the core source reads no field: no submit listener, no validity, no FormData", () => {
    const dir = new URL("../src/", import.meta.url);
    // Every visitor module (src/*.ts; the picker under src/picker/ runs only
    // in the operator's pick mode and reads a submit input's label there).
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("conversions.ts");
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/FormData|checkValidity|requestSubmit|reportValidity/);
      expect(src, f).not.toMatch(
        /addEventListener\(\s*["'](submit|input|change|keydown|keyup|focus|blur)["']/,
      );
      expect(src, f).not.toMatch(/HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement/);
    }
  });
});

describe("condition 2: the visitor scripts listen to a closed list of events", () => {
  /** Every event name the visitor scripts may listen for. */
  const ALLOWED_EVENTS = new Set([
    "click",
    "load",
    "DOMContentLoaded",
    "resize",
    "popstate",
    "pagehide",
    "visibilitychange",
  ]);
  const FORBIDDEN = ["input", "change", "keydown", "keyup", "focus", "blur", "submit"];

  function listenerNames(js: string, what: string): string[] {
    const calls = js.match(/addEventListener\(/g) ?? [];
    const named = [...js.matchAll(/addEventListener\(\s*"([^"]*)"/g)].map((m) => m[1] ?? "");
    // Every registration names its event with a string literal.
    expect(named.length, `${what}: every addEventListener names a literal`).toBe(calls.length);
    return named;
  }

  it("the built core and rich.js", async () => {
    await buildSnippet();
    const core = readFileSync(new URL("../dist/snippet.js", import.meta.url), "utf8");
    const names = listenerNames(core, "snippet.js");
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(ALLOWED_EVENTS.has(n), `snippet.js listens for ${n}`).toBe(true);
    for (const f of FORBIDDEN) expect(names).not.toContain(f);
    expect(core).not.toMatch(/FormData|checkValidity|requestSubmit|reportValidity/);
    // The rich writers: static, they send nothing and listen only for resize.
    await buildRich();
    const rich = readFileSync(new URL("../dist/rich.js", import.meta.url), "utf8");
    for (const n of listenerNames(rich, "rich.js")) {
      expect(ALLOWED_EVENTS.has(n), `rich.js listens for ${n}`).toBe(true);
    }
    expect(rich).not.toMatch(/FormData|checkValidity|requestSubmit/);
  });

  it("the per-customer script adds only a configuration line before the core", () => {
    // /s/{id}.js is `window.__rw={...};` followed by the core (packages/edge
    // customer-script.ts, read here as text only): the prefix registers nothing.
    const edge = readFileSync(
      new URL("../../edge/src/customer-script.ts", import.meta.url),
      "utf8",
    );
    expect(edge).toContain("window.__rw=");
    expect(edge).not.toContain("addEventListener");
    expect(edge).not.toMatch(/FormData|checkValidity|requestSubmit/);
  });
});
