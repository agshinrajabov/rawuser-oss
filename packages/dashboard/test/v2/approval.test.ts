/**
 * New versions wait for the customer's OK (docs/specs/versions-approval.md):
 * the list's fields, the pending read, approve, approve all, discard, the
 * auto_approve switch, the Overview count, and the Versions screen's
 * waiting state (live words beside the new, Approve, Discard, Approve all).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/versions",
}));

import { missingTuples } from "../../src/components/start/steps";
import { PageWaiting, VersionDetail } from "../../src/components/v2/Versions";
import { ApiError } from "../../src/lib/api";
import {
  APPROVAL_LINES,
  APPROVE_ALL_PATH,
  APPROVE_PATH,
  AUTO_APPROVE_PATH,
  DISCARD_PATH,
  approve,
  approveAll,
  discard,
  getAutoApprove,
  isWaiting,
  pendingCount,
  pendingPath,
  readPending,
  setAutoApprove,
  waitingSince,
} from "../../src/lib/approval";
import { KINDS } from "../../src/lib/kinds";
import { attentionRows } from "../../src/lib/overview";
import { kindState, versionState, waitingParts } from "../../src/lib/versions-screen";
import type { ManifestResponse, VariantListItem } from "../../src/types/api";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function item(over: Partial<VariantListItem> = {}): VariantListItem {
  return {
    intent_dim: "problem",
    source_dim: "social",
    page_path: "/",
    model: "m",
    generated_at: 1,
    cost_usd: 0,
    status: "ready",
    kv_key: "k",
    ...over,
  };
}

/** The contract's example answer of GET /admin/variants/pending. */
const PENDING = {
  customer_id: "acme",
  page_path: null,
  count: 2,
  items: [
    {
      page_path: "/",
      intent_dim: "problem",
      source_dim: "social",
      kv_key: "v1:variant:acme:problem:social",
      pending_since: 1_762_074_000_000,
      has_live: true,
      live: { sections: {} },
      new: { sections: {} },
      parts: [
        { path: "hero.headline", live: "Old words", new: "New words" },
        { path: "hero.cta.label", live: "Book a call", new: "Talk to us" },
        { path: "pricing.table.row_3", live: "x", new: "y" },
      ],
    },
    {
      page_path: "/fees",
      intent_dim: "pricing",
      source_dim: "ai",
      pending_since: null,
      has_live: false,
      live: null,
      parts: [{ path: "hero.headline", live: null, new: "Clear fees" }],
    },
    { junk: true },
  ],
};

describe("the list's fields (contract §4)", () => {
  it("pending and pending_since are read; status pending is a waiting cell", () => {
    const w = item({ pending: true, pending_since: 5 });
    expect(isWaiting(w)).toBe(true);
    expect(waitingSince(w)).toBe(5);
    expect(isWaiting(item({ pending: false }))).toBe(false);
    const items = [
      w,
      item({ source_dim: "ai", status: "pending", pending: true }),
      item({ source_dim: "paid", status: "discarded" }),
    ];
    expect(versionState(items, "/", "ai", "problem")).toBe("waiting");
    expect(kindState(items, "/", "social", ["problem"])).toBe("waiting");
    expect(versionState(items, "/", "paid", "problem")).toBe("none");
  });

  it("the first run's loop leaves waiting and discarded cells alone", () => {
    const items = [
      item({ intent_dim: "problem", source_dim: "ai", status: "pending" }),
      item({ intent_dim: "feature", source_dim: "ai", status: "discarded" }),
    ];
    const todo = missingTuples(items, "/", ["problem", "feature"]).map(
      (t) => `${t.intent_dim}:${t.source_dim}`,
    );
    expect(todo).not.toContain("problem:ai");
    expect(todo).not.toContain("feature:ai");
  });

  it("the Overview counts pending_versions, else the list", () => {
    expect(pendingCount({ pending_versions: 4 }, [])).toBe(4);
    expect(pendingCount(null, [item({ pending: true })])).toBe(1);
    const one = attentionRows({
      items: [item({ pending: true })],
      pending: 1,
      noSignalVisits: 0,
      readiness: null,
    });
    expect(one[0]?.title).toBe("A new version for Social visitors is waiting for your OK.");
    expect(one[0]?.line).toBe("Home page. Visitors see the old one until you approve.");
    const many = attentionRows({ items: [], pending: 3, noSignalVisits: 0, readiness: null });
    expect(many[0]?.title).toBe("3 new versions are waiting for your OK.");
    expect(many[0]?.action.href).toBe("/versions");
    expect(attentionRows({ items: [], pending: 0, noSignalVisits: 0, readiness: null })).toEqual(
      [],
    );
  });
});

describe("GET /admin/variants/pending", () => {
  it("reads the items, drops what is not one, keeps the parts' order", () => {
    const got = readPending(PENDING);
    expect(got).toHaveLength(2);
    expect(got[0]?.parts.map((p) => [p.path, p.live, p.next])).toEqual([
      ["hero.headline", "Old words", "New words"],
      ["hero.cta.label", "Book a call", "Talk to us"],
      ["pricing.table.row_3", "x", "y"],
    ]);
    expect(got[1]?.has_live).toBe(false);
    expect(readPending({ error: "x" })).toEqual([]);
    expect(pendingPath("acme")).toBe("/admin/variants/pending?customer_id=acme");
    expect(pendingPath("acme", "/fees")).toBe(
      "/admin/variants/pending?customer_id=acme&page_path=%2Ffees",
    );
  });

  it("the compare: live beside new; with no live body, the page's own words", () => {
    const [withLive, noLive] = readPending(PENDING);
    if (!withLive || !noLive) throw new Error("fixture");
    expect(waitingParts(withLive, undefined)).toEqual([
      { path: "hero.headline", name: "Headline", original: "Old words", version: "New words" },
      {
        path: "hero.cta.label",
        name: "Main button",
        original: "Book a call",
        version: "Talk to us",
      },
    ]);
    const m = {
      manifest: { "hero.headline": { css: ["h1"], text: ["Fees, plainly"], structural: "h1" } },
    } as unknown as ManifestResponse;
    expect(waitingParts(noLive, m)[0]).toEqual({
      path: "hero.headline",
      name: "Headline",
      original: "Fees, plainly",
      version: "Clear fees",
    });
  });
});

describe("approve, approve all, discard, the switch", () => {
  const record = (answer: unknown) => {
    const calls: [string, unknown][] = [];
    const api = (async (path: string, init?: RequestInit) => {
      calls.push([path, init?.body ? JSON.parse(String(init.body)) : null]);
      return answer;
    }) as never;
    return { calls, api };
  };
  const cell = { page_path: "/", intent_dim: "problem", source_dim: "social" };

  it("posts the cell and reads what is left", async () => {
    const a = record({ ok: true, pending_left: 2 });
    expect(await approve("acme", cell, a.api)).toEqual({ kind: "ok", pendingLeft: 2 });
    expect(a.calls).toEqual([[APPROVE_PATH, { customer_id: "acme", ...cell }]]);
    const d = record({ ok: true, pending_left: 1 });
    await discard("acme", cell, d.api);
    expect(d.calls[0]?.[0]).toBe(DISCARD_PATH);
    const all = record({ ok: true, page_path: "/", approved: 3, failed: 0, pending_left: 0 });
    expect(await approveAll("acme", "/", all.api)).toEqual({
      kind: "ok",
      pendingLeft: 0,
      approved: 3,
      failed: 0,
    });
    expect(all.calls).toEqual([[APPROVE_ALL_PATH, { customer_id: "acme", page_path: "/" }]]);
  });

  it("404 nothing_waiting reads as gone; a 409 says the API's own sentence", async () => {
    const gone = (async () => {
      throw new ApiError(404, 'API error 404: {"ok":false,"error":"nothing_waiting"}');
    }) as never;
    expect(await approve("acme", cell, gone)).toEqual({ kind: "gone" });
    const ended = (async () => {
      throw new ApiError(409, 'API error 409: {"error":"The audit has ended."}');
    }) as never;
    expect(await approve("acme", cell, ended)).toEqual({
      kind: "failed",
      message: "The audit has ended.",
    });
    const down = (async () => {
      throw new Error("network");
    }) as never;
    expect(await discard("acme", cell, down)).toEqual({
      kind: "failed",
      message: APPROVAL_LINES.failed,
    });
  });

  it("the switch: off by default, on and off; a worker without it hides the row", async () => {
    const r = record({ customer_id: "acme", auto_approve: false, pending: 2 });
    expect(await getAutoApprove("acme", r.api)).toEqual({ on: false, pending: 2 });
    expect(r.calls[0]?.[0]).toBe(`${AUTO_APPROVE_PATH}?customer_id=acme`);
    const s = record({ customer_id: "acme", auto_approve: true, pending: 2 });
    expect(await setAutoApprove("acme", true, s.api)).toEqual({
      kind: "ok",
      state: { on: true, pending: 2 },
    });
    expect(s.calls[0]).toEqual([AUTO_APPROVE_PATH, { customer_id: "acme", on: true }]);
    const missing = (async () => {
      throw new ApiError(404, "API error 404");
    }) as never;
    expect(await getAutoApprove("acme", missing)).toBeNull();
  });
});

describe("the Versions screen's waiting state", () => {
  const [withLive] = readPending(PENDING);
  if (!withLive) throw new Error("fixture");
  const render = (busy: "approve" | null = null) =>
    renderToStaticMarkup(
      h(VersionDetail, {
        kind: KINDS[1] as (typeof KINDS)[number],
        reasons: [{ intent: "problem", visits: 10 }],
        reason: "problem",
        onReason: () => undefined,
        state: "waiting",
        waitingLine: "Rewritten 2 hours ago.",
        parts: [],
        waiting: { parts: waitingParts(withLive, undefined), hasLive: true },
        counts: { visits: 10, conversions: 1 },
        visitorsHref: "/visitors",
        onRewrite: () => undefined,
        onApprove: () => undefined,
        onDiscard: () => undefined,
        busy,
        said: null,
        canRewrite: true,
      }),
    );

  it("the new words beside the live ones, Approve, Discard, Rewrite again", () => {
    const t = text(render());
    expect(t).toContain("Rewritten 2 hours ago. Visitors see the old one until you approve.");
    expect(t).toContain("Live now");
    expect(t).toContain("New, waiting");
    expect(t).toContain("Old words");
    expect(t).toContain("New words");
    expect(t).toContain("Approve");
    expect(t).toContain("Discard");
    expect(t).toContain("Rewrite again");
    expect(t).not.toMatch(/[–—]/);
  });

  it("Approve all shows from two waiting on the page", () => {
    const t = text(
      renderToStaticMarkup(
        h(PageWaiting, {
          count: 3,
          busy: false,
          disabled: false,
          said: null,
          onApproveAll: () => undefined,
        }),
      ),
    );
    expect(t).toBe("3 new versions on this page wait for your OK. Approve all 3");
  });
});
