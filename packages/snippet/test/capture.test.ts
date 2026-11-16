/**
 * Capture mode (script-first onboarding): the snippet only enters it when
 * the URL carries the one-time token, scrubs the token from the address,
 * serialises the rendered DOM without script/style/svg/iframe, and posts
 * it to the edge with credentials omitted.
 */

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureToken, runCapture, scrubCaptureParam, serializePage } from "../src/capture.ts";

function dom(body: string): Document {
  const doc = new JSDOM(
    `<!doctype html><html><head><script>alert(1)</script><style>h1{}</style></head><body>${body}</body></html>`,
  ).window.document;
  // JSDOM fires load asynchronously; the tests pass a settled document.
  Object.defineProperty(doc, "readyState", { value: "complete" });
  return doc;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("captureToken", () => {
  it("returns the token only when the parameter is present and well-formed", () => {
    expect(captureToken({ search: "?rawuser_capture=abcdef1234567890", hash: "" })).toBe(
      "abcdef1234567890",
    );
    // The fragment is the preferred carrier: never sent to any server.
    expect(
      captureToken({ search: "?utm_source=x", hash: "#rawuser_capture=abcdef1234567890" }),
    ).toBe("abcdef1234567890");
    expect(captureToken({ search: "?utm_source=x", hash: "" })).toBeNull();
    expect(captureToken({ search: "", hash: "" })).toBeNull();
    expect(captureToken({ search: "?rawuser_capture=<script>", hash: "" })).toBeNull();
    expect(captureToken({ search: "?rawuser_capture=short", hash: "" })).toBeNull();
  });
});

describe("scrubCaptureParam", () => {
  it("removes the token from the fragment and keeps the rest", () => {
    const calls: string[] = [];
    const win = {
      location: { href: "https://lumera.test/?utm_source=x#rawuser_capture=abcdef1234567890" },
      history: {
        state: null,
        replaceState: (_s: unknown, _t: string, url: string) => calls.push(url),
      },
    } as unknown as Window;
    scrubCaptureParam(win);
    expect(calls).toEqual(["https://lumera.test/?utm_source=x"]);
  });
});

describe("serializePage", () => {
  it("drops script, style, noscript, svg and iframe, keeps content", () => {
    const document = dom(
      "<h1>Salam</h1><svg><path/></svg><iframe src='x'></iframe><noscript>n</noscript><p>Mətn</p>",
    );
    const html = serializePage(document);
    expect(html).toContain("<h1>Salam</h1>");
    expect(html).toContain("<p>Mətn</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<noscript");
    // The live document is untouched.
    expect(document.querySelector("script")).not.toBeNull();
  });

  it("takes out what form fields hold, before anything leaves the page", () => {
    const document = dom(
      `<form><input type="email" value="dana@site.example" placeholder="Your email">` +
        `<input type="hidden" name="csrf" value="9f2c1e77aa">` +
        `<input name="first" value="Dana">` +
        `<textarea name="bio">I live at 5 Hill Road</textarea>` +
        `<input type="submit" value="Start free trial"></form><h1>Salam</h1>`,
    );
    const html = serializePage(document);
    expect(html).not.toMatch(/dana@site\.example|9f2c1e77aa|Dana|Hill Road/);
    // What the page says stays: the placeholder, the button's words, the copy.
    expect(html).toContain('placeholder="Your email"');
    expect(html).toContain('value="Start free trial"');
    expect(html).toContain("<h1>Salam</h1>");
    // The operator's own page keeps what was typed.
    expect((document.querySelector('input[type="email"]') as HTMLInputElement).value).toBe(
      "dana@site.example",
    );
    expect(document.querySelector("textarea")?.textContent).toBe("I live at 5 Hill Road");
  });
});

describe("runCapture", () => {
  it("posts the DOM under the token with credentials omitted, after load and settle", async () => {
    vi.useFakeTimers();
    const document = dom("<h1>Salam</h1>");
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchFn = ((url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, bytes: 40 }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    const win = {
      location: { origin: "https://lumera.test", pathname: "/", search: "", hash: "" },
      addEventListener: () => {},
    } as unknown as Window;
    const doc = document;

    const p = runCapture("abcdef1234567890", "https://edge.test", { doc, win, fetchFn }, 1500);
    await vi.advanceTimersByTimeAsync(1500);
    const r = await p;

    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req?.url).toBe("https://edge.test/onboard/capture");
    expect(req?.init.credentials).toBe("omit");
    const body = JSON.parse(String(req?.init.body)) as { token: string; url: string; html: string };
    expect(body.token).toBe("abcdef1234567890");
    expect(body.url).toBe("https://lumera.test/");
    expect(body.html).toContain("<h1>Salam</h1>");
  });

  it("reports the edge's error without throwing", async () => {
    vi.useFakeTimers();
    const fetchFn = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid or expired token" }), { status: 403 }),
      )) as unknown as typeof fetch;
    const win = {
      location: { origin: "https://lumera.test", pathname: "/", search: "", hash: "" },
      addEventListener: () => {},
    } as unknown as Window;
    const doc = dom("<p>x</p>");
    const p = runCapture("abcdef1234567890", "https://edge.test", { doc, win, fetchFn }, 0);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain("invalid or expired token");
  });
});
