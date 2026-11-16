"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/Card";
import { formatDistanceToNow } from "@/lib/time";
import type { CustomerListItem, OnboardingStage } from "@/types/api";
import { Activity, ArrowRight, LayoutGrid, Plug, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { CustomerReadiness } from "./CustomerReadiness";
import { CustomerUsers } from "./CustomerUsers";
import { JourneyChecklistItem } from "./JourneyChecklistItem";
import { nextStep } from "./nextStep";

// ---------------------------------------------------------------------------
// F17: Snippet liveness badge helpers
// ---------------------------------------------------------------------------

type SnippetStatus = "active" | "stale" | "removed" | "never" | "unknown";

interface SnippetBadgeConfig {
  dot: string; // Tailwind color class for the status dot
  label: string; // Short badge text
  variant: "success" | "warn" | "err" | "default";
}

function getSnippetBadgeConfig(
  status: SnippetStatus,
  lastEventAt?: number | null,
): SnippetBadgeConfig {
  switch (status) {
    case "active":
      return {
        dot: "text-state-success",
        label: lastEventAt ? `Active · last event ${formatDistanceToNow(lastEventAt)}` : "Active",
        variant: "success",
      };
    case "stale":
      return {
        dot: "text-state-warn",
        label: lastEventAt ? `Stale · last event ${formatDistanceToNow(lastEventAt)}` : "Stale",
        variant: "warn",
      };
    case "removed":
      return {
        dot: "text-state-err",
        label: "Removed · script tag not found in HTML",
        variant: "err",
      };
    case "never":
      return {
        dot: "text-fg-faint",
        label: "Awaiting first visit",
        variant: "default",
      };
    default:
      return {
        dot: "text-fg-faint",
        label: "Not yet probed",
        variant: "default",
      };
  }
}

interface StageConfig {
  label: string;
  variant: "default" | "success";
}

const STAGE_CONFIG: Record<OnboardingStage, StageConfig> = {
  new: { label: "new", variant: "default" },
  dna_filled: { label: "DNA filled", variant: "default" },
  variants_generated: { label: "variants ready", variant: "success" },
  snippet_installed: { label: "snippet live", variant: "success" },
  live: { label: "live", variant: "success" },
};

interface JourneyCardProps {
  customer: CustomerListItem;
}

export function JourneyCard({ customer }: JourneyCardProps) {
  const stageConfig = STAGE_CONFIG[customer.onboarding_stage];
  const step = nextStep(customer);

  const variantDetail =
    customer.variants_ready_count > 0
      ? `${customer.variants_ready_count} ready · last gen ${formatDistanceToNow(customer.variants_last_generated_at ?? Date.now())}`
      : "-";

  // F17: use snippet_status when available; fall back to events_7d heuristic for
  // customers not yet probed (back-compat: snippet_status is undefined for legacy rows).
  const snippetStatus: SnippetStatus | undefined = customer.snippet_status;
  const snippetBadge =
    snippetStatus !== undefined
      ? getSnippetBadgeConfig(snippetStatus, customer.snippet_status_last_event_at)
      : null;

  // Legacy fallback detail string (used when snippet_status is not yet populated).
  const snippetDetailLegacy =
    customer.events_7d > 0
      ? `First visit ${formatDistanceToNow(customer.last_event_at ?? Date.now())} · installed`
      : "Awaiting first traffic";

  const snippetDone = snippetStatus
    ? snippetStatus === "active" || snippetStatus === "stale"
    : customer.events_7d > 0;

  const liveDetail =
    customer.events_24h > 0 ? `${customer.events_24h} visits in last 24h` : "0 visits in last 24h";

  return (
    <Card>
      <CardHeader className="p-4 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-semibold text-fg truncate">{customer.slug}</span>
            <span className="text-xs text-fg-muted truncate">{customer.domain}</span>
            {customer.contact_email ? (
              <span className="text-xs text-fg-faint truncate">
                {customer.contact_name
                  ? `${customer.contact_name} · ${customer.contact_email}`
                  : customer.contact_email}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
            <Badge variant={stageConfig.variant}>&#9679; {stageConfig.label}</Badge>
            {/* Before go live: red and amber lines, red first (readiness-check mock, A19). */}
            <CustomerReadiness customerId={customer.id} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-2.5">
        <JourneyChecklistItem
          done={customer.has_dna}
          icon={Sparkles}
          label="Product brief"
          detail={customer.has_dna ? "Product, ICP, value props, voice" : "-"}
        />
        <JourneyChecklistItem
          done={customer.has_confirmed_manifest}
          icon={Wand2}
          label="Elements confirmed"
          detail={customer.has_confirmed_manifest ? "Manifest confirmed" : "-"}
        />
        <JourneyChecklistItem
          done={customer.variants_ready_count > 0}
          icon={LayoutGrid}
          label="Page versions"
          detail={variantDetail}
        />
        {snippetBadge ? (
          // F17: tri-state liveness badge — replaces the binary "Snippet installed" line.
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">
              <Plug size={14} className={snippetBadge.dot} />
            </span>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs font-medium text-fg">Snippet</span>
              <Badge variant={snippetBadge.variant} className="w-fit">
                &#9679; {snippetBadge.label}
              </Badge>
            </div>
          </div>
        ) : (
          // Legacy fallback: events_7d heuristic (back-compat for unprobed customers)
          <JourneyChecklistItem
            done={snippetDone}
            icon={Plug}
            label="Snippet installed"
            detail={snippetDetailLegacy}
          />
        )}
        <JourneyChecklistItem
          done={customer.events_24h > 0}
          icon={Activity}
          label="Live traffic"
          detail={liveDetail}
        />
      </CardContent>

      <CardFooter className="px-4 py-3 border-t border-border flex items-center justify-between gap-2">
        {step.intent === "live" ? (
          <span className="text-xs text-fg-muted">{step.detail ?? step.label}</span>
        ) : (
          <>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs text-fg-muted shrink-0">Next:</span>
              <span className="text-sm font-medium text-fg truncate">{step.label}</span>
            </div>
            <Button size="sm" variant="default" asChild className="shrink-0">
              <Link href={step.href}>
                {step.label}
                <ArrowRight size={12} />
              </Link>
            </Button>
          </>
        )}
      </CardFooter>

      <CustomerUsers customerId={customer.id} />
    </Card>
  );
}
