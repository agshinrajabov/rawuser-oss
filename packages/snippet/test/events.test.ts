/**
 * Tests for snippet/src/events.ts — fire-and-forget event emission.
 *
 * Asserts the wire shape, transport selection (beacon vs. fetch), and
 * silent-failure invariant. Privacy invariants are tested at the
 * page_path computation level.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, pagePath } from "../src/events.ts";
import type { EventPayload } from "../src/types.ts";
import { at } from "./helpers.ts";

interface BeaconCall {
  url: string;
  blob: Blob;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

let beaconCalls: BeaconCall[];
let fetchCalls: FetchCall[];

beforeEach(() => {
  beaconCalls = [];
  fetchCalls = [];

  // Install mock navigator.sendBeacon — sync API per spec (returns boolean).
  vi.stubGlobal("navigator", {
    sendBeacon: (url: string, blob: Blob) => {
      beaconCalls.push({ url, blob });
      return true;
    },
  });

  // Install mock fetch
  vi.stubGlobal("fetch", (url: string | URL | Request, init: RequestInit = {}) => {
    fetchCalls.push({ url: String(url), init });
    return Promise.resolve(new Response(null, { status: 202 }));
  });

  // Install a minimal location stub for pagePath()
  vi.stubGlobal("location", { pathname: "/pricing" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pagePath", () => {
  it("returns location.pathname", () => {
    expect(pagePath()).toBe("/pricing");
  });

  it("returns / when pathname is empty", () => {
    vi.stubGlobal("location", { pathname: "" });
    expect(pagePath()).toBe("/");
  });
});

describe("fireEvent — fetch transport (variant_shown)", () => {
  it("POSTs to /event?cid=<customer_id> with the typed body", async () => {
    const payload: EventPayload = {
      event_type: "variant_shown",
      page_path: "/pricing",
      variant_key: "competitor:ai",
      intent_dim: "competitor",
      source_dim: "ai",
    };
    fireEvent("https://edge.rawuser.test", "acme", payload, false);

    expect(fetchCalls).toHaveLength(1);
    expect(at(fetchCalls, 0).url).toBe("https://edge.rawuser.test/event?cid=acme");
    expect(at(fetchCalls, 0).init.method).toBe("POST");
    expect(at(fetchCalls, 0).init.credentials).toBe("omit");
    expect(at(fetchCalls, 0).init.cache).toBe("no-store");
    expect((at(fetchCalls, 0).init as { keepalive?: boolean }).keepalive).toBe(true);
    expect(at(fetchCalls, 0).init.body).toBe(JSON.stringify(payload));
    expect(beaconCalls).toHaveLength(0);
  });

  it("variant_shown does NOT call sendBeacon (useBeacon=false default)", () => {
    fireEvent("https://edge.rawuser.test", "acme", {
      event_type: "variant_shown",
      page_path: "/",
    });
    expect(beaconCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
  });

  it("URL-encodes the customer_id query value", () => {
    fireEvent("https://edge.rawuser.test", "acme/with spaces", {
      event_type: "no_signal_passthrough",
      page_path: "/",
    });
    expect(at(fetchCalls, 0).url).toBe("https://edge.rawuser.test/event?cid=acme%2Fwith%20spaces");
  });
});

describe("fireEvent — leaving the page (conversion, pagehide flush)", () => {
  const conversion: EventPayload = {
    event_type: "conversion",
    page_path: "/pricing",
    conversion_label: "signup",
    variant_key: "pricing:organic",
    intent_dim: "pricing",
    source_dim: "organic",
  };

  // 2026-10-06 (the audit's host check): a beacon is a no-cors request,
  // whose Origin is "null" under a no-referrer or same-origin policy. A
  // keepalive fetch in CORS mode carries the real Origin, and text/plain
  // keeps it a simple request with no preflight.
  it("sends a keepalive text/plain fetch, CORS mode, no credentials, even when sendBeacon exists", () => {
    fireEvent("https://edge.rawuser.test", "acme", conversion, true);
    expect(beaconCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
    const { url, init } = at(fetchCalls, 0);
    expect(url).toBe("https://edge.rawuser.test/event?cid=acme");
    expect(init.method).toBe("POST");
    expect((init as { keepalive?: boolean }).keepalive).toBe(true);
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "text/plain;charset=UTF-8",
    );
    // 2026-10-04: a credentialed request fails CORS against the wildcard origin.
    expect(init.credentials).toBe("omit");
    // Default (cors) mode: never no-cors, which would hide the Origin.
    expect(init.mode).toBeUndefined();
    expect(init.body).toBe(JSON.stringify(conversion));
  });

  it("falls back to a text/plain sendBeacon where keepalive is missing", () => {
    vi.stubGlobal("Request", function OldRequest() {});
    fireEvent("https://edge.rawuser.test", "acme", conversion, true);
    expect(fetchCalls).toHaveLength(0);
    expect(beaconCalls).toHaveLength(1);
    expect(at(beaconCalls, 0).url).toBe("https://edge.rawuser.test/event?cid=acme");
    expect(at(beaconCalls, 0).blob.type).toMatch(/^text\/plain/);
  });

  it("without keepalive and without sendBeacon, still tries fetch", () => {
    vi.stubGlobal("Request", function OldRequest() {});
    vi.stubGlobal("navigator", {});
    fireEvent("https://edge.rawuser.test", "acme", conversion, true);
    expect(fetchCalls).toHaveLength(1);
  });

  it("a fetch that throws at once falls back to the beacon", () => {
    vi.stubGlobal("fetch", () => {
      throw new TypeError("old engine");
    });
    fireEvent("https://edge.rawuser.test", "acme", conversion, true);
    expect(beaconCalls).toHaveLength(1);
  });

  it("an event sent while the page stays is JSON, as before", () => {
    fireEvent("https://edge.rawuser.test", "acme", { event_type: "variant_shown", page_path: "/" });
    expect((at(fetchCalls, 0).init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });
});

describe("fireEvent — silent failure invariant", () => {
  it("does not throw when fetch itself throws", () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network died");
    });
    expect(() =>
      fireEvent("https://edge.rawuser.test", "acme", {
        event_type: "variant_shown",
        page_path: "/",
      }),
    ).not.toThrow();
  });

  it("does not throw when fetch returns a rejected promise", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("net err")));
    expect(() =>
      fireEvent("https://edge.rawuser.test", "acme", {
        event_type: "variant_shown",
        page_path: "/",
      }),
    ).not.toThrow();
    // Let the rejected promise settle without surfacing.
    await Promise.resolve();
  });

  it("returns synchronously (does not block on the network)", () => {
    let resolveFetch: ((value: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    const before = Date.now();
    fireEvent("https://edge.rawuser.test", "acme", {
      event_type: "variant_shown",
      page_path: "/",
    });
    const after = Date.now();
    expect(after - before).toBeLessThan(20); // ~ms, not the fetch latency
    // TS narrows resolveFetch to its initializer (null) because the
    // assignment happens inside the fetch-stub callback; re-widen for the call.
    const settle = resolveFetch as ((value: Response) => void) | null;
    settle?.(new Response(null, { status: 202 }));
  });
});
