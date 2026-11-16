import { describe, expect, it } from "vitest";
import {
  TOTAL_TUPLES,
  firstRunStep,
  missingTuples,
  seeItLink,
} from "../../src/components/start/steps";
import type { CustomerListItem, VariantListItem } from "../../src/types/api";

function base(over: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: "lumera",
    slug: "lumera",
    domain: "lumera.test",
    plan: "pilot",
    status: "active",
    created_at: 0,
    onboarding_stage: "new",
    last_activity_at: null,
    contact_email: null,
    contact_name: null,
    has_dna: false,
    has_confirmed_manifest: false,
    variants_ready_count: 0,
    variants_last_generated_at: null,
    events_24h: 0,
    events_7d: 0,
    last_event_at: null,
    ...over,
  };
}

describe("firstRunStep", () => {
  it("connect until a preview exists, look until go-live, live after", () => {
    expect(firstRunStep(base())).toBe("connect");
    expect(firstRunStep(base({ preview_seen_at: 1 }))).toBe("look");
    expect(
      firstRunStep(base({ preview_seen_at: 1, has_confirmed_manifest: true, live_at: 2 })),
    ).toBe("live");
  });
});

describe("missingTuples", () => {
  const row = (intent_dim: string, source_dim: string, status = "ready"): VariantListItem =>
    ({
      intent_dim,
      source_dim,
      page_path: "/",
      status,
      model: "m",
      generated_at: 0,
      cost_usd: 0,
      kv_key: "",
    }) as VariantListItem;

  it("skips ready tuples for the path and keeps defaults first", () => {
    const missing = missingTuples(
      [row("brand", "default"), row("pricing", "ai"), row("brand", "social", "stale")],
      "/",
    );
    expect(missing.length).toBe(TOTAL_TUPLES - 2);
    expect(missing[0]).toEqual({ intent_dim: "competitor", source_dim: "default" });
    expect(missing.some((t) => t.intent_dim === "brand" && t.source_dim === "default")).toBe(false);
    expect(missing.some((t) => t.intent_dim === "brand" && t.source_dim === "social")).toBe(true);
  });

  it("ignores other paths", () => {
    const missing = missingTuples([{ ...row("brand", "default"), page_path: "/az" }], "/");
    expect(missing.length).toBe(TOTAL_TUPLES);
  });
});

describe("seeItLink", () => {
  it("builds a social-tagged link on the bare host", () => {
    expect(seeItLink("https://lumera.test/")).toBe(
      "https://lumera.test/?utm_source=linkedin&utm_medium=social",
    );
  });
});
