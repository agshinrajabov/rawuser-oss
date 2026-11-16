/**
 * The render (docs/specs/install-friction.md A) and the privacy review
 * conditions it carries (ruling 2026-10-03): 1 logs, 2 isolation, 3 no fake
 * visit (the generation half). The browser is a fake that plays the request
 * sequence @cloudflare/puppeteer emits with interception on.
 */

import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotPublicUrlError } from "../../src/lib/public-url.ts";
import {
  DAILY_RENDER_CEILING,
  RenderError,
  type RenderErrorKind,
  disableUnseenTransports,
  looksLikeChallenge,
  renderPage,
} from "../../src/lib/render-page.ts";
import { INSTALL_ENV } from "../install-env.ts";
import { type FakeLog, type FakeSite, fakeLauncher, memoryKv, newLog } from "./fake-browser.ts";

const TEXT = "Northwind keeps your team's notes in one place, linked to the tickets. ".repeat(4);
const PAGE = `<html><head><title>Northwind</title></head><body><h1>Northwind</h1><p>${TEXT}</p></body></html>`;

let errors: string[];
let logs: string[];
let alerts: string[];

beforeEach(() => {
  errors = [];
  logs = [];
  alerts = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      if (url.hostname === "api.telegram.org") {
        alerts.push(url.searchParams.get("text") ?? "");
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected fetch ${url.hostname}`);
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function env(extra: Record<string, unknown> = {}) {
  return {
    BROWSER: { fetch: (async () => new Response("")) as typeof fetch },
    VARIANTS: memoryKv(),
    ALERT_WEBHOOK_URL: "https://api.telegram.org/botTEST/sendMessage?chat_id=1",
    ...INSTALL_ENV,
    ...extra,
  };
}

/** Public by default; a host listed here resolves to a private address. */
function dns(privateHosts: string[] = []) {
  return vi.fn(async (url: URL) => {
    if (privateHosts.includes(url.hostname)) throw new NotPublicUrlError("resolves-private");
  });
}

async function render(
  site: FakeSite,
  opts: {
    log?: FakeLog;
    env?: ReturnType<typeof env>;
    private?: string[];
    hardCapMs?: number;
  } = {},
) {
  const log = opts.log ?? newLog();
  const e = opts.env ?? env();
  const assertPublic = dns(opts.private);
  try {
    const result = await renderPage(new URL(site.hops[0] as string), e, {
      launch: fakeLauncher(site, log),
      assertPublic,
      sleep: async () => {},
      hardCapMs: opts.hardCapMs,
    });
    return { result, log, kind: null as RenderErrorKind | null, assertPublic };
  } catch (err) {
    expect(err).toBeInstanceOf(RenderError);
    return { result: null, log, kind: (err as RenderError).kind, assertPublic };
  }
}

describe("render: a page built in the browser", () => {
  it("returns the cleaned page and closes the browser", async () => {
    const { result, log, kind } = await render({ hops: ["https://spa.example.com/"], html: PAGE });
    expect(kind).toBeNull();
    expect(result?.html).toContain("<h1>Northwind</h1>");
    expect(log.launched).toBe(1);
    expect(log.closed).toBe(1);
  });

  it("reads the CSP metas of the rendered DOM", async () => {
    const html = PAGE.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="script-src &#39;self&#39;">`,
    );
    const { result } = await render({ hops: ["https://spa.example.com/"], html });
    expect(result?.meta_csp).toEqual(["script-src 'self'"]);
  });

  it("empty: still under 80 characters of text", async () => {
    const { kind, log } = await render({
      hops: ["https://spa.example.com/"],
      html: "<html><body><div id=root>Loading</div></body></html>",
    });
    expect(kind).toBe("empty");
    expect(log.closed).toBe(1);
  });

  it("cuts page.content() at 2 MB before cleaning, then the 50 KB cap applies", async () => {
    const html = `<html><body><h1>Top</h1><p>${TEXT}</p><script>${"x".repeat(2 * 1024 * 1024)}</script><h1>AfterTheCut</h1></body></html>`;
    const { result } = await render({ hops: ["https://spa.example.com/"], html });
    expect(result?.html.length).toBeLessThanOrEqual(50 * 1024);
    expect(result?.html).not.toContain("AfterTheCut");
  });
});

describe("render: SSRF guard inside the browser", () => {
  it("checks the URL before launch: a private literal never starts a browser", async () => {
    const { kind, log } = await render({ hops: ["http://127.0.0.1/"], html: PAGE });
    expect(kind).toBe("not_public");
    expect(log.launched).toBe(0);
  });

  it("checks the name before launch (DNS)", async () => {
    const { kind, log, assertPublic } = await render(
      { hops: ["https://sneaky.example.com/"], html: PAGE },
      { private: ["sneaky.example.com"] },
    );
    expect(kind).toBe("not_public");
    expect(log.launched).toBe(0);
    expect(assertPublic).toHaveBeenCalledTimes(1);
  });

  it("a redirect hop to a private address is aborted and the read fails as not_public", async () => {
    // Same site (www and the apex as one), but the name resolves private.
    const { kind, log, assertPublic } = await render(
      {
        hops: ["https://bounce.example.com/", "https://www.bounce.example.com/latest/"],
        html: PAGE,
      },
      { private: ["www.bounce.example.com"] },
    );
    expect(kind).toBe("not_public");
    // Before launch, then every document hop inside the browser.
    expect(assertPublic.mock.calls.map((c) => (c[0] as URL).hostname)).toEqual([
      "bounce.example.com",
      "bounce.example.com",
      "www.bounce.example.com",
    ]);
    expect(log.decisions.find((d) => d.url.includes("latest"))?.outcome).toBe("abort");
    expect(log.closed).toBe(1);
  });

  it("a main-frame hop to another host is aborted before any check and ends as off_host", async () => {
    const { kind, log, assertPublic } = await render({
      hops: ["https://bounce.example.com/", "https://metadata.example.com/latest/"],
      html: PAGE,
    });
    expect(kind).toBe("off_host");
    // The other host never reaches DNS, let alone a load.
    expect(assertPublic.mock.calls.map((c) => (c[0] as URL).hostname)).toEqual([
      "bounce.example.com",
      "bounce.example.com",
    ]);
    expect(log.decisions.find((d) => d.url.includes("metadata"))?.outcome).toBe("abort");
    expect(log.closed).toBe(1);
    expect(errors.join("\n")).not.toContain("metadata");
    expect(errors[0]).toMatch(/^\[rawuser\/render\] off_host url_id=[0-9a-f]{8}$/);
  });

  it("www and the apex are one site inside the browser", async () => {
    const { kind } = await render({
      hops: ["https://spa.example.com/", "https://www.spa.example.com/"],
      html: PAGE,
    });
    expect(kind).toBeNull();
  });

  it("subframe navigations and subresources are checked by syntax", async () => {
    const { kind, log } = await render({
      hops: ["https://spa.example.com/"],
      html: PAGE,
      subresources: [
        { url: "http://169.254.169.254/latest/meta-data/", type: "document", subframe: true },
        { url: "http://10.0.0.5/api", type: "fetch" },
        { url: "http://localhost:8080/x.js", type: "script" },
        { url: "https://cdn.example.net/app.js", type: "script" },
      ],
    });
    expect(kind).toBeNull();
    const outcome = (u: string) => log.decisions.find((d) => d.url === u)?.outcome;
    expect(outcome("http://169.254.169.254/latest/meta-data/")).toBe("abort");
    expect(outcome("http://10.0.0.5/api")).toBe("abort");
    expect(outcome("http://localhost:8080/x.js")).toBe("abort");
    expect(outcome("https://cdn.example.net/app.js")).toBe("continue");
  });
});

describe("render: condition 3, no fake visit", () => {
  it("aborts every request to a Rawuser host, whatever its type", async () => {
    const own = [
      "https://edge.example.com/s/northwind.js",
      "https://edge.example.com/select?cid=northwind",
      "https://edge-old.example.com/event",
      "https://rawuser-edge-production.some-account.workers.dev/carry",
      "https://rawuser-edge.someone.workers.dev/snippet.js",
      "https://api.example.com/onboard/capture",
    ];
    const { kind, log } = await render({
      hops: ["https://spa.example.com/"],
      html: PAGE,
      subresources: own.map((url, i) => ({ url, type: i === 0 ? "script" : "fetch" })),
    });
    expect(kind).toBeNull();
    for (const u of own) {
      expect(log.decisions.find((d) => d.url === u)?.outcome).toBe("abort");
    }
    expect(
      log.decisions.filter(
        (d) =>
          d.outcome === "continue" &&
          /edge\.example|edge-old\.example|api\.example|rawuser-/.test(d.url),
      ),
    ).toEqual([]);
  });

  it("aborts a page whose own document is one of ours", async () => {
    const { kind } = await render({ hops: ["https://edge.example.com/"], html: PAGE });
    expect(kind).not.toBeNull();
  });
});

describe("render: condition 2, isolation", () => {
  it("bypasses service workers, turns interception on and listens to requests only", async () => {
    const { log } = await render({ hops: ["https://spa.example.com/"], html: PAGE });
    expect(log.bypassServiceWorker).toBe(true);
    expect(log.interception).toBe(true);
    // No console or pageerror listener: their text carries URLs (condition 1).
    expect(log.listeners).toEqual(["request"]);
    // No user-agent change, no extra headers, no stealth (condition 2).
    expect(log.forbidden).toEqual([]);
  });

  it("removes WebSocket, WebTransport and EventSource before the page runs", async () => {
    const { log } = await render({ hops: ["https://spa.example.com/"], html: PAGE });
    expect(log.initScripts).toHaveLength(1);
    const frame: Record<string, unknown> = {
      WebSocket: class {},
      WebTransport: class {},
      EventSource: class {},
      Worker: class {},
      SharedWorker: class {},
      fetch: () => {},
    };
    frame.globalThis = frame;
    runInNewContext(`(${(log.initScripts[0] as () => void).toString()})()`, frame);
    expect(frame.WebSocket).toBeUndefined();
    expect(frame.WebTransport).toBeUndefined();
    expect(frame.EventSource).toBeUndefined();
    expect(frame.Worker).toBeUndefined();
    expect(frame.SharedWorker).toBeUndefined();
    // and a page script cannot put them back
    runInNewContext("try { WebSocket = function(){} } catch (e) {}", frame);
    expect(frame.WebSocket).toBeUndefined();
    expect(frame.fetch).toBeTypeOf("function");
    expect(disableUnseenTransports).toBe(log.initScripts[0]);
  });

  it("aborts images, media and fonts", async () => {
    const { log } = await render({
      hops: ["https://spa.example.com/"],
      html: PAGE,
      subresources: [
        { url: "https://cdn.example.net/hero.png", type: "image" },
        { url: "https://cdn.example.net/intro.mp4", type: "media" },
        { url: "https://cdn.example.net/inter.woff2", type: "font" },
        { url: "https://cdn.example.net/site.css", type: "stylesheet" },
      ],
    });
    const outcome = (u: string) => log.decisions.find((d) => d.url === u)?.outcome;
    expect(outcome("https://cdn.example.net/hero.png")).toBe("abort");
    expect(outcome("https://cdn.example.net/intro.mp4")).toBe("abort");
    expect(outcome("https://cdn.example.net/inter.woff2")).toBe("abort");
    expect(outcome("https://cdn.example.net/site.css")).toBe("continue");
  });

  it("a bot check is `blocked` and final: a challenge title, a 403, a 429", async () => {
    for (const site of [
      { title: "Just a moment...", html: PAGE },
      { title: "Vercel Security Checkpoint", html: PAGE },
      { status: 403, html: PAGE },
      { status: 429, html: PAGE },
    ]) {
      const log = newLog();
      const { kind } = await render({ hops: ["https://guarded.example.com/"], ...site }, { log });
      expect(kind).toBe("blocked");
      expect(log.launched).toBe(1);
      expect(log.closed).toBe(1);
    }
  });
});

describe("render: condition 1, logs", () => {
  it("never logs an error's message or a URL: the kind and an 8-character digest only", async () => {
    const secret = "https://secret-customer.example/private/path?token=abc123";
    const { kind } = await render({
      hops: ["https://spa.example.com/"],
      gotoError: new Error(`net::ERR_CONNECTION_RESET at ${secret}`),
    });
    expect(kind).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^\[rawuser\/render\] failed url_id=[0-9a-f]{8}$/);
    const all = [...errors, ...logs].join("\n");
    expect(all).not.toContain("secret-customer");
    expect(all).not.toContain("spa.example.com");
    expect(all).not.toContain("ERR_CONNECTION_RESET");
  });

  it("a refused redirect logs not_public with the digest, not the hop", async () => {
    await render(
      { hops: ["https://bounce.example.com/", "https://www.bounce.example.com/x"], html: PAGE },
      { private: ["www.bounce.example.com"] },
    );
    expect(errors.join("\n")).not.toContain("www.bounce");
    expect(errors[0]).toMatch(/^\[rawuser\/render\] not_public url_id=[0-9a-f]{8}$/);
  });
});

describe("render: the 25 s cap and browser.close()", () => {
  it("times out a page that never loads, and closes the browser", async () => {
    const { kind, log } = await render(
      { hops: ["https://slow.example.com/"], hang: true },
      { hardCapMs: 30 },
    );
    expect(kind).toBe("timeout");
    expect(log.closed).toBe(1);
  });

  it("closes a browser that arrives after the cap fired", async () => {
    const log = newLog();
    const { kind } = await render(
      { hops: ["https://slow.example.com/"], html: PAGE, launchDelayMs: 60 },
      { log, hardCapMs: 10 },
    );
    expect(kind).toBe("timeout");
    await new Promise((r) => setTimeout(r, 100));
    expect(log.closed).toBe(1);
  });

  it("maps a goto TimeoutError to timeout and any other throw to failed, closing each time", async () => {
    const timeout = new Error("Navigation timeout of 15000 ms exceeded");
    timeout.name = "TimeoutError";
    const a = await render({ hops: ["https://slow.example.com/"], gotoError: timeout });
    expect(a.kind).toBe("timeout");
    expect(a.log.closed).toBe(1);
    const b = await render({
      hops: ["https://x.example.com/"],
      launchError: new Error("429 limit"),
    });
    expect(b.kind).toBe("failed");
  });

  it("25 s by default", async () => {
    const { RENDER_HARD_CAP_MS, GOTO_TIMEOUT_MS, WAIT_FOR_TEXT_MS, SETTLE_MS } = await import(
      "../../src/lib/render-page.ts"
    );
    expect([RENDER_HARD_CAP_MS, GOTO_TIMEOUT_MS, WAIT_FOR_TEXT_MS, SETTLE_MS]).toEqual([
      25_000, 15_000, 8_000, 750,
    ]);
  });
});

describe("render: the daily ceiling", () => {
  it("counts each render per UTC day and refuses over 300, alerting once a day", async () => {
    const e = env();
    const day = new Date().toISOString().slice(0, 10);
    const ok = await render({ hops: ["https://spa.example.com/"], html: PAGE }, { env: e });
    expect(ok.kind).toBeNull();
    expect(e.VARIANTS.store.get(`render:day:${day}`)).toBe("1");

    e.VARIANTS.store.set(`render:day:${day}`, String(DAILY_RENDER_CEILING));
    const over = await render({ hops: ["https://spa.example.com/"], html: PAGE }, { env: e });
    expect(over.kind).toBe("failed");
    expect(over.log.launched).toBe(0);
    const again = await render({ hops: ["https://spa.example.com/"], html: PAGE }, { env: e });
    expect(again.kind).toBe("failed");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^render-cap: 300 page renders today/);
  });

  it("is off with BROWSER_RUN=off or without the binding: no launch", async () => {
    const off = await render(
      { hops: ["https://spa.example.com/"], html: PAGE },
      { env: env({ BROWSER_RUN: "off" }) },
    );
    expect(off.kind).toBe("failed");
    expect(off.log.launched).toBe(0);
    const none = await render(
      { hops: ["https://spa.example.com/"], html: PAGE },
      { env: env({ BROWSER: undefined }) },
    );
    expect(none.kind).toBe("failed");
    expect(none.log.launched).toBe(0);
  });
});

describe("looksLikeChallenge", () => {
  it("names bot checks and leaves ordinary pages alone", () => {
    expect(looksLikeChallenge({ status: 403 })).toBe(true);
    expect(looksLikeChallenge({ status: 429 })).toBe(true);
    expect(looksLikeChallenge({ html: "<title>Just a moment...</title>" })).toBe(true);
    expect(looksLikeChallenge({ headers: new Headers({ "cf-mitigated": "challenge" }) })).toBe(
      true,
    );
    expect(
      looksLikeChallenge({ headers: new Headers({ "x-vercel-mitigated": "challenge" }) }),
    ).toBe(true);
    // Cloudflare's JavaScript detections sit on ordinary pages: not a check on a 200.
    expect(
      looksLikeChallenge({
        status: 200,
        html: `${PAGE}<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`,
      }),
    ).toBe(false);
    expect(
      looksLikeChallenge({ status: 503, html: "<script>window._cf_chl_opt={}</script>" }),
    ).toBe(true);
    expect(looksLikeChallenge({ status: 200, html: PAGE })).toBe(false);
  });
});
