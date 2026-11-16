"use client";

/**
 * One pilot application: the status line, the answers, and the three
 * actions (Open brief, Copy tag, Archive). docs/specs/pilot-apply.md.
 */

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { STAGE_LABEL, STAGE_ORDER, siteHost, sourceLabel, stageIndex } from "@/lib/apply";
import { buildSnippet } from "@/lib/snippet-tag";
import { cn } from "@/lib/utils";
import type { PilotApplication, PilotApplicationAnswers } from "@/types/api";
import { Archive, Check, Copy, FileText, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export function parseAnswers(raw: PilotApplication["answers"]): PilotApplicationAnswers {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as PilotApplicationAnswers;
    } catch {
      return {};
    }
  }
  return raw;
}

function parseAnswersPresent(raw: PilotApplication["answers"]): boolean {
  const a = parseAnswers(raw);
  return Object.values(a).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)));
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-2 border-b border-border last:border-0">
      <dt className="text-xs text-fg-muted pt-px">{label}</dt>
      <dd className="text-sm text-fg whitespace-pre-line break-words">{children}</dd>
    </div>
  );
}

const dash = <span className="text-fg-faint">-</span>;

export function ApplicationDetail({
  row,
  onArchive,
  onDeleteContact,
  onClose,
  archiving,
}: {
  row: PilotApplication;
  onArchive: () => void;
  /** Resolves when the worker has removed the data; rejects with a message. */
  onDeleteContact: () => Promise<void>;
  onClose: () => void;
  archiving: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const hasContactData = Boolean(
    row.contact_name || row.contact_email || row.site_url || parseAnswersPresent(row.answers),
  );

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteContact();
      setConfirmOpen(false);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete the contact data.");
    } finally {
      setDeleting(false);
    }
  }
  const a = parseAnswers(row.answers);
  const reached = stageIndex(row);
  const who = row.contact_name || row.invited_name || "Unnamed invite";
  const site = row.site_url || a.url || row.invited_site;

  async function copyTag() {
    if (!row.customer_id) return;
    try {
      await navigator.clipboard.writeText(buildSnippet(row.customer_id));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // non-secure context
    }
  }

  return (
    <section
      aria-label={`Application from ${who}`}
      className="border border-border rounded-sm bg-surface animate-fade-in"
    >
      <header className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h2 className="text-md font-semibold text-fg truncate">{who}</h2>
          {site && (
            <p className="text-xs font-mono text-fg-muted mt-0.5 truncate">{siteHost(site)}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          className="p-1 rounded-sm text-fg-faint hover:text-fg hover:bg-surface-muted transition-colors duration-fast"
        >
          <X size={14} />
        </button>
      </header>

      {/* Status line: Invited → Applied → Tag seen → Live */}
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 mt-3 text-xs">
        {STAGE_ORDER.map((stage, i) => (
          <li key={stage} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className={cn(i <= reached ? "text-fg-muted" : "text-fg-faint")}>
                →
              </span>
            )}
            <span
              className={cn(
                "inline-flex items-center gap-1",
                i <= reached ? "text-fg font-medium" : "text-fg-faint",
              )}
              aria-current={i === reached ? "step" : undefined}
            >
              {i <= reached && (
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    i === reached ? "bg-state-success" : "bg-fg-muted",
                  )}
                />
              )}
              {STAGE_LABEL[stage]}
            </span>
          </li>
        ))}
        {row.status === "archived" && <li className="ml-2 text-fg-faint">(archived)</li>}
      </ol>

      <dl className="px-4 mt-3">
        <Row label="Sells">{a.product || dash}</Row>
        <Row label="Best customer">{a.icp || dash}</Row>
        <Row label="Sets apart">{a.differentiator || dash}</Row>
        <Row label="Numbers">{a.numbers || dash}</Row>
        <Row label="Sources">
          {a.sources && a.sources.length > 0 ? a.sources.map(sourceLabel).join(", ") : dash}
        </Row>
        <Row label="Contact email">
          {row.contact_email ? (
            <a href={`mailto:${row.contact_email}`} className="hover:underline">
              {row.contact_email}
            </a>
          ) : (
            dash
          )}
        </Row>
        {row.customer_id && (
          <Row label="Customer">
            <span className="font-mono text-xs">{row.customer_id}</span>
          </Row>
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 mt-1 border-t border-border">
        {row.customer_id ? (
          <>
            <Button asChild size="sm" variant="secondary">
              <Link href={`/dna?customer_id=${encodeURIComponent(row.customer_id)}`}>
                <FileText size={12} />
                Open brief
              </Link>
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void copyTag()}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy tag"}
            </Button>
          </>
        ) : (
          <span className="text-xs text-fg-muted">No customer yet: they have not applied.</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {hasContactData && (
            <Button
              size="sm"
              variant="ghost"
              className="text-fg-muted hover:text-state-err"
              onClick={() => {
                setDeleteError(null);
                setConfirmOpen(true);
              }}
            >
              <Trash2 size={12} />
              Delete contact data
            </Button>
          )}
          {row.status !== "archived" && (
            <Button
              size="sm"
              variant="ghost"
              className="text-fg-muted"
              disabled={archiving}
              onClick={onArchive}
            >
              <Archive size={12} />
              Archive
            </Button>
          )}
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(open) => !deleting && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete contact data?</DialogTitle>
            <DialogDescription>
              This removes the name, email, answers and site from this application and the
              customer&apos;s contact fields. It can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && <p className="text-xs text-state-err">{deleteError}</p>}
          <DialogFooter>
            <Button variant="ghost" disabled={deleting} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
