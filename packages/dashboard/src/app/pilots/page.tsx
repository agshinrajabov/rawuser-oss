"use client";

/**
 * /pilots — pilot-lead inbox (superadmin only).
 *
 * Reads D1.pilot_requests via GET /admin/pilot-requests/list. Each row is
 * a person who submitted the marketing site's pilot form; the status
 * column tracks the concierge follow-up (new → contacted → closed) via
 * POST /admin/pilot-requests/update-status.
 */

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
import type { PilotRequest } from "@/types/api";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const STATUS_BADGE: Record<PilotRequest["status"], "success" | "warn" | "default"> = {
  new: "success",
  contacted: "warn",
  closed: "default",
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PilotsInner() {
  const router = useRouter();
  const { user, loading: userLoading } = useCurrentUser();

  const [rows, setRows] = useState<PilotRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (userLoading) return;
    if (user && user.role !== "superadmin") {
      router.replace("/customers");
    }
  }, [user, userLoading, router]);

  useEffect(() => {
    if (userLoading) return;
    if (!user || user.role !== "superadmin") return;

    let cancelled = false;
    apiFetch<PilotRequest[]>("/admin/pilot-requests/list")
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load leads");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);

  async function setStatus(id: string, status: PilotRequest["status"]) {
    setSavingId(id);
    const previous = rows;
    setRows((current) => current.map((r) => (r.id === id ? { ...r, status } : r)));
    try {
      await apiFetch("/admin/pilot-requests/update-status", {
        method: "POST",
        body: JSON.stringify({ id, status }),
      });
    } catch {
      setRows(previous);
    } finally {
      setSavingId(null);
    }
  }

  if (userLoading) return null;
  if (user && user.role !== "superadmin") return null;

  const newCount = rows.filter((r) => r.status === "new").length;

  return (
    <>
      <div className="mb-5">
        <h1 className="text-lg font-semibold tracking-[-0.005em] text-fg">Pilot requests</h1>
        {!loading && (
          <p className="mt-0.5 text-[12.5px] text-fg-muted">
            {rows.length === 0
              ? "No leads yet. They land here the moment someone submits the pilot form."
              : `${rows.length} lead${rows.length !== 1 ? "s" : ""}${newCount > 0 ? ` · ${newCount} new` : ""}`}
          </p>
        )}
      </div>

      {error ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm">
          <p className="text-sm text-fg-muted">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm">
          <p className="text-sm text-fg-muted">Loading leads…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm">
          <p className="text-sm text-fg-muted">The inbox is empty.</p>
        </div>
      ) : (
        <div className="border border-border rounded-sm overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-fg-muted">
                    {formatDate(row.created_at)}
                  </TableCell>
                  <TableCell>
                    <a href={`mailto:${row.email}`} className="text-fg hover:underline">
                      {row.email}
                    </a>
                  </TableCell>
                  <TableCell>
                    {row.site_url ? (
                      <a
                        href={row.site_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-fg-muted hover:text-fg hover:underline"
                      >
                        {row.site_url.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      <span className="text-fg-muted">-</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[28ch] truncate text-fg-muted" title={row.note ?? ""}>
                    {row.note ?? "-"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[row.status]}>{row.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {row.status === "new" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={savingId === row.id}
                        onClick={() => setStatus(row.id, "contacted")}
                      >
                        Mark contacted
                      </Button>
                    )}
                    {row.status === "contacted" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={savingId === row.id}
                        onClick={() => setStatus(row.id, "closed")}
                      >
                        Close
                      </Button>
                    )}
                    {row.status === "closed" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={savingId === row.id}
                        onClick={() => setStatus(row.id, "new")}
                      >
                        Reopen
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

export default function PilotsPage() {
  return (
    <AppShell>
      <PilotsInner />
    </AppShell>
  );
}
