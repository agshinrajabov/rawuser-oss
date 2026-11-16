import { describe, expect, it } from "vitest";
import { nextStep } from "../../src/components/customers/nextStep";
import type { CustomerListItem } from "../../src/types/api";

function base(): CustomerListItem {
  return {
    id: "test-co",
    slug: "test-co",
    domain: "test.co",
    plan: "pilot",
    status: "active",
    created_at: Date.now() - 86_400_000,
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
  };
}

describe("nextStep", () => {
  it("branch 1: nothing yet → the guided first run", () => {
    const step = nextStep(base());
    expect(step.intent).toBe("do");
    expect(step.href).toMatch(/^\/start\?customer_id=/);
    expect(step.label).toMatch(/[Cc]onnect/);
  });

  it("branch 1b: preview seen, not confirmed → confirm and go live, guided", () => {
    const step = nextStep({ ...base(), preview_seen_at: Date.now() });
    expect(step.intent).toBe("do");
    expect(step.href).toMatch(/^\/start\?customer_id=/);
    expect(step.label).toMatch(/[Cc]onfirm/);
  });

  it("branch 2: page confirmed the URL-first way, no brief → fill product brief", () => {
    const step = nextStep({ ...base(), has_confirmed_manifest: true });
    expect(step.intent).toBe("do");
    expect(step.href).toMatch(/^\/dna\?customer_id=/);
    expect(step.label).toMatch(/[Bb]rief/);
  });

  it("branch 3: has DNA + confirmed manifest, no variants, not live → go live (guided)", () => {
    const step = nextStep({
      ...base(),
      has_dna: true,
      has_confirmed_manifest: true,
      onboarding_stage: "dna_filled",
    });
    expect(step.intent).toBe("do");
    expect(step.href).toMatch(/^\/start\?customer_id=/);
    expect(step.label).toMatch(/[Gg]o live/);
  });

  it("branch 3b: live but versions gone → write the versions", () => {
    const step = nextStep({
      ...base(),
      has_dna: true,
      has_confirmed_manifest: true,
      live_at: Date.now(),
      onboarding_stage: "dna_filled",
    });
    expect(step.href).toMatch(/^\/variants\?customer_id=/);
    expect(step.label).toMatch(/[Ww]rite|[Gg]enerate/);
  });

  it("branch 4: all setup done, no traffic yet → share snippet", () => {
    const step = nextStep({
      ...base(),
      has_dna: true,
      variants_ready_count: 30,
      has_confirmed_manifest: true,
      events_7d: 0,
      onboarding_stage: "variants_generated",
    });
    expect(step.intent).toBe("do");
    expect(step.href).toMatch(/^\/onboard\?customer_id=/);
    expect(step.label).toMatch(/[Ss]nippet/);
  });

  it("branch 5: snippet installed, 7d traffic, but 0 in last 24h → quiet live", () => {
    const step = nextStep({
      ...base(),
      has_dna: true,
      variants_ready_count: 30,
      has_confirmed_manifest: true,
      events_7d: 12,
      events_24h: 0,
      last_event_at: Date.now() - 3_600_000,
      onboarding_stage: "snippet_installed",
    });
    expect(step.intent).toBe("live");
    expect(step.href).toMatch(/^\/variants\?customer_id=/);
    expect(step.detail).toMatch(/12/);
  });

  it("branch 6: fully live with 24h traffic → customer is live", () => {
    const step = nextStep({
      ...base(),
      has_dna: true,
      variants_ready_count: 30,
      has_confirmed_manifest: true,
      events_7d: 47,
      events_24h: 9,
      last_event_at: Date.now() - 300_000,
      onboarding_stage: "live",
    });
    expect(step.intent).toBe("live");
    expect(step.label).toMatch(/live/i);
    // F12: the footer detail must NOT repeat the "{events_24h} visits in last
    // 24h" string that the Live-traffic checklist row already shows. It
    // surfaces last-seen recency instead.
    expect(step.detail).toMatch(/last seen/i);
    expect(step.detail).not.toMatch(/visits in last 24h/);
  });

  it("customer id is url-encoded in href", () => {
    const step = nextStep({ ...base(), id: "acme corp/test" });
    expect(step.href).toContain("acme%20corp%2Ftest");
  });
});
