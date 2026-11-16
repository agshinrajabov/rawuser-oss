import type { CustomerListItem } from "@/types/api";

/**
 * The five-step setup pipeline, in canonical order (ADR 0024). This is the
 * single source of truth for the Home spine and the per-screen "Step N of 5"
 * locators, so the visual order, the highlighted step, and the primary CTA
 * can never disagree.
 *
 * Note: `nextStep()` (components/customers/nextStep.ts) drives the legacy
 * /customers cards and NextStepsBanner with a slightly different branch order;
 * this helper is the canonical journey order for the new Home surface.
 */
export type PipelineStepKey = "brief" | "connect" | "versions" | "install" | "measure";

export interface PipelineStep {
  key: PipelineStepKey;
  label: string;
  /** Base route (customer_id query appended by the consumer). */
  href: string;
  /** What to do when this is the current step. */
  cta: string;
  done: boolean;
}

export interface PipelineState {
  steps: PipelineStep[];
  /** Index of the first not-done step, or steps.length when fully live. */
  currentIndex: number;
  /** True when every step is complete (customer is live). */
  live: boolean;
}

export function pipelineState(c: CustomerListItem): PipelineState {
  const steps: PipelineStep[] = [
    {
      key: "brief",
      label: "Product brief",
      // Pre-live steps run through the guided first run (docs/specs/first-run.md).
      href: "/start",
      cta: "Start the guided setup",
      done: c.has_dna,
    },
    {
      key: "connect",
      label: "Connect page",
      href: "/start",
      cta: "Connect the customer's page",
      done: c.has_confirmed_manifest,
    },
    {
      key: "versions",
      label: "Page versions",
      href: c.live_at ? "/variants" : "/start",
      cta: "Generate page versions",
      done: c.variants_ready_count > 0,
    },
    {
      key: "install",
      label: "Install snippet",
      href: "/onboard",
      cta: "Share the snippet to install",
      done: c.events_7d > 0,
    },
    {
      key: "measure",
      label: "Measure",
      href: "/analytics",
      cta: "View results",
      done: c.events_24h > 0,
    },
  ];

  const firstNotDone = steps.findIndex((s) => !s.done);
  const currentIndex = firstNotDone === -1 ? steps.length : firstNotDone;
  return { steps, currentIndex, live: firstNotDone === -1 };
}

/** Convenience: the step a customer should act on next, with customer_id appended. */
export function nextAction(c: CustomerListItem): { label: string; href: string } | null {
  const { steps, currentIndex, live } = pipelineState(c);
  const qs = `?customer_id=${encodeURIComponent(c.id)}`;
  if (live) return { label: "View results", href: `/analytics${qs}` };
  const step = steps[currentIndex];
  if (!step) return null;
  return { label: step.cta, href: `${step.href}${qs}` };
}
