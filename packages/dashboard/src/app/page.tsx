"use client";

import { PipelineSpine } from "@/components/home/PipelineSpine";
import { nextAction, pipelineState } from "@/components/home/pipeline";
import { AppShell } from "@/components/shell/AppShell";
import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { Button } from "@/components/ui/Button";
import { Separator } from "@/components/ui/Separator";
import { Skeleton } from "@/components/ui/Skeleton";
import { Overview } from "@/components/v2/Overview";
import { How } from "@/components/v2/parts";
import type { CustomerListItem } from "@/types/api";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

function displayName(c: CustomerListItem): string {
  return c.slug || c.domain || c.id;
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-fg">{title}</h1>
        <p className="text-sm text-fg-muted mt-0.5">{subtitle}</p>
      </div>
      <Separator className="mb-4" />
    </>
  );
}

/** One customer row in the operator fleet snapshot: name + status + next action. */
function FleetRow({ customer }: { customer: CustomerListItem }) {
  const { currentIndex, live, steps } = pipelineState(customer);
  const action = nextAction(customer);
  return (
    <div className="flex items-center justify-between gap-3 bg-surface border border-border rounded-md px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-fg truncate">{displayName(customer)}</div>
        <div className="text-xs text-fg-muted mt-0.5">
          {live
            ? "Live"
            : `Step ${currentIndex + 1} of ${steps.length} · ${steps[currentIndex]?.label ?? ""}`}
        </div>
      </div>
      {action && (
        <Button asChild size="sm" variant={live ? "secondary" : "default"}>
          <Link href={action.href}>
            {action.label}
            <ArrowRight size={13} />
          </Link>
        </Button>
      )}
    </div>
  );
}

function OperatorHome() {
  const { customers, loading } = useCustomerList();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("customer_id");
  const selected = selectedId ? customers.find((c) => c.id === selectedId) : null;

  if (selected) {
    return (
      <>
        <Overview customerId={selected.id} superadmin />
        <How summary="Setup steps for this customer" className="mt-8">
          <PipelineSpine customer={selected} />
        </How>
      </>
    );
  }

  // Fleet snapshot — not-live customers first so attention rises to the top.
  const sorted = [...customers].sort(
    (a, b) => Number(pipelineState(a).live) - Number(pipelineState(b).live),
  );

  return (
    <>
      <PageHeader title="Home" subtitle="Your customers and what each one needs next." />
      {loading ? (
        <div className="space-y-2">
          {["a", "b", "c"].map((k) => (
            <Skeleton key={k} className="h-14 w-full" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-md">
          <p className="text-sm text-fg-muted mb-1">No customers yet</p>
          <p className="text-xs text-fg-faint mb-3">
            Add a customer, then walk them through the five setup steps.
          </p>
          <Button asChild size="sm">
            <Link href="/customers">Go to customers</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((c) => (
            <FleetRow key={c.id} customer={c} />
          ))}
        </div>
      )}
    </>
  );
}

/** A customer's home is the Overview; until the site is live, the first run. */
function CustomerHome() {
  const { user } = useCurrentUser();
  const { customers } = useCustomerList();
  const router = useRouter();
  const cid = user?.customer_id ?? "";
  const mine = customers.find((c) => c.id === cid);
  useEffect(() => {
    if (mine && !mine.live_at) router.replace("/start");
  }, [mine, router]);
  if (!cid) return null;
  return <Overview customerId={cid} superadmin={false} />;
}

function HomeInner() {
  const { user } = useCurrentUser();
  if (user?.role === "customer") return <CustomerHome />;
  return <OperatorHome />;
}

export default function RootPage() {
  return (
    <AppShell>
      <Suspense>
        <HomeInner />
      </Suspense>
    </AppShell>
  );
}
