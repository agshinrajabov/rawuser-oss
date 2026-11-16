/**
 * The visitor memory (docs/specs/direct-visitors.md §2, "A visitor who comes
 * back"; ADR 0039 as amended 2026-11-05): the statement the edge puts in the
 * customer's script draws the visitor's own code on its first page, tells
 * our database once per visit whether the code is new or came back, and
 * starts a new tab with the last reason the visitor gave (a tapped answer or
 * the source of a visit that came with one). Never over a carry or a
 * question the tab already has, never after 13 months from the first page,
 * never in a preview or pick tab.
 */
import { REMEMBER_MS, choiceSlotOf, rememberJs } from "@rawuser/shared";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const NOW = Date.parse("2026-11-05T12:00:00Z");

const PID = "0123456789abcdef0123456789abcdef";

type Tab = Window &
  typeof globalThis & { __sent: Array<{ u: string; body: Record<string, unknown> }> };

function tab(pick: unknown, session: Record<string, string> = {}, url = "https://site.test/"): Tab {
  const w = new JSDOM("<!doctype html><p>x</p>", {
    url,
    runScripts: "outside-only",
  }).window as unknown as Tab;
  w.__sent = [];
  w.eval(`window.__rw = { c: "acme", e: "https://edge.test" };
    window.fetch = (u, o) => { window.__sent.push({ u, body: JSON.parse(o.body) }); return Promise.resolve(); };
    window.crypto = window.crypto || { getRandomValues: (a) => a.fill(7) };`);
  if (pick !== undefined) w.localStorage.setItem("__rw_pick", JSON.stringify(pick));
  for (const [k, v] of Object.entries(session)) w.sessionStorage.setItem(k, v);
  w.eval(`Date.now = () => ${NOW};`);
  w.eval(rememberJs());
  return w;
}

const pick = (w: Tab) => JSON.parse(w.localStorage.getItem("__rw_pick") ?? "null");
const carry = (w: Tab) => JSON.parse(w.sessionStorage.getItem("__rw_carry") ?? "null");
const visit = (w: Tab) => JSON.parse(w.sessionStorage.getItem("__rw_visit") ?? "{}").v;

describe("the visitor memory in the customer's script", () => {
  it("a first visit draws a code, starts the visit and says `first`; no carry", () => {
    const w = tab(undefined);
    const m = pick(w);
    expect(m.p).toMatch(/^[0-9a-f]{32}$/);
    expect(m.f).toBe(NOW);
    expect(carry(w)).toBeNull();
    expect(w.__sent).toEqual([
      {
        u: "https://edge.test/event?cid=acme",
        body: { event_type: "choice", page_path: "/", ch: "first", pid: m.p, visit: visit(w) },
      },
    ]);
  });

  it("a remembered answer starts the new tab as its carry, counts as asked, and says `returned` with the slot", () => {
    const w = tab({ p: PID, f: NOW - 9 * 86_400_000, k: "rb:direct" });
    expect(carry(w)).toEqual({ i: "rb", s: "direct", t: NOW });
    expect(choiceSlotOf(`${carry(w).i}:${carry(w).s}`)).toBe("b");
    expect(w.sessionStorage.getItem("__rw_q")).toBe("b");
    expect(w.__sent.map((x) => x.body)).toEqual([
      { event_type: "choice", page_path: "/", ch: "returned", pid: PID, visit: visit(w), qa: "b" },
    ]);
  });

  it("an answer kept by the older shape (`s`, `t`) is read as the reason", () => {
    const w = tab({ s: "a", t: NOW - 3 * 86_400_000, p: PID });
    expect(carry(w)).toEqual({ i: "ra", s: "direct", t: NOW });
    expect(pick(w)).toMatchObject({ p: PID, f: NOW - 3 * 86_400_000, k: "ra:direct" });
  });

  it("a remembered source comes back as the carry: a ChatGPT visitor typing the address sees the ChatGPT version", () => {
    const w = tab({ p: PID, f: NOW - 86_400_000, k: "problem:ai" });
    expect(carry(w)).toEqual({ i: "problem", s: "ai", t: NOW });
    expect(w.sessionStorage.getItem("__rw_q")).toBeNull();
    expect(w.__sent[0]?.body).toMatchObject({ ch: "returned", pid: PID, rc: "problem:ai" });
    expect(w.__sent[0]?.body.qa).toBeUndefined();
  });

  it("a code with no reason still says `returned`, with nothing given back", () => {
    const w = tab({ p: PID, f: NOW - 86_400_000 });
    expect(carry(w)).toBeNull();
    expect(w.__sent.map((x) => x.body)).toEqual([
      { event_type: "choice", page_path: "/", ch: "returned", pid: PID, visit: visit(w) },
    ]);
  });

  it("leaving the page keeps the tab's own reason; never `direct`, never a held original", () => {
    const w = tab({ p: PID, f: NOW });
    w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "pricing", s: "social", t: NOW }));
    w.dispatchEvent(new w.Event("pagehide"));
    expect(pick(w).k).toBe("pricing:social");
    w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "pricing", s: "direct", t: NOW }));
    w.dispatchEvent(new w.Event("pagehide"));
    expect(pick(w).k).toBe("pricing:social");
    w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "none", s: "ai", t: NOW }));
    w.document.dispatchEvent(new w.Event("visibilitychange"));
    expect(pick(w).k).toBe("pricing:social");
  });

  it("one row per visit: a page of the same visit sends nothing and keeps its marker", () => {
    const v = "fedcba9876543210fedcba9876543210";
    const w = tab(
      { p: PID, f: NOW, k: "ra:direct" },
      { __rw_visit: JSON.stringify({ v, t: NOW - 60_000 }) },
    );
    expect(visit(w)).toBe(v);
    expect(w.__sent).toEqual([]);
  });

  it("13 months after the first page the browser forgets it all and draws a new code", () => {
    const w = tab({ p: PID, f: NOW - REMEMBER_MS - 1, k: "problem:ai" });
    expect(pick(w).p).not.toBe(PID);
    expect(pick(w).k).toBeUndefined();
    expect(carry(w)).toBeNull();
    expect(w.__sent[0]?.body.ch).toBe("first");
  });

  it("a malformed reason is never given back", () => {
    for (const k of ["rz:direct", "pricing:direct", "hack:ai", "problem:mk-az"]) {
      const w = tab({ p: PID, f: NOW, k });
      expect(carry(w)).toBeNull();
    }
  });

  it("never over a carry or a question this tab already has", () => {
    const own = '{"i":"pricing","s":"ai","t":1}';
    const w = tab({ p: PID, f: NOW, k: "ra:direct" }, { __rw_carry: own });
    expect(w.sessionStorage.getItem("__rw_carry")).toBe(own);
    expect(
      tab({ p: PID, f: NOW, k: "ra:direct" }, { __rw_q: "1" }).sessionStorage.getItem("__rw_carry"),
    ).toBeNull();
  });

  it("a preview or pick tab keeps and sends nothing", () => {
    const w = tab(undefined, {}, "https://site.test/#rawuser_pick=abc");
    expect(w.localStorage.length).toBe(0);
    expect(w.__sent).toEqual([]);
  });
});
