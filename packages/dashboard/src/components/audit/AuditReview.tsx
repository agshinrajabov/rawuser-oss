"use client";

/**
 * The founder's review of one audit (mock section 10): the facts, the checks
 * the builder ran, the actions (Release, Revoke, End now, Pilot terms, Make
 * this a pilot), then the report exactly as it will go out.
 * GET /admin/audit/review; superadmin only.
 */

import { Button } from "@/components/ui/Button";
import { CopyBlock } from "@/components/ui/CopyBlock";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  DAY_MS,
  PILOT_TERMS_NEEDED,
  RELEASE_NOTE,
  apiMessage,
  auditRowView,
  dayMon,
  endDeleteDate,
  fullDate,
  num,
  reviewTestLine,
  spendText,
  weekdayDay,
  weekdayTime,
} from "@/lib/audit";
import {
  type AuditReviewAnswer,
  type LinkAnswer,
  endAuditNow,
  getAuditReview,
  makePilot,
  makeShareLink,
  recordPilotTerms,
  releaseReport,
  revokeReport,
} from "@/lib/audit-api";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, Send } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AuditPill } from "./AuditPage";
import { Ring } from "./FirstRunAudit";
import { ReportView } from "./ReportView";

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-1 border-t border-border px-4 py-[9px] text-[13px] first-of-type:border-t-0 sm:grid-cols-[120px_minmax(0,1fr)]">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-muted">{k}</span>
      <span className="min-w-0 text-fg">{children}</span>
    </div>
  );
}

const quiet = "text-fg-muted";

export interface ReviewActions {
  onRelease: () => void;
  onNewLink: () => void;
  onRevoke: () => void;
  onEnd: () => void;
  onPilotTerms: () => void;
  onMakePilot: () => void;
  busy?: string | null;
  error?: string | null;
}

/** When the audit ends if released now: seven days on, never past the ceiling. */
export function endIfReleasedNow(a: AuditReviewAnswer, now: number): number {
  const end = now + 7 * DAY_MS;
  return a.status.ends_at_latest !== null ? Math.min(end, a.status.ends_at_latest) : end;
}

export function AuditReviewView({
  data,
  name,
  now,
  actions,
}: {
  data: AuditReviewAnswer;
  /** The contact's name from the application row; never shown in the report. */
  name: string | null;
  now: number;
  actions: ReviewActions;
}) {
  const s = data.status;
  const row = auditRowView(s, now);
  const released = data.released_at !== null && data.revoked_at === null;
  const revoked = data.revoked_at !== null;
  const over = s.stage === "ended" || s.stage === "lapsed";
  const pilot = s.stage === "pilot";
  const busy = actions.busy ?? null;
  const report = data.report;
  const first = name?.trim().split(/\s+/)[0] ?? null;

  return (
    <>
      <div className="mb-2">
        <Link
          href="/applications/"
          className="text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg"
        >
          All applications
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-fg">{s.domain}</h1>
          <p className="mt-0.5 text-sm text-fg-muted">
            Audit{name ? ` · ${name}` : ""} · signed up {weekdayDay(s.signed_up_at)}
          </p>
        </div>
        <AuditPill tone={row.tone} live={row.live}>
          {row.label}
        </AuditPill>
      </div>

      <div className="mt-5 grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <section className="rounded-md border border-dashed border-border-strong bg-[color-mix(in_srgb,var(--surface-muted)_55%,var(--surface))]">
          <h3 className="px-4 pt-3 text-[13px] font-semibold">The audit</h3>
          <div className="mt-1">
            <Fact k="Window">
              {s.window_start !== null && s.window_end !== null ? (
                <span className="font-mono text-[12.5px]">
                  {weekdayTime(s.window_start)} to {weekdayTime(s.window_end)}
                </span>
              ) : (
                <span className={quiet}>Not started</span>
              )}
            </Fact>
            <Fact k="Visits">
              {report ? (
                <>
                  <span className="font-mono text-[12.5px]">{num(report.visits)}</span>
                  {data.review && (
                    <span className={quiet}>
                      {" "}
                      · {num(data.review.no_marker_rows)} of {num(data.review.rows)} rows with no
                      visit marker
                    </span>
                  )}
                </>
              ) : (
                <span className="font-mono text-[12.5px]">{num(s.visits_counted ?? 0)}</span>
              )}
            </Fact>
            <Fact k="Spend">
              <span className="font-mono text-[12.5px]">{spendText(s.caps.spend_usd)}</span>
              <span className={quiet}> of {spendText(s.caps.spend_max)}</span>
            </Fact>
            <Fact k="Pages">
              <span className="font-mono text-[12.5px]">{s.caps.pages_used}</span>
              <span className={quiet}>
                {" "}
                of {s.caps.pages_max} · {num(s.total)} versions · rewrites {s.caps.rewrites_used} of{" "}
                {s.caps.rewrites_max}
              </span>
            </Fact>
            <Fact k="Test">
              {report ? reviewTestLine(report) : <span className={quiet}>No report yet</span>}
            </Fact>
            <Fact k="Banner">
              {s.consent_banner ? (
                <>
                  Ticked <span className={quiet}>· the banner line is in</span>
                </>
              ) : (
                "Not ticked"
              )}
            </Fact>
            <Fact k="Ends">
              {released && s.ends_at !== null ? (
                weekdayDay(s.ends_at)
              ) : s.ended_at !== null ? (
                <>
                  Ended {weekdayDay(s.ended_at)}
                  {s.delete_at !== null && (
                    <span className={quiet}> · deleted on {dayMon(s.delete_at)}</span>
                  )}
                </>
              ) : (
                <>
                  7 days after Release
                  {s.ends_at_latest !== null && (
                    <span className={quiet}> · {dayMon(s.ends_at_latest)} at the latest</span>
                  )}
                </>
              )}
            </Fact>
          </div>
        </section>
        <section className="rounded-md border border-dashed border-border-strong bg-[color-mix(in_srgb,var(--surface-muted)_55%,var(--surface))]">
          <h3 className="px-4 pt-3 text-[13px] font-semibold">Checks</h3>
          <div className="mt-1">
            {data.review && data.review.checks.length > 0 ? (
              data.review.checks.map((c) => (
                <div
                  key={c.id}
                  className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-2.5 border-t border-border px-4 py-[9px] text-[13px] first-of-type:border-t-0"
                >
                  <span
                    className={cn(
                      "inline-flex h-4 w-4 items-center justify-center rounded-full",
                      c.ok
                        ? "bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] text-[color:color-mix(in_srgb,var(--state-success)_70%,black)]"
                        : "bg-[color-mix(in_srgb,var(--state-warn)_10%,transparent)] text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]",
                    )}
                    aria-label={c.ok ? "Passed" : "Look at this"}
                  >
                    {c.ok ? <Check size={10} /> : <AlertTriangle size={10} />}
                  </span>
                  <span>{c.line}</span>
                </div>
              ))
            ) : (
              <p className="px-4 py-[9px] text-[13px] text-fg-muted">
                The checks run when the report is built.
              </p>
            )}
          </div>
        </section>
      </div>

      {pilot ? (
        <p className="mt-4 rounded-md border border-border bg-surface px-4 py-3 text-[13px] text-fg-muted">
          This audit is now a pilot.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-2.5">
            {released ? (
              <>
                <AuditPill tone="ok">
                  Released {data.released_at !== null ? weekdayDay(data.released_at) : ""}
                </AuditPill>
                <span className="text-xs text-fg-muted">
                  {data.expires_at !== null ? `Link expires ${dayMon(data.expires_at)}` : ""}
                  {s.ends_at !== null ? ` · ends ${weekdayDay(s.ends_at)}` : ""}
                </span>
              </>
            ) : report ? (
              <>
                <Button onClick={actions.onRelease} disabled={busy !== null || over}>
                  <Send size={14} aria-hidden />
                  Release
                </Button>
                <span className="text-xs text-fg-muted">
                  {revoked
                    ? "Revoked. Release makes a new link."
                    : `Copies the link once. The audit then ends ${weekdayDay(endIfReleasedNow(data, now))}.`}
                </span>
              </>
            ) : (
              <span className="text-xs text-fg-muted">
                No report yet. It is built when counting ends.
              </span>
            )}
            <span className="hidden flex-1 sm:block" />
            {released && (
              <Button variant="secondary" onClick={actions.onNewLink} disabled={busy !== null}>
                Make a new link
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={actions.onRevoke}
              disabled={!released || busy !== null}
            >
              Revoke
            </Button>
            <Button
              variant="secondary"
              className="text-[color:color-mix(in_srgb,var(--state-err)_85%,black)]"
              onClick={actions.onEnd}
              disabled={over || busy !== null}
            >
              End now
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 border-t border-border pt-3">
            <Button
              variant={data.can_make_pilot ? "default" : "secondary"}
              onClick={actions.onMakePilot}
              disabled={!data.can_make_pilot || busy !== null}
            >
              Make this a pilot
            </Button>
            <span className="text-xs text-fg-muted">
              {s.pilot_terms_at !== null
                ? `Pilot terms signed ${dayMon(s.pilot_terms_at)}.`
                : PILOT_TERMS_NEEDED}
            </span>
            {s.pilot_terms_at === null && (
              <Button
                size="sm"
                variant="ghost"
                onClick={actions.onPilotTerms}
                disabled={busy !== null}
              >
                Pilot terms
              </Button>
            )}
          </div>
          {actions.error && <p className="text-xs text-state-err">{actions.error}</p>}
        </div>
      )}

      <p className="mb-2.5 mt-7 font-mono text-[10.5px] uppercase tracking-[0.14em] text-fg-muted">
        {first ? `The report, as ${first} will see it` : "The report, as it will go out"}
      </p>
      {report ? (
        <div className="overflow-hidden rounded-md border border-border bg-[#f5f5f5]">
          <ReportView report={report} standalone={false} />
        </div>
      ) : (
        <div className="rounded-md border border-border px-4 py-6 text-sm text-fg-muted">
          Nothing to read yet.
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The dialogs
// ---------------------------------------------------------------------------

export function LinkDialogBody({
  title,
  link,
  onDone,
}: {
  title: string;
  link: LinkAnswer;
  onDone: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Copy it now. Only its hash is stored, so it cannot be shown again.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <CopyBlock label="Report link" content={link.link} multiline />
        <p className="text-xs text-fg-muted">
          Expires {fullDate(link.expires_at)}
          {link.ends_at !== null ? ` · the audit ends ${weekdayDay(link.ends_at)}` : ""}
        </p>
        <p className="mt-1.5 flex items-start gap-2 text-[13px] text-fg">
          <Ring className="mt-1.5" />
          {RELEASE_NOTE}
        </p>
      </div>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

export function EndDialogBody({
  deleteOn,
  busy,
  onCancel,
  onEnd,
}: {
  deleteOn: number;
  busy?: boolean;
  onCancel: () => void;
  onEnd: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>End the audit now?</DialogTitle>
        <DialogDescription>
          The versions stop and the page shows as built. Nothing more is recorded. The data is
          deleted on {dayMon(deleteOn)}.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onEnd} disabled={busy}>
          {busy ? "Ending…" : "End now"}
        </Button>
      </DialogFooter>
    </>
  );
}

function todayInput(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function PilotTermsBody({
  value,
  onValue,
  busy,
  onCancel,
  onSave,
  now,
}: {
  value: string;
  onValue: (v: string) => void;
  busy?: boolean;
  onCancel: () => void;
  onSave: () => void;
  now: number;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Pilot terms signed</DialogTitle>
        <DialogDescription>The day the customer signed the pilot terms.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pilot-terms-day">Signed on</Label>
        <Input
          id="pilot-terms-day"
          type="date"
          max={todayInput(now)}
          value={value}
          onChange={(e) => onValue(e.target.value)}
        />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={busy || !value}>
          {busy ? "Saving…" : "Record"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

type DialogState =
  | { kind: "none" }
  | { kind: "link"; title: string; link: LinkAnswer }
  | { kind: "end" }
  | { kind: "terms"; value: string };

export function AuditReviewScreen({
  customerId,
  name,
  onChanged,
}: {
  customerId: string;
  name: string | null;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<AuditReviewAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const now = Date.now();

  const load = useCallback(async () => {
    try {
      setData(await getAuditReview(customerId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(key: string, fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      after?.(r);
      await load();
      onChanged?.();
    } catch (e) {
      setError(apiMessage(e, "That did not go through. Try again."));
    } finally {
      setBusy(null);
    }
  }

  if (failed)
    return <p className="text-sm text-fg-muted">Could not read this audit. Reload the page.</p>;
  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <>
      <AuditReviewView
        data={data}
        name={name}
        now={now}
        actions={{
          busy,
          error,
          onRelease: () =>
            void run(
              "release",
              () => releaseReport(customerId),
              (link) => setDialog({ kind: "link", title: "Report released", link }),
            ),
          onNewLink: () =>
            void run(
              "link",
              () => makeShareLink(customerId),
              (link) => setDialog({ kind: "link", title: "New report link", link }),
            ),
          onRevoke: () => void run("revoke", () => revokeReport(customerId)),
          onEnd: () => setDialog({ kind: "end" }),
          onPilotTerms: () => setDialog({ kind: "terms", value: todayInput(now) }),
          onMakePilot: () => void run("pilot", () => makePilot(customerId)),
        }}
      />
      <Dialog
        open={dialog.kind !== "none"}
        onOpenChange={(open) => !open && busy === null && setDialog({ kind: "none" })}
      >
        <DialogContent>
          {dialog.kind === "link" && (
            <LinkDialogBody
              title={dialog.title}
              link={dialog.link}
              onDone={() => setDialog({ kind: "none" })}
            />
          )}
          {dialog.kind === "end" && (
            <EndDialogBody
              deleteOn={endDeleteDate(data.status, now)}
              busy={busy === "end"}
              onCancel={() => setDialog({ kind: "none" })}
              onEnd={() =>
                void run(
                  "end",
                  () => endAuditNow(customerId),
                  () => setDialog({ kind: "none" }),
                )
              }
            />
          )}
          {dialog.kind === "terms" && (
            <PilotTermsBody
              value={dialog.value}
              onValue={(value) => setDialog({ kind: "terms", value })}
              busy={busy === "terms"}
              now={now}
              onCancel={() => setDialog({ kind: "none" })}
              onSave={() => {
                const at = Date.parse(`${dialog.value}T12:00:00Z`);
                void run(
                  "terms",
                  () => recordPilotTerms(customerId, Math.min(at, Date.now())),
                  () => setDialog({ kind: "none" }),
                );
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
