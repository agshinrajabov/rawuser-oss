/**
 * A fake Browser Run browser for the render tests. It plays a page load the
 * way @cloudflare/puppeteer does with request interception on (checked live
 * 2026-10-04): one `request` per main-frame redirect hop, each a navigation
 * request, then the page's subresources and frames. Every request waits for
 * the handler's continue() or abort(); an aborted document hop makes goto
 * throw a net::ERR_BLOCKED_BY_CLIENT error that carries the URL, as the real
 * one does.
 */

import type {
  Launcher,
  RenderBrowser,
  RenderPage,
  RenderRequest,
} from "../../src/lib/render-page.ts";

export interface FakeSub {
  url: string;
  type: string;
  /** A subframe navigation (an iframe's document). */
  subframe?: boolean;
}

export interface FakeSite {
  /** The document's hops, first the URL asked for, then each redirect target. */
  hops: string[];
  subresources?: FakeSub[];
  status?: number;
  title?: string;
  html?: string;
  /** goto throws this instead of loading. */
  gotoError?: Error;
  /** goto never settles (the 25 s cap test). */
  hang?: boolean;
  /** launch throws this. */
  launchError?: Error;
  /** launch resolves only after this many ms. */
  launchDelayMs?: number;
}

export interface FakeLog {
  launched: number;
  closed: number;
  decisions: Array<{ url: string; type: string; nav: boolean; outcome: "continue" | "abort" }>;
  bypassServiceWorker: boolean | null;
  interception: boolean | null;
  initScripts: Array<() => void>;
  /** Calls the privacy review forbids (condition 2): none may ever appear. */
  forbidden: string[];
  listeners: string[];
}

export function newLog(): FakeLog {
  return {
    launched: 0,
    closed: 0,
    decisions: [],
    bypassServiceWorker: null,
    interception: null,
    initScripts: [],
    forbidden: [],
    listeners: [],
  };
}

class FakeRequest implements RenderRequest {
  outcome: "continue" | "abort" | null = null;
  private settle!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.settle = resolve;
  });
  constructor(
    private readonly u: string,
    private readonly type: string,
    private readonly nav: boolean,
    private readonly frameRef: unknown,
    private readonly log: FakeLog,
  ) {}
  url() {
    return this.u;
  }
  isNavigationRequest() {
    return this.nav;
  }
  frame() {
    return this.frameRef;
  }
  resourceType() {
    return this.type;
  }
  async abort() {
    this.decide("abort");
  }
  async continue() {
    this.decide("continue");
  }
  private decide(outcome: "continue" | "abort") {
    if (this.outcome) throw new Error("Request is already handled!");
    this.outcome = outcome;
    this.log.decisions.push({ url: this.u, type: this.type, nav: this.nav, outcome });
    this.settle();
  }
}

export function fakeLauncher(site: FakeSite, log: FakeLog): Launcher {
  return async () => {
    log.launched++;
    if (site.launchDelayMs) await new Promise((r) => setTimeout(r, site.launchDelayMs));
    if (site.launchError) throw site.launchError;
    const mainFrame = { name: "main" };
    const subFrame = { name: "sub" };
    let handler: ((r: RenderRequest) => void) | null = null;
    const emit = async (req: FakeRequest) => {
      if (!handler) throw new Error("no request handler with interception on");
      handler(req);
      await req.done;
      return req.outcome;
    };
    const page: RenderPage & Record<string, unknown> = {
      async setBypassServiceWorker(b: boolean) {
        log.bypassServiceWorker = b;
      },
      async setRequestInterception(on: boolean) {
        log.interception = on;
      },
      async evaluateOnNewDocument(fn: () => void) {
        log.initScripts.push(fn);
      },
      on(event: string, h: (r: RenderRequest) => void) {
        log.listeners.push(event);
        if (event === "request") handler = h;
        return page;
      },
      mainFrame: () => mainFrame,
      async goto() {
        if (site.hang) return new Promise(() => {});
        if (site.gotoError) throw site.gotoError;
        for (const hop of site.hops) {
          const outcome = await emit(new FakeRequest(hop, "document", true, mainFrame, log));
          if (outcome === "abort") throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${hop}`);
        }
        for (const sub of site.subresources ?? []) {
          await emit(
            new FakeRequest(
              sub.url,
              sub.type,
              sub.subframe === true,
              sub.subframe ? subFrame : mainFrame,
              log,
            ),
          );
        }
        return { status: () => site.status ?? 200 };
      },
      async waitForFunction() {
        return true;
      },
      async title() {
        return site.title ?? "";
      },
      async content() {
        return site.html ?? "";
      },
      // Forbidden by condition 2: recorded if ever called.
      setUserAgent: async () => {
        log.forbidden.push("setUserAgent");
      },
      setExtraHTTPHeaders: async () => {
        log.forbidden.push("setExtraHTTPHeaders");
      },
    };
    const browser: RenderBrowser = {
      newPage: async () => page,
      close: async () => {
        log.closed++;
      },
    };
    return browser;
  };
}

/** A KV namespace in memory, with the methods the render touches. */
export function memoryKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}
