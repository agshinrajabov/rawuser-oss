"use client";

/**
 * The free audit inside the first run (mock section 03): the strip under the
 * bar on Connect, Look and Live, the line under Go live, the Live line under
 * "What happens next", and the ended screen that replaces every page once an
 * audit is over (section 11).
 */

import { FirstRunShell } from "@/components/start/FirstRunShell";
import { GO_LIVE_LINE, TERMS_HREF, liveNextLine, stripText } from "@/lib/audit";
import { getAuditStatus } from "@/lib/audit-api";
import { cn } from "@/lib/utils";
import type { CustomerListItem } from "@/types/api";
import type { AuditStatus } from "@rawuser/shared";
import { useCallback, useEffect, useState } from "react";
import { AuditEndedView, reportStillOpen } from "./AuditPage";

/** A customer that is, or was, a free audit. */
export function isAuditCustomer(c: Pick<CustomerListItem, "plan" | "status"> | null): boolean {
  return c?.plan === "audit";
}

/** GET /admin/audit for an audit customer; null for anyone else, while loading, or on a failure. */
export function useAuditStatus(customer: CustomerListItem | null): {
  status: AuditStatus | null;
  reload: () => void;
} {
  const [status, setStatus] = useState<AuditStatus | null>(null);
  const [key, setKey] = useState(0);
  const id = customer?.id ?? "";
  const audit = isAuditCustomer(customer);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is a reload trigger
  useEffect(() => {
    if (!audit || !id) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    getAuditStatus(id)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [audit, id, key]);
  const reload = useCallback(() => setKey((k) => k + 1), []);
  return { status, reload };
}

export function Ring({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 flex-none rounded-full border-[1.5px] border-fg",
        className,
      )}
    />
  );
}

/** "Free audit · report about 14 October", with the terms on the right. */
export function AuditStrip({ status }: { status: AuditStatus | null }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border bg-surface-muted px-4 py-2 text-[12.5px] text-fg-muted sm:px-content-px">
      <span className="inline-flex items-center gap-2">
        <Ring />
        <span>
          <b className="font-medium text-fg">Free audit</b> · {stripText(status)}
        </span>
      </span>
      <a
        href={TERMS_HREF}
        target="_blank"
        rel="noreferrer noopener"
        className="hidden whitespace-nowrap text-xs underline decoration-dotted underline-offset-[3px] hover:text-fg sm:inline"
      >
        Audit terms
      </a>
    </div>
  );
}

/** Under Go live: "Your audit report counts the 7 days after this." */
export function GoLiveAuditLine() {
  return (
    <p className="mt-3 flex items-start gap-2 text-[13px] text-fg sm:items-center">
      <Ring className="mt-[5px] sm:mt-0" />
      {GO_LIVE_LINE}
    </p>
  );
}

/** Live, under "What happens next": the report date and the end. */
export function LiveAuditLine({ status }: { status: AuditStatus }) {
  const line = liveNextLine(status);
  if (!line) return null;
  return (
    <p className="-mt-1 mb-3 flex items-start gap-2 text-sm text-fg sm:items-center">
      <Ring className="mt-[7px] sm:mt-0" />
      {line}
    </p>
  );
}

/** The one screen an ended (or lapsed) audit shows, in the first-run frame without steps. */
export function AuditEndedScreen({ customer }: { customer: CustomerListItem }) {
  const { status } = useAuditStatus(customer);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!status || status.report_released_at === null) return;
    let cancelled = false;
    void reportStillOpen(customer.id, Date.now()).then((o) => {
      if (!cancelled) setOpen(o);
    });
    return () => {
      cancelled = true;
    };
  }, [status, customer.id]);
  const domain = customer.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return (
    <FirstRunShell domain={domain} current={null}>
      {status ? (
        <AuditEndedView status={status} reportOpen={open} reportHref="/audit/report/" />
      ) : (
        <div className="h-40" />
      )}
    </FirstRunShell>
  );
}
