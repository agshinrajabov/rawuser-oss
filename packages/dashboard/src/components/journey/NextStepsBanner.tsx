"use client";

import { nextStep } from "@/components/customers/nextStep";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { Button } from "@/components/ui/Button";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type Screen = "dna" | "variants" | "intents" | "links" | "onboard";

interface NextStepsBannerProps {
  screen: Screen;
}

const SCREEN_HREF: Record<Screen, string> = {
  dna: "/dna",
  variants: "/variants",
  intents: "/intents",
  links: "/links",
  onboard: "/onboard",
};

const SCREEN_LABEL: Record<string, string> = {
  "/dna": "Product brief",
  "/variants": "Page versions",
  "/intents": "Visitor intents",
  "/links": "Campaign links",
  "/onboard": "Connect page",
  "/start": "Guided setup",
};

export function NextStepsBanner({ screen }: NextStepsBannerProps) {
  const searchParams = useSearchParams();
  const customerId = searchParams.get("customer_id");
  const { customers } = useCustomerList();

  if (!customerId) return null;

  const customer = customers.find((c) => c.id === customerId);
  if (!customer) return null;

  const step = nextStep(customer);

  if (step.intent === "live") {
    return (
      <div className="mb-4 flex items-center gap-2 text-xs text-fg-muted">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-state-success shrink-0" />
        {step.label}
        {step.detail ? <span className="text-fg-faint">· {step.detail}</span> : null}
      </div>
    );
  }

  const targetHrefPath = step.href.split("?")[0] ?? step.href;

  if (targetHrefPath === SCREEN_HREF[screen]) {
    return (
      <div className="mb-4 flex items-center gap-3 px-3 py-2.5 rounded-md border border-border bg-surface">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg shrink-0" />
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-fg leading-tight">Next: {step.label}</span>
          {step.detail ? (
            <span className="text-xs text-fg-muted leading-tight mt-0.5">{step.detail}</span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center gap-3 px-3 py-2.5 rounded-md border border-border bg-surface">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg shrink-0" />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium text-fg leading-tight">Next: {step.label}</span>
        {step.detail ? (
          <span className="text-xs text-fg-muted leading-tight mt-0.5">{step.detail}</span>
        ) : null}
      </div>
      <Button size="sm" asChild>
        <Link href={step.href}>
          Go to {SCREEN_LABEL[targetHrefPath] ?? "next screen"}
          <ArrowRight size={13} />
        </Link>
      </Button>
    </div>
  );
}
