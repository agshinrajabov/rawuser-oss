import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tab handoff in lib/auth.ts: a new tab borrows the token from an open
// one over a BroadcastChannel, and a logout reaches every tab. "The other
// tab" here is a bare BroadcastChannel on the same name (Node has one).

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, String(v));
    },
  };
}

let other: BroadcastChannel;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", { sessionStorage: memoryStorage() });
  other = new BroadcastChannel("rawuser-auth");
});

afterEach(() => {
  other.close();
  vi.unstubAllGlobals();
});

describe("tab handoff", () => {
  it("a new tab borrows the token an open tab answers with, into its own sessionStorage", async () => {
    other.onmessage = (e) => {
      if (e.data?.type === "ask") other.postMessage({ type: "token", token: "tok-123" });
    };
    const auth = await import("../src/lib/auth");
    await expect(auth.borrowToken(300)).resolves.toBe("tok-123");
    expect(auth.getToken()).toBe("tok-123");
  });

  it("no open tab: null after the wait, so the guard goes to /login", async () => {
    const auth = await import("../src/lib/auth");
    await expect(auth.borrowToken(50)).resolves.toBeNull();
    expect(auth.getToken()).toBeNull();
  });

  it("a tab with a token answers an ask", async () => {
    const auth = await import("../src/lib/auth");
    auth.setToken("mine");
    await auth.borrowToken(10); // opens the channel
    const answer = new Promise((resolve) => {
      other.onmessage = (e) => {
        if (e.data?.type === "token") resolve(e.data.token);
      };
    });
    other.postMessage({ type: "ask" });
    await expect(answer).resolves.toBe("mine");
  });

  it("a logout elsewhere drops this tab's token and tells the guard", async () => {
    const auth = await import("../src/lib/auth");
    auth.setToken("mine");
    const gone = new Promise<void>((resolve) => auth.onLogoutElsewhere(resolve));
    other.postMessage({ type: "logout" });
    await gone;
    expect(auth.getToken()).toBeNull();
  });

  it("never writes the token anywhere but this tab's sessionStorage", async () => {
    const auth = await import("../src/lib/auth");
    expect(Object.keys(globalThis.window)).toEqual(["sessionStorage"]);
    auth.setToken("mine");
    expect((globalThis.window as { localStorage?: unknown }).localStorage).toBeUndefined();
  });
});
