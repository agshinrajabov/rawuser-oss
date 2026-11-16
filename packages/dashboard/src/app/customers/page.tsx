"use client";

import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { InviteUserDialog } from "@/components/customers/InviteUserDialog";
import { JourneyCard } from "@/components/customers/JourneyCard";
import { AppShell } from "@/components/shell/AppShell";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { useTopbarRightSlot } from "@/components/shell/TopbarSlotContext";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import type { CustomerListItem, OnboardingStage } from "@/types/api";
import { Plus, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";

function stageLabel(stage: OnboardingStage): "live" | "in progress" | "new" {
  if (stage === "live") return "live";
  if (stage === "new") return "new";
  return "in progress";
}

function SkeletonCard() {
  return (
    <div className="bg-surface border border-border rounded-md">
      <div className="p-4 border-b border-border flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-5 w-20 rounded-pill" />
      </div>
      <div className="p-4 space-y-2.5">
        {(["r1", "r2", "r3", "r4", "r5"] as const).map((k) => (
          <div key={k} className="flex items-center gap-2">
            <Skeleton className="h-3.5 w-3.5 shrink-0" />
            <div className="flex flex-col gap-1 flex-1">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-3.5 w-3.5 rounded-full shrink-0" />
          </div>
        ))}
      </div>
      <div className="px-4 py-3 border-t border-border flex items-center justify-between">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-28 rounded-sm" />
      </div>
    </div>
  );
}

function CustomersInner() {
  const { customers, loading, refresh } = useCustomerList();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  function handleCreated(_customer: CustomerListItem) {
    setDialogOpen(false);
    refresh();
  }

  const liveCount = customers.filter((c) => stageLabel(c.onboarding_stage) === "live").length;
  const inProgressCount = customers.filter(
    (c) => stageLabel(c.onboarding_stage) === "in progress",
  ).length;
  const newCount = customers.filter((c) => stageLabel(c.onboarding_stage) === "new").length;

  const contextParts: string[] = [];
  if (!loading) {
    contextParts.push(`${customers.length} customer${customers.length !== 1 ? "s" : ""}`);
    if (liveCount > 0) contextParts.push(`${liveCount} live`);
    if (inProgressCount > 0) contextParts.push(`${inProgressCount} in progress`);
    if (newCount > 0) contextParts.push(`${newCount} new`);
  }

  const topbarRight = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setInviteOpen(true)}>
          <UserPlus size={13} />
          Invite user
        </Button>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus size={13} />
          Create
        </Button>
      </div>
    ),
    [],
  );

  useTopbarRightSlot(topbarRight);

  return (
    <>
      <div className="mb-5">
        <h1 className="text-lg font-semibold tracking-[-0.005em] text-fg">Customers</h1>
        {!loading && (
          <p className="mt-0.5 text-[12.5px] text-fg-muted">{contextParts.join(" · ")}</p>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : customers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm">
          <p className="text-sm text-fg-muted mb-3">No customers yet</p>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus size={13} />
            Create your first customer
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {customers.map((c) => (
            <JourneyCard key={c.id} customer={c} />
          ))}
        </div>
      )}

      <InviteUserDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        customers={customers}
      />

      <CreateCustomerDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={handleCreated}
      />
    </>
  );
}

export default function CustomersPage() {
  return (
    <AppShell>
      <CustomersInner />
    </AppShell>
  );
}
