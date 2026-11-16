"use client";

/**
 * /applications: pilot applications from invite links (superadmin only).
 * docs/specs/pilot-apply.md. Reads GET /admin/applications/list; archived
 * rows are hidden unless "Show archived" asks for ?all=1.
 *
 * The free audit (docs/specs/ai-traffic-audit.md §3.1, mock sections 01 and
 * 10): "New audit link", the Kind and Spend columns, every audit stage in the
 * Status column, and ?audit=<customer_id> opens that audit's review.
 */

import { ApplicationDetail, parseAnswers } from "@/components/applications/ApplicationDetail";
import { InviteDialog } from "@/components/applications/InviteDialog";
import { AuditInviteDialog, openLine } from "@/components/audit/AuditInviteDialog";
import { AuditPill } from "@/components/audit/AuditPage";
import { AuditReviewScreen } from "@/components/audit/AuditReview";
import { AppShell } from "@/components/shell/AppShell";
import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";
import { apiFetch } from "@/lib/api";
import {
  type ApplicationStage,
  STAGE_LABEL,
  applicationStage,
  siteHost,
  sourceLabel,
  toMs,
} from "@/lib/apply";
import { AUDITS_FULL_LINE, auditRowView, spendText } from "@/lib/audit";
import { type AuditSummary, getAuditSummary } from "@/lib/audit-api";
import { formatDistanceToNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { PilotApplication } from "@/types/api";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

const STAGE_BADGE: Record<ApplicationStage, "success" | "warn" | "default"> = {
  invited: "default",
  applied: "warn",
  tag_seen: "success",
  live: "success",
  archived: "default",
};

/** The latest thing that happened to the row. */
function lastEvent(row: PilotApplication): number {
  return toMs(row.live_at ?? row.tag_seen_at ?? row.submitted_at ?? row.created_at) ?? 0;
}

function ApplicationsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const auditId = params.get("audit");
  const { user, loading: userLoading } = useCurrentUser();
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  const [rows, setRows] = useState<PilotApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const isSuperadmin = user?.role === "superadmin";

  useEffect(() => {
    if (userLoading) return;
    if (user && user.role !== "superadmin") router.replace("/customers");
  }, [user, userLoading, router]);

  const loadSummary = useCallback(() => {
    getAuditSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  const load = useCallback(async (all: boolean, signal?: { cancelled: boolean }) => {
    try {
      const data = await apiFetch<PilotApplication[]>(
        `/admin/applications/list${all ? "?all=1" : ""}`,
      );
      if (!signal?.cancelled) {
        setRows([...data].sort((a, b) => lastEvent(b) - lastEvent(a)));
        setError(null);
      }
    } catch (err) {
      if (!signal?.cancelled)
        setError(err instanceof Error ? err.message : "Failed to load applications");
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userLoading || !isSuperadmin) return;
    const signal = { cancelled: false };
    setLoading(true);
    void load(showArchived, signal);
    loadSummary();
    return () => {
      signal.cancelled = true;
    };
  }, [userLoading, isSuperadmin, showArchived, load, loadSummary]);

  async function archive(id: string) {
    setArchivingId(id);
    const previous = rows;
    setRows((current) =>
      showArchived
        ? current.map((r) => (r.id === id ? { ...r, status: "archived" } : r))
        : current.filter((r) => r.id !== id),
    );
    if (!showArchived) setSelectedId(null);
    try {
      await apiFetch("/admin/applications/archive", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
    } catch {
      setRows(previous);
      setSelectedId(id);
    } finally {
      setArchivingId(null);
    }
  }

  async function deleteContact(id: string) {
    await apiFetch("/admin/applications/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    setRows((current) =>
      current.map((r) =>
        r.id === id
          ? { ...r, contact_name: null, contact_email: null, site_url: null, answers: null }
          : r,
      ),
    );
  }

  if (userLoading) return null;
  if (user && user.role !== "superadmin") return null;

  const waiting = rows.filter(
    (r) => r.kind !== "audit" && applicationStage(r) === "applied",
  ).length;
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const auditsFull = summary !== null && summary.open >= summary.max;
  const now = Date.now();

  if (auditId) {
    const row = rows.find((r) => r.customer_id === auditId);
    return (
      <AuditReviewScreen
        key={auditId}
        customerId={auditId}
        name={row?.contact_name ?? row?.invited_name ?? null}
        onChanged={() => {
          void load(showArchived);
          loadSummary();
        }}
      />
    );
  }

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.005em] text-fg">Applications</h1>
          {!loading && !error && (
            <p className="mt-0.5 text-[12.5px] text-fg-muted">
              {rows.length === 0
                ? "No applications yet. Make an invite link and send it to a founder."
                : `${rows.length} application${rows.length !== 1 ? "s" : ""}${
                    waiting > 0 ? ` · ${waiting} waiting for the tag` : ""
                  }`}
              {summary ? ` · ${openLine(summary)}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setAuditOpen(true)} disabled={auditsFull}>
              <Plus size={14} />
              New audit link
            </Button>
            <Button onClick={() => setInviteOpen(true)}>
              <Plus size={14} />
              New invite link
            </Button>
          </div>
          {auditsFull && <p className="text-xs text-fg-muted">{AUDITS_FULL_LINE}</p>}
        </div>
      </div>

      <div className="mb-3 flex justify-end">
        <label className="inline-flex items-center gap-2 text-xs text-fg-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="accent-[var(--fg)]"
          />
          Show archived
        </label>
      </div>

      {error ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm">
          <p className="text-sm text-fg-muted">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm">
          <p className="text-sm text-fg-muted">Loading applications…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm">
          <p className="text-sm text-fg-muted">Nothing here yet.</p>
        </div>
      ) : (
        <div
          className={cn(
            "grid gap-4 items-start",
            selected && "2xl:grid-cols-[minmax(0,1fr)_24rem]",
          )}
        >
          <div className="border border-border rounded-sm overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Who</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const a = parseAnswers(row.answers);
                  const stage = applicationStage(row);
                  const site = row.site_url || a.url || row.invited_site;
                  const expiresAt = toMs(row.expires_at);
                  const expired =
                    stage === "invited" && expiresAt !== null && expiresAt < Date.now();
                  const isSelected = row.id === selectedId;
                  const isAudit = row.kind === "audit";
                  const audit = isAudit && row.audit ? auditRowView(row.audit, now) : null;
                  // An audit with a customer opens its review; anything else the detail.
                  const open = () =>
                    isAudit && row.customer_id
                      ? router.push(`/applications/?audit=${encodeURIComponent(row.customer_id)}`)
                      : setSelectedId(isSelected ? null : row.id);
                  return (
                    <TableRow
                      key={row.id}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                      tabIndex={0}
                      aria-selected={isSelected}
                      className={cn(
                        "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
                        isSelected && "bg-surface-muted",
                        (stage === "archived" || audit?.faint) && "opacity-60",
                      )}
                    >
                      <TableCell>
                        <div className="max-w-[14rem] text-fg truncate">
                          {row.contact_name || row.invited_name || (
                            <span className="text-fg-faint">Unnamed invite</span>
                          )}
                        </div>
                        {(a.product || site) && (
                          <div className="max-w-[14rem] text-xs text-fg-muted truncate">
                            {a.product || siteHost(site)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-fg-muted whitespace-nowrap">
                        {site ? siteHost(site) : "-"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex h-5 items-center whitespace-nowrap rounded-full border border-border px-[7px] text-[11px]",
                            isAudit ? "border-dashed text-fg" : "text-fg-muted",
                          )}
                        >
                          {isAudit ? "Audit" : "Pilot"}
                        </span>
                      </TableCell>
                      <TableCell>
                        {audit ? (
                          <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-muted">
                            <AuditPill tone={audit.tone} live={audit.live}>
                              {audit.label}
                            </AuditPill>
                            {audit.detail && <span>{audit.detail}</span>}
                          </span>
                        ) : (
                          <Badge variant={STAGE_BADGE[stage]} className="whitespace-nowrap">
                            {STAGE_LABEL[stage]}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-fg-muted whitespace-nowrap">
                        {row.audit ? spendText(row.audit.caps.spend_usd) : "-"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-fg-muted whitespace-nowrap">
                        {expired ? "expired" : formatDistanceToNow(lastEvent(row))}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {selected && (
            <ApplicationDetail
              key={selected.id}
              row={selected}
              archiving={archivingId === selected.id}
              onArchive={() => void archive(selected.id)}
              onDeleteContact={() => deleteContact(selected.id)}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      )}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={() => void load(showArchived)}
      />
      <AuditInviteDialog
        open={auditOpen}
        onOpenChange={setAuditOpen}
        summary={summary}
        onCreated={() => {
          void load(showArchived);
          loadSummary();
        }}
      />
    </>
  );
}

export default function ApplicationsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <ApplicationsInner />
      </Suspense>
    </AppShell>
  );
}
