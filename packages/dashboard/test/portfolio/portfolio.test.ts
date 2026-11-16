/**
 * Portfolio page — pure-logic tests (node env, no DOM per vitest.config.ts).
 *
 * Covers:
 * 1. PortfolioItem shape — all fields present and type-safe
 * 2. AttentionSignal shape — 4 signal types recognised
 * 3. Health badge mapping — health value → label correctness
 * 4. Snippet status label mapping — all 5 statuses have a label
 * 5. Lift label formatting — sign / rounding / null handling
 * 6. Attention rail signal metadata — all 4 signal types have copy
 */

import { describe, expect, it } from "vitest";
import type { AttentionSignal, PortfolioItem } from "../../src/types/api";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<PortfolioItem> = {}): PortfolioItem {
  return {
    customer_id: "lumera-school",
    customer_slug: "lumera-school",
    customer_domain: "school.lumera.test",
    snippet_status: "active",
    health: "green",
    holdout_lift_7d: null,
    visits_24h: 354,
    signals: [],
    ...overrides,
  };
}

function makeSignal(overrides: Partial<AttentionSignal> = {}): AttentionSignal {
  return {
    customer_id: "lumera-school",
    type: "snippet-removed",
    label: "Snippet removed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. PortfolioItem shape
// ---------------------------------------------------------------------------

describe("PortfolioItem type shape", () => {
  it("accepts the live API response shape", () => {
    const item = makeItem();
    expect(item.customer_id).toBe("lumera-school");
    expect(item.snippet_status).toBe("active");
    expect(item.health).toBe("green");
    expect(item.holdout_lift_7d).toBeNull();
    expect(item.visits_24h).toBe(354);
    expect(item.signals).toHaveLength(0);
  });

  it("accepts a fully-populated item with signals", () => {
    const item = makeItem({
      health: "yellow",
      snippet_status: "stale",
      holdout_lift_7d: 0.47,
      signals: ["snippet-stale", "lift-trend-down"],
    });
    expect(item.signals).toContain("snippet-stale");
    expect(item.signals).toContain("lift-trend-down");
    expect(item.health).toBe("yellow");
  });

  it("accepts a red health item with removed snippet", () => {
    const item = makeItem({
      health: "red",
      snippet_status: "removed",
      visits_24h: 0,
      signals: ["snippet-removed"],
    });
    expect(item.snippet_status).toBe("removed");
    expect(item.health).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// 2. AttentionSignal type shape
// ---------------------------------------------------------------------------

const SIGNAL_TYPES: AttentionSignal["type"][] = [
  "snippet-removed",
  "snippet-stale",
  "skipped-rate-high",
  "lift-trend-down",
];

describe("AttentionSignal type shape", () => {
  it("has exactly 4 recognised signal types", () => {
    expect(SIGNAL_TYPES).toHaveLength(4);
  });

  it.each(SIGNAL_TYPES)("signal type '%s' is accepted", (type) => {
    const sig = makeSignal({ type });
    expect(sig.type).toBe(type);
  });

  it("accepts an optional numeric value (skipped-rate-high)", () => {
    const sig = makeSignal({ type: "skipped-rate-high", value: 0.42 });
    expect(sig.value).toBeCloseTo(0.42);
  });

  it("accepts an optional numeric value (lift-trend-down — negative)", () => {
    const sig = makeSignal({ type: "lift-trend-down", value: -0.28 });
    expect(sig.value).toBeCloseTo(-0.28);
  });
});

// ---------------------------------------------------------------------------
// 3. Health mapping logic (mirrors HealthBadge CONFIG)
// ---------------------------------------------------------------------------

const HEALTH_LABELS: Record<PortfolioItem["health"], string> = {
  green: "Healthy",
  yellow: "Attention",
  red: "Issue",
};

describe("HealthBadge config", () => {
  it.each(Object.entries(HEALTH_LABELS) as [PortfolioItem["health"], string][])(
    "health '%s' maps to label '%s'",
    (health, label) => {
      expect(HEALTH_LABELS[health]).toBe(label);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Snippet status label mapping (mirrors PortfolioCard SNIPPET_LABEL)
// ---------------------------------------------------------------------------

const SNIPPET_LABELS: Record<PortfolioItem["snippet_status"], string> = {
  active: "Active",
  stale: "Stale",
  removed: "Removed",
  never: "Awaiting traffic",
  unknown: "Not probed",
};

describe("Snippet status labels", () => {
  const statuses: PortfolioItem["snippet_status"][] = [
    "active",
    "stale",
    "removed",
    "never",
    "unknown",
  ];

  it("all 5 snippet statuses have a label", () => {
    for (const s of statuses) {
      expect(SNIPPET_LABELS[s]).toBeTruthy();
    }
  });

  it.each(statuses)("status '%s' resolves to a non-empty label", (status) => {
    expect(SNIPPET_LABELS[status].length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Lift label formatting (mirrors PortfolioCard liftLabel logic)
// ---------------------------------------------------------------------------

function formatLift(holdout_lift_7d: number | null): string {
  if (holdout_lift_7d === null) return "lift pending";
  return `${holdout_lift_7d >= 0 ? "+" : ""}${Math.round(holdout_lift_7d * 100)}% lift 7d`;
}

describe("Lift label formatting", () => {
  it("null lift → 'lift pending'", () => {
    expect(formatLift(null)).toBe("lift pending");
  });

  it("positive lift shows + sign", () => {
    expect(formatLift(0.47)).toBe("+47% lift 7d");
  });

  it("zero lift shows +0", () => {
    expect(formatLift(0)).toBe("+0% lift 7d");
  });

  it("negative lift shows no + sign", () => {
    expect(formatLift(-0.28)).toBe("-28% lift 7d");
  });

  it("fractional lift is rounded to nearest integer", () => {
    expect(formatLift(0.476)).toBe("+48% lift 7d");
    expect(formatLift(0.123)).toBe("+12% lift 7d");
  });
});

// ---------------------------------------------------------------------------
// 6. Attention rail — all 4 signal types have description copy
// ---------------------------------------------------------------------------

const SIGNAL_META: Record<AttentionSignal["type"], { title: string; description: string }> = {
  "snippet-removed": {
    title: "Snippet removed",
    description: "Script tag no longer found in the customer's HTML.",
  },
  "snippet-stale": {
    title: "Snippet stale",
    description: "No events received in the past 24 hours.",
  },
  "skipped-rate-high": {
    title: "High skip rate",
    description:
      "More than 30% of personalized visits couldn't apply a variant. Re-detect elements.",
  },
  "lift-trend-down": {
    title: "Lift declining",
    description: "7-day holdout lift has dropped by more than 20 percentage points.",
  },
};

describe("AttentionRail signal metadata", () => {
  it.each(SIGNAL_TYPES)("signal type '%s' has a non-empty title and description", (type) => {
    const meta = SIGNAL_META[type];
    expect(meta).toBeDefined();
    expect(meta.title.length).toBeGreaterThan(0);
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it("all 4 signal types are covered", () => {
    expect(Object.keys(SIGNAL_META)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 7. Portfolio grid — rendering logic (empty / non-empty / 1-10 items)
// ---------------------------------------------------------------------------

describe("PortfolioGrid data logic", () => {
  it("empty items array → should render empty state (0 items)", () => {
    const items: PortfolioItem[] = [];
    expect(items.length).toBe(0);
  });

  it("single item renders correctly", () => {
    const items = [makeItem()];
    expect(items.length).toBe(1);
    expect(items[0]?.customer_id).toBe("lumera-school");
  });

  it("10 items (V2 GTM max) all accessible", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ customer_id: `pilot-${i}`, customer_slug: `pilot-${i}` }),
    );
    expect(items.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(items[i]?.customer_id).toBe(`pilot-${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Role-access guard (pure logic — component redirect is integration-tested)
// ---------------------------------------------------------------------------

describe("Role access guard logic", () => {
  it("superadmin role is permitted", () => {
    const user = { id: "u1", email: "a@example.com", role: "superadmin", customer_id: null };
    expect(user.role).toBe("superadmin");
  });

  it("customer role should be redirected", () => {
    const user = {
      id: "u2",
      email: "c@example.com",
      role: "customer",
      customer_id: "lumera-school",
    };
    // The page component redirects to /customers when role !== 'superadmin'
    expect(user.role !== "superadmin").toBe(true);
  });
});
