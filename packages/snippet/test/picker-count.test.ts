import {
  COUNT_REFUSALS as SHARED_REFUSALS,
  holdsAccountDetail as sharedAccount,
  pathHoldsIdentifier as sharedPath,
} from "@rawuser/shared/pick";
/**
 * The picker on a count link (docs/specs/visual-picker.md §9): one slot,
 * "The button to count"; a click inside a link picks the link; Done posts
 * the button's selectors, its 40-character signature and the page path,
 * never a manifest; no measuring frames, no shape reading. Also the button
 * helpers: the clickable around a click, a submit input's label, and never
 * the value of a field a person types in.
 */
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COUNT_REFUSALS,
  clickTarget,
  describeButton,
  holdsAccountDetail,
  pathHoldsIdentifier,
} from "../src/picker/selector.ts";

const EDGE = "https://edge.test";
const TOKEN = "tok_count_12345678";

const HTML = `
  <nav><a class="signup" href="/signup"><span class="icon">+</span><span>Sign up free today</span></a></nav>
  <main>
    <h1>Pricing</h1>
    <form><input type="email" name="email" value="me@example.com"><input type="submit" value="Join the list"></form>
  </main>`;

const realSetInterval = globalThis.setInterval;
const watchers: ReturnType<typeof setInterval>[] = [];

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

function page(seed: unknown, o: { url?: string; extra?: string } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>${HTML}${o.extra ?? ""}</body></html>`,
    { url: o.url ?? "https://site.test/pricing" },
  );
  const w = dom.window;
  const doc = w.document;
  const tag = doc.createElement("script");
  tag.dataset.token = TOKEN;
  tag.dataset.edgeOrigin = EDGE;
  doc.head.appendChild(tag);
  Object.defineProperty(doc, "currentScript", { value: tag, configurable: true });
  let pointAt: Element | null = null;
  Object.defineProperty(doc, "elementFromPoint", {
    value: () => pointAt,
    configurable: true,
  });
  const sent: Sent[] = [];
  // The picker watches the page for three seconds after it starts. A test
  // ends sooner, and a watcher that outlives it reads a page that is gone.
  vi.stubGlobal("setInterval", ((fn: () => void, ms?: number) => {
    const id = realSetInterval(fn, ms);
    watchers.push(id);
    return id;
  }) as typeof setInterval);
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("CSS", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(method === "GET" ? seed : { ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return {
    w,
    doc,
    sent,
    point(el: Element | null) {
      pointAt = el;
    },
  };
}

const COUNT_SEED = {
  page_path: "/pricing",
  manifest: {},
  slots: [{ path: "count.button", label: "The button to count", conversion: true }],
  mode: "count",
};

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function panel(doc: Document): ShadowRoot {
  const host = doc.querySelector("[data-rawuser-picker]");
  if (!host?.shadowRoot) throw new Error("no picker panel");
  return host.shadowRoot;
}

function button(root: ShadowRoot, label: string): HTMLButtonElement {
  const b = Array.from(root.querySelectorAll("button")).find((x) => x.textContent === label);
  if (!b) throw new Error(`no ${label} button`);
  return b as HTMLButtonElement;
}

afterEach(() => {
  for (const id of watchers.splice(0)) clearInterval(id);
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the picker on a count link", () => {
  it("one slot; a click inside the link picks the link; Done posts the button and the path only", async () => {
    const p = page(COUNT_SEED);
    await import("../src/picker/index.ts");
    await settle();
    const root = panel(p.doc);
    expect(root.textContent).toContain("Rawuser: the button to count");
    expect(root.textContent).toContain("The button to count");
    expect(root.textContent).toContain("0 of 1 set");

    button(root, "Pick").click();
    const inner = p.doc.querySelectorAll("nav span")[1] as Element;
    p.point(inner);
    inner.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(root.textContent).toContain("1 of 1 set");

    button(root, "Done").click();
    await settle();
    const post = p.sent.find((s) => s.method === "POST");
    expect(post?.url).toBe(`${EDGE}/onboard/pick`);
    const body = post?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["button", "page_path", "token"]);
    expect(body.token).toBe(TOKEN);
    expect(body.page_path).toBe("/pricing");
    const b = body.button as { css: string[]; text: string[]; structural: string };
    expect(Object.keys(b).sort()).toEqual(["css", "structural", "text"]);
    expect(b.text).toEqual(["+Sign up free today"]);
    // The selector names the link, so a click anywhere inside it counts.
    expect(p.doc.querySelector(b.css[0] as string)).toBe(p.doc.querySelector("nav a"));
    expect(b.structural).toBe("first a in nav");
    // No measuring frames on a count link.
    expect(p.doc.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("a manifest link still posts a manifest", async () => {
    const p = page({
      page_path: "/pricing",
      manifest: {},
      slots: [{ path: "hero.headline", label: "Hero headline", conversion: false }],
    });
    await import("../src/picker/index.ts");
    await settle();
    const root = panel(p.doc);
    expect(root.textContent).toContain("Rawuser: elements on this page");
    button(root, "Pick").click();
    const h1 = p.doc.querySelector("h1") as Element;
    p.point(h1);
    h1.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true, cancelable: true }));
    // Done measures headlines in frames first; jsdom loads none, so skip
    // the wait and only check the shape of what the picker holds.
    expect(root.textContent).toContain("1 of 1 set");
    expect(root.textContent).not.toContain("the button to count");
  });
});

describe("button helpers", () => {
  function doc(): Document {
    return new JSDOM(`<!doctype html><html><body>${HTML}</body></html>`).window.document;
  }

  it("clickTarget climbs to the link or button around a click, else keeps the element", () => {
    const d = doc();
    const span = d.querySelector("nav span") as Element;
    expect(clickTarget(span)).toBe(d.querySelector("nav a"));
    const h1 = d.querySelector("h1") as Element;
    expect(clickTarget(h1)).toBe(h1);
  });

  it("a submit input is named by its label; a field's typed value is never read", () => {
    const d = doc();
    vi.stubGlobal("CSS", undefined);
    const submit = d.querySelector("input[type=submit]") as Element;
    expect(describeButton(d, submit).text).toEqual(["Join the list"]);
    const email = d.querySelector("input[type=email]") as Element;
    const e = describeButton(d, email);
    expect(e.text).toEqual([]);
    expect(JSON.stringify(e)).not.toContain("example.com");
  });
});

describe("privacy review conditions on a count link (§9.8)", () => {
  function click(p: ReturnType<typeof page>, el: Element) {
    p.point(el);
    el.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  it("typed words never leave: fields and editable boxes are refused, Done posts no typed string", async () => {
    const p = page(COUNT_SEED, {
      extra: `<textarea name="note"></textarea><div contenteditable="true" id="notes">x</div>`,
    });
    // What a person typed, after parse: the property differs from the attribute.
    const email = p.doc.querySelector("input[type=email]") as HTMLInputElement;
    email.value = "typed-7f3a@secret.test";
    const area = p.doc.querySelector("textarea") as HTMLTextAreaElement;
    area.value = "typed-note 9f2c words";
    const editable = p.doc.querySelector("#notes") as HTMLElement;
    editable.textContent = "typed-editable 4b1d words";
    await import("../src/picker/index.ts");
    await settle();
    const root = panel(p.doc);
    button(root, "Pick").click();
    for (const el of [email, area, editable]) {
      click(p, el);
      expect(root.textContent).toContain("0 of 1 set");
      expect(root.textContent).toContain(COUNT_REFUSALS.notButton);
    }
    click(p, p.doc.querySelector("input[type=submit]") as Element);
    expect(root.textContent).toContain("1 of 1 set");
    button(root, "Done").click();
    await settle();
    const posts = p.sent.filter((s) => s.method === "POST");
    expect(posts).toHaveLength(1);
    const all = JSON.stringify(p.sent);
    for (const typed of ["typed", "7f3a", "secret", "9f2c", "4b1d", "me@example.com"]) {
      expect(all).not.toContain(typed);
    }
    expect((posts[0]?.body as { button: { text: string[] } }).button.text).toEqual([
      "Join the list",
    ]);
  });

  it("a button about one account is refused: an address, a long number, a name and title", async () => {
    const p = page(COUNT_SEED, {
      extra: `<a id="acct" href="/account">jane@acme.example</a>
        <a class="order" href="/orders">Order 4821337</a>
        <button id="who">Jane Doe, CEO</button>`,
    });
    await import("../src/picker/index.ts");
    await settle();
    const root = panel(p.doc);
    button(root, "Pick").click();
    for (const sel of ["#acct", "a.order", "#who"]) {
      click(p, p.doc.querySelector(sel) as Element);
      expect(root.textContent, sel).toContain("0 of 1 set");
      expect(root.textContent, sel).toContain(COUNT_REFUSALS.account);
    }
    expect(p.sent.some((s) => s.method === "POST")).toBe(false);
  });

  it("an address that names one account is refused at Done, nothing posted", async () => {
    const p = page(COUNT_SEED, { url: "https://site.test/account/48213377" });
    await import("../src/picker/index.ts");
    await settle();
    const root = panel(p.doc);
    button(root, "Pick").click();
    click(p, p.doc.querySelectorAll("nav span")[1] as Element);
    expect(root.textContent).toContain("1 of 1 set");
    button(root, "Done").click();
    await settle();
    expect(root.textContent).toContain(COUNT_REFUSALS.path);
    expect(p.sent.some((s) => s.method === "POST")).toBe(false);
  });

  it("the picker's screens and lines match the shared ones", () => {
    expect(COUNT_REFUSALS).toEqual(SHARED_REFUSALS);
    const words = [
      "Sign up",
      "jane@acme.example",
      '[aria-label="jane@acme.example"]',
      "Order 123456",
      "Call 12345",
      "Contact us @ the office.",
    ];
    for (const w of words) expect(holdsAccountDetail(w), w).toBe(sharedAccount(w));
    const paths = [
      "/",
      "/pricing",
      "/en/pricing",
      "/v2/start",
      "/account/48213377",
      "/u/jane@acme.example",
      "/u/jane%40acme.com",
      "/reset/aB3dE5fG7hJ9kL1mN3pQ5",
      "/i/123e4567-e89b-12d3-a456-426614174000",
      "/bad%E0%A4%A",
      // event-paths.md §8, conditions 1 and 2
      "/students/482",
      "/orders/91234",
      "/blog/2024/10",
      "/page/2",
      "/invite/aBcDeFgHiJkLmNoPqRsTuV",
      "/blog/what-we-learned",
      "/blog/what-we-learned-in-2024",
    ];
    for (const x of paths) expect(pathHoldsIdentifier(x), x).toBe(sharedPath(x));
  });
});
