import { afterEach, describe, expect, it, vi } from "vitest";
import { readCarry, writeCarry } from "../src/carry.ts";

function fakeSession() {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  });
  return store;
}
afterEach(() => vi.unstubAllGlobals());

describe("carry", () => {
  it("round-trips two dimension names within thirty minutes, nothing else", () => {
    const store = fakeSession();
    writeCarry("evaluation", "social", 1000);
    expect(JSON.parse(store.get("__rw_carry") ?? "{}")).toEqual({
      i: "evaluation",
      s: "social",
      t: 1000,
    });
    expect(readCarry(1000 + 29 * 60 * 1000)).toEqual({
      intent_dim: "evaluation",
      source_dim: "social",
    });
    expect(readCarry(1000 + 31 * 60 * 1000)).toBeNull();
  });

  it("refuses junk and survives a blocked storage", () => {
    const store = fakeSession();
    writeCarry("<b>", "social");
    expect(store.size).toBe(0);
    store.set("__rw_carry", "not json");
    expect(readCarry()).toBeNull();
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readCarry()).toBeNull();
    expect(() => writeCarry("brand", "direct")).not.toThrow();
  });
});
