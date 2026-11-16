import { describe, expect, it } from "vitest";
import { nextAction, pipelineState } from "../../src/components/home/pipeline";
import type { CustomerListItem } from "../../src/types/api";

function base(overrides: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: "test-co",
    slug: "test-co",
    domain: "test.co",
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
    ...overrides,
  };
}

describe("pipelineState", () => {
  it("has five steps in canonical order", () => {
    const { steps } = pipelineState(base());
    expect(steps.map((s) => s.key)).toEqual(["brief", "connect", "versions", "install", "measure"]);
  });

  it("brand-new customer: current step is brief, not live", () => {
    const { currentIndex, live, steps } = pipelineState(base());
    expect(live).toBe(false);
    expect(currentIndex).toBe(0);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it("current step is the first not-done, earlier steps marked done", () => {
    // brief + connect done, versions not → current index 2
    const { currentIndex, steps } = pipelineState(
      base({ has_dna: true, has_confirmed_manifest: true }),
    );
    expect(currentIndex).toBe(2);
    expect(steps[0]?.done).toBe(true);
    expect(steps[1]?.done).toBe(true);
    expect(steps[2]?.done).toBe(false);
  });

  it("fully set up + 24h traffic → live", () => {
    const { live, currentIndex, steps } = pipelineState(
      base({
        has_dna: true,
        has_confirmed_manifest: true,
        variants_ready_count: 30,
        events_7d: 40,
        events_24h: 5,
      }),
    );
    expect(live).toBe(true);
    expect(currentIndex).toBe(steps.length);
    expect(steps.every((s) => s.done)).toBe(true);
  });
});

describe("nextAction", () => {
  it("points at the current step with customer_id appended", () => {
    const action = nextAction(base());
    expect(action?.href).toBe("/start?customer_id=test-co");
    expect(action?.label).toMatch(/guided/i);
  });

  it("live customer → view results", () => {
    const action = nextAction(
      base({
        has_dna: true,
        has_confirmed_manifest: true,
        variants_ready_count: 30,
        events_7d: 40,
        events_24h: 5,
      }),
    );
    expect(action?.href).toBe("/analytics?customer_id=test-co");
    expect(action?.label).toMatch(/results/i);
  });
});
