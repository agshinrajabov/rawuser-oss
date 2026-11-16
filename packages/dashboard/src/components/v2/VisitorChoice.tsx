"use client";

/**
 * Visitor choice (ADR 0038 part 2; mock design/mock/direct-visitors/
 * dashboard.html, approved as style A; the bar since 2026-11-04, mock overlay.html): one question at the bottom of the home page
 * for visits with nothing to go on. It lives on Versions, under
 * "Came straight to the page", because each answer is a version.
 *
 * The contract (docs/specs/direct-visitors.md §2) points each answer to an
 * existing live version of the home page, so editing an answer is its words
 * and the version it shows; nothing new is written. The customer's own edit
 * is live at once; a question the brief suggests after the first waits for
 * the OK. Calls and words: lib/direct.ts.
 */

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  type AnswerRow,
  CHOICE_LABEL_MAX,
  CHOICE_LINES,
  CHOICE_MAX,
  CHOICE_MIN,
  CHOICE_NOTICE,
  CHOICE_QUESTION_MAX,
  type ChoiceState,
  type ChoiceText,
  type ChoiceVersion,
  answerRows,
  checkEdit,
  getChoice,
  previewLink,
  reachText,
  returnedLine,
  saveChoice,
  skippedLine,
  writeChoice,
} from "@/lib/direct";
import { kindOf, reasonLabel } from "@/lib/kinds";
import { num } from "@/lib/proof";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Copy, ExternalLink, Loader2, PenLine, Plus, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useId, useState } from "react";
import { How, Switch, TONE } from "./parts";

const pct = (r: number | null) => (r === null ? "0%" : `${(r * 100).toFixed(1)}%`);

/** "AI chat, has a problem: Your next CIM, ready in five days." */
export function versionOption(v: ChoiceVersion): string {
  const k = kindOf(v.source_dim);
  const who = k ? k.short : "General";
  const why = reasonLabel(v.intent_dim).toLowerCase();
  return `${who}, ${why}${v.headline ? `: ${v.headline}` : ""}`;
}

function headlineOf(versions: readonly ChoiceVersion[], intent: string, source: string) {
  return versions.find((v) => v.intent_dim === intent && v.source_dim === source)?.headline ?? "";
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] tabular-nums",
        value.length > max ? TONE.WARN_TEXT : "text-fg-muted",
      )}
    >
      {value.length} / {max}
    </span>
  );
}

function Editor({
  start,
  versions,
  on,
  reachS,
  busy,
  onSave,
  onCancel,
}: {
  start: ChoiceText;
  versions: readonly ChoiceVersion[];
  on: boolean;
  reachS: number;
  busy: boolean;
  onSave: (t: ChoiceText) => void;
  onCancel: () => void;
}) {
  const [t, setT] = useState<ChoiceText>(start);
  const [said, setSaid] = useState<string | null>(null);
  const uid = useId();
  const setAnswer = (i: number, patch: Partial<ChoiceText["answers"][number]>) =>
    setT((x) => ({
      ...x,
      answers: x.answers.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    }));
  const used = new Set(t.answers.map((a) => `${a.intent_dim}:${a.source_dim}`));
  const spare = versions.find((v) => !used.has(`${v.intent_dim}:${v.source_dim}`)) ?? versions[0];
  return (
    <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/60 px-4 py-3.5">
      <label htmlFor={`${uid}-q`} className="flex flex-col gap-1.5">
        <span className="flex items-baseline justify-between gap-3 text-[12.5px] font-medium">
          Question
          <Counter value={t.question} max={CHOICE_QUESTION_MAX} />
        </span>
        <Input
          id={`${uid}-q`}
          value={t.question}
          maxLength={CHOICE_QUESTION_MAX + 10}
          onChange={(e) => setT({ ...t, question: e.target.value })}
          className="h-8 max-w-[420px] bg-surface text-[13px]"
        />
      </label>
      {t.answers.map((a, i) => (
        <fieldset
          key={a.slot}
          className="grid grid-cols-1 gap-1.5 rounded-sm border border-border bg-surface p-2.5 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] sm:items-end sm:gap-2.5"
        >
          <legend className="sr-only">Answer {i + 1}</legend>
          <label htmlFor={`${uid}-a${i}`} className="flex min-w-0 flex-col gap-1">
            <span className="flex items-baseline justify-between gap-2 text-xs text-fg-muted">
              Answer {i + 1}
              <Counter value={a.label} max={CHOICE_LABEL_MAX} />
            </span>
            <Input
              id={`${uid}-a${i}`}
              value={a.label}
              maxLength={CHOICE_LABEL_MAX + 10}
              onChange={(e) => setAnswer(i, { label: e.target.value })}
              className="h-8 text-[13px]"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-fg-muted">Shows this version</span>
            <select
              value={`${a.intent_dim}:${a.source_dim}`}
              onChange={(e) => {
                const [intent_dim = "", source_dim = ""] = e.target.value.split(":");
                setAnswer(i, { intent_dim, source_dim });
              }}
              className="h-8 w-full min-w-0 truncate rounded-sm border border-border-strong bg-surface px-2 text-[13px] text-fg"
            >
              {!versions.some(
                (v) => v.intent_dim === a.intent_dim && v.source_dim === a.source_dim,
              ) && <option value={`${a.intent_dim}:${a.source_dim}`}>Choose a version</option>}
              {versions.map((v) => (
                <option
                  key={`${v.intent_dim}:${v.source_dim}`}
                  value={`${v.intent_dim}:${v.source_dim}`}
                >
                  {versionOption(v)}
                </option>
              ))}
            </select>
          </label>
          {t.answers.length > CHOICE_MIN ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove answer ${i + 1}`}
              onClick={() => setT({ ...t, answers: t.answers.filter((_, j) => j !== i) })}
            >
              <X size={13} aria-hidden />
              Remove
            </Button>
          ) : (
            <span className="hidden sm:block" />
          )}
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {t.answers.length < CHOICE_MAX && spare && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() =>
              setT({
                ...t,
                answers: [
                  ...t.answers,
                  {
                    slot: `new${t.answers.length}`,
                    label: "",
                    intent_dim: spare.intent_dim,
                    source_dim: spare.source_dim,
                  },
                ],
              })
            }
          >
            <Plus size={12} aria-hidden />
            Add an answer
          </Button>
        )}
        <span className="text-xs text-fg-muted">
          {CHOICE_MIN} to {CHOICE_MAX} answers
        </span>
      </div>
      <p className="text-xs text-fg-muted">
        {on
          ? `Saving puts the new words live. Visitors see them within ${reachText(reachS)}.`
          : "Saving keeps your words. Visitors see them once you turn it on."}
      </p>
      {said && <p className={cn("text-[12.5px]", TONE.WARN_TEXT)}>{said}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => {
            const bad = checkEdit(t);
            if (bad) return setSaid(bad);
            setSaid(null);
            onSave({
              question: t.question.trim(),
              answers: t.answers.map((a) => ({ ...a, label: a.label.trim() })),
            });
          }}
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Cells({ r, open = false }: { r: AnswerRow; open?: boolean }) {
  const line = open ? "" : "border-b border-border";
  return (
    <>
      <td className={cn(line, "px-3 py-2.5 text-right font-mono text-[12.5px]")}>{num(r.chose)}</td>
      <td
        className={cn(line, "hidden px-3 py-2.5 text-right font-mono text-[12.5px] sm:table-cell")}
      >
        {num(r.clicked)}
      </td>
      <td
        className={cn(
          line,
          "py-2.5 pl-3 pr-4 text-right font-mono text-[12.5px]",
          r.best && "font-semibold",
        )}
      >
        {r.best && (
          <i
            aria-label="highest"
            className="mr-1.5 inline-block h-[5px] w-[5px] rounded-full bg-fg align-[2px]"
          />
        )}
        {pct(r.rate)}
      </td>
    </>
  );
}

function AnswerTable({
  rows,
  text,
  versions,
  onOpenVersion,
}: {
  rows: AnswerRow[];
  text: ChoiceText;
  versions: readonly ChoiceVersion[];
  onOpenVersion?: (intent: string, source: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="text-[11px] font-medium text-fg-faint">
          <th className="border-y border-border py-1.5 pl-4 pr-3 text-left font-medium">Answer</th>
          <th className="border-y border-border px-3 py-1.5 text-right font-medium">Chose</th>
          <th className="hidden border-y border-border px-3 py-1.5 text-right font-medium sm:table-cell">
            Clicked
          </th>
          <th className="border-y border-border py-1.5 pl-3 pr-4 text-right font-medium">
            Click rate
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const a = r.slot ? text.answers.find((x) => x.slot === r.slot) : undefined;
          const isOpen = a !== undefined && open === r.slot;
          const cells = <Cells r={r} open={isOpen} />;
          if (!a) {
            return (
              <tr key="none" className="text-fg-muted [&:last-child>td]:border-b-0">
                <td className="border-b border-border py-2.5 pl-4 pr-3">{r.label}</td>
                {cells}
              </tr>
            );
          }
          return (
            <Fragment key={a.slot}>
              <tr>
                <td className={cn("p-0", isOpen ? "border-b-0" : "border-b border-border")}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : a.slot)}
                    className="flex w-full items-center gap-2 py-2.5 pl-4 pr-3 text-left font-medium hover:bg-surface-muted/60"
                  >
                    {a.label}
                    <ChevronDown
                      size={14}
                      aria-hidden
                      className={cn(
                        "text-fg-faint transition-transform duration-medium ease-smooth",
                        isOpen && "rotate-180",
                      )}
                    />
                  </button>
                </td>
                {cells}
              </tr>
              {isOpen ? (
                <tr>
                  <td colSpan={4} className="border-b border-border px-4 pb-3.5">
                    <p className="text-[12.5px] text-fg-muted">
                      Shows:{" "}
                      {headlineOf(versions, a.intent_dim, a.source_dim) || "a version of your page"}
                    </p>
                    {onOpenVersion && (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="mt-2"
                        onClick={() => onOpenVersion(a.intent_dim, a.source_dim)}
                      >
                        See this version beside your page
                      </Button>
                    )}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function Notice() {
  const [copied, setCopied] = useState(false);
  return (
    <How summary="Text for your privacy notice" className="mt-0 border-t border-border px-4 py-2.5">
      <p>{CHOICE_NOTICE}</p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="mt-1.5 self-start"
        onClick={() =>
          void navigator.clipboard?.writeText(CHOICE_NOTICE).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          })
        }
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </How>
  );
}

function Never() {
  return (
    <How summary="What we never ask" className="mt-0 border-t border-border px-4 py-2.5">
      {CHOICE_LINES.never.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </How>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface ChoiceCardProps {
  customerId: string;
  state: ChoiceState;
  onState: (s: ChoiceState) => void;
  onOpenVersion?: (intent: string, source: string) => void;
  testHref: string;
  /** For the fixtures and tests: open in the editor. */
  startEditing?: boolean;
}

export function ChoiceCard({
  customerId,
  state,
  onState,
  onOpenVersion,
  testHref,
  startEditing = false,
}: ChoiceCardProps) {
  const [editing, setEditing] = useState<ChoiceText | null>(
    startEditing ? (state.live ?? null) : null,
  );
  const [busy, setBusy] = useState<"switch" | "save" | "write" | "draft" | "preview" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const { live, draft, counts } = state;
  const blocked = state.killed || !state.allowed;

  async function run(
    kind: NonNullable<typeof busy>,
    call: () => ReturnType<typeof saveChoice>,
    ok?: (s: ChoiceState, written?: string) => string | null,
  ) {
    setBusy(kind);
    setSaid(null);
    const out = await call();
    setBusy(null);
    if (out.kind === "failed") return setSaid(out.message);
    onState(out.value);
    setSaid(ok ? ok(out.value, out.written) : null);
    return out.value;
  }

  const flip = (on: boolean) =>
    void run(
      "switch",
      () => saveChoice(customerId, { path: state.path, on }),
      (s) =>
        s.on
          ? `On. Visitors see it within ${reachText(s.reachS)}.`
          : `Off. Visitors stop seeing it within ${reachText(s.reachS)}.`,
    );

  const suggest = () =>
    void run(
      "write",
      () => writeChoice(customerId, undefined, state.path),
      (_, written) =>
        written === "draft"
          ? "A new question waits for your OK, above."
          : "Written from your brief.",
    );

  /** The question of another language home of the site. */
  async function showHome(home: string) {
    if (home === state.path) return;
    setEditing(null);
    setPreview(null);
    await run("switch", () => getChoice(customerId, home));
  }

  async function openPreview() {
    // Opened at the click, so the browser does not block it; the address follows.
    const w = typeof window !== "undefined" ? window.open("", "_blank") : null;
    setBusy("preview");
    setSaid(null);
    const out = await previewLink(customerId, undefined, state.path);
    setBusy(null);
    if (out.kind === "failed") {
      w?.close();
      return setSaid(out.message);
    }
    setPreview(out.value.link);
    if (w) {
      w.opener = null;
      w.location.href = out.value.link;
    }
  }

  const head = (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5">
      <h3 id="vc-title" className="text-[13.5px] font-semibold">
        {CHOICE_LINES.title}
      </h3>
      <span className="row-span-2 flex items-center gap-2.5 text-[12.5px] text-fg-muted">
        <span id="vc-sw">{state.on && !state.killed ? "On" : "Off"}</span>
        <Switch
          on={state.on && !state.killed}
          labelledBy="vc-sw"
          disabled={blocked || !live || busy !== null}
          onChange={flip}
        />
      </span>
      <p className="text-[12.5px] text-fg-muted">{CHOICE_LINES.sub}</p>
      {state.homes.length > 1 && (
        <fieldset className="col-span-2 m-0 mt-1.5 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
          <legend className="sr-only">Language</legend>
          {state.homes.map((h) => (
            <button
              key={h.path}
              type="button"
              aria-pressed={h.path === state.path}
              disabled={busy !== null}
              onClick={() => void showHome(h.path)}
              className={cn(
                "rounded-sm border px-2.5 py-1 font-mono text-[11.5px]",
                h.path === state.path
                  ? "border-fg bg-surface-muted text-fg"
                  : "border-border text-fg-muted hover:bg-surface-muted/60",
              )}
            >
              {h.lang.toUpperCase()} {h.path}
              {!h.hasQuestion && " · no question yet"}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );

  const box = (children: React.ReactNode, tone: "muted" | "warn" = "muted") => (
    <div
      className={cn(
        "mx-4 mb-3.5 flex flex-wrap items-center justify-between gap-3 rounded-sm px-3.5 py-3 text-[13px]",
        tone === "warn"
          ? cn(TONE.WARN_TINT, TONE.WARN_TEXT)
          : "border border-border bg-surface-muted text-[#3f3f46]",
      )}
    >
      {children}
    </div>
  );

  const message = said && (
    <p
      aria-live="polite"
      className="border-t border-border px-4 py-2.5 text-[12.5px] text-fg-muted"
    >
      {said}
    </p>
  );

  if (state.killed || !state.allowed) {
    return (
      <div className="mt-4 rounded-md border border-border bg-surface" data-choice="blocked">
        {head}
        {box(<span>{state.killed ? CHOICE_LINES.killed : CHOICE_LINES.notHere}</span>)}
        <Never />
      </div>
    );
  }

  if (!live) {
    return (
      <div className="mt-4 rounded-md border border-border bg-surface" data-choice="none">
        {head}
        {!state.hasAnchor
          ? box(<span>{CHOICE_LINES.noAnchor}</span>, "warn")
          : box(
              <>
                <span className="max-w-[46ch]">{CHOICE_LINES.none}</span>
                <Button type="button" size="sm" disabled={busy !== null} onClick={suggest}>
                  {busy === "write" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                  {CHOICE_LINES.write}
                </Button>
              </>,
            )}
        {message}
        <Never />
      </div>
    );
  }

  const numbers = state.on || counts.shown > 0;
  const rows = answerRows(live, counts);
  const skipped = skippedLine(counts);
  const returned = returnedLine(counts);

  return (
    <div className="mt-4 rounded-md border border-border bg-surface" data-choice="live">
      {head}
      {!state.on &&
        counts.shown === 0 &&
        !editing &&
        box(
          <>
            <span>{CHOICE_LINES.firstBox}</span>
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => flip(true)}>
              Turn on
            </Button>
          </>,
        )}
      {draft &&
        !editing &&
        box(
          <div className="flex w-full flex-col gap-2">
            <span>{CHOICE_LINES.draft}</span>
            <span className="font-medium text-fg">{draft.question}</span>
            <span className="text-[12.5px]">{draft.answers.map((a) => a.label).join(" · ")}</span>
            <span className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "draft",
                    () => saveChoice(customerId, { path: state.path, approve_draft: true }),
                    () => "Approved. It is the question now.",
                  )
                }
              >
                {busy === "draft" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                Approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "draft",
                    () => saveChoice(customerId, { path: state.path, discard_draft: true }),
                    () => "Discarded.",
                  )
                }
              >
                Discard
              </Button>
            </span>
          </div>,
          "warn",
        )}

      {editing ? (
        <Editor
          start={editing}
          versions={state.versions}
          on={state.on}
          reachS={state.reachS}
          busy={busy === "save"}
          onCancel={() => setEditing(null)}
          onSave={(t) =>
            void run(
              "save",
              () =>
                saveChoice(customerId, {
                  path: state.path,
                  question: t.question,
                  answers: t.answers.map(({ label, intent_dim, source_dim }) => ({
                    label,
                    intent_dim,
                    source_dim,
                  })),
                }),
              () => "Saved.",
            ).then((s) => s && setEditing(null))
          }
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <div>
              <p className="text-xs text-fg-muted">Question</p>
              <p className="mt-px text-sm font-medium">{live.question}</p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(live)}>
              <PenLine size={12} aria-hidden />
              Edit
            </Button>
          </div>
          {numbers ? (
            <>
              <AnswerTable
                rows={rows}
                text={live}
                versions={state.versions}
                onOpenVersion={onOpenVersion}
              />
              <p className="border-t border-border px-4 py-2.5 text-xs text-fg-muted">
                People who answer are keener to begin with, so compare answers with each other.{" "}
                <Link
                  href={testHref}
                  className="text-fg underline decoration-dotted underline-offset-[3px]"
                >
                  Test
                </Link>{" "}
                shows what asking adds.
              </p>
              {returned && (
                <p className="border-t border-border px-4 py-2.5 text-xs text-fg-muted">
                  {returned}
                </p>
              )}
              {skipped && (
                <p className="border-t border-border px-4 py-2.5 text-xs text-fg-muted">
                  {skipped}
                </p>
              )}
            </>
          ) : (
            <ul className="m-0 list-none p-0">
              {live.answers.map((a) => (
                <li
                  key={a.slot}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-border px-4 py-2.5"
                >
                  <span className="text-[13.5px] font-medium">{a.label}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="row-span-2 self-center"
                    onClick={() => setEditing(live)}
                  >
                    <PenLine size={12} aria-hidden />
                    Edit
                  </Button>
                  <span className="text-[12.5px] text-fg-muted">
                    Shows:{" "}
                    {headlineOf(state.versions, a.intent_dim, a.source_dim) ||
                      "a version of your page"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="border-t border-border bg-surface-muted px-4 pb-4 pt-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-fg-muted">
          <span>On your page, at the bottom of the screen, in your fonts and colours</span>
          {preview ? (
            <a
              href={preview}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-fg underline decoration-dotted underline-offset-[3px]"
            >
              {CHOICE_LINES.previewOpen}
              <ExternalLink size={12} aria-hidden />
            </a>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void openPreview()}
              className="inline-flex items-center gap-1 text-fg underline decoration-dotted underline-offset-[3px] disabled:opacity-50"
            >
              {busy === "preview" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              {CHOICE_LINES.previewOpen}
              <ExternalLink size={12} aria-hidden />
            </button>
          )}
        </div>
        <div
          aria-hidden
          className="mt-2.5 flex flex-wrap items-center gap-1.5 rounded-sm border border-border bg-surface px-4 py-3.5 text-[13px] text-fg-muted"
        >
          <span className="mr-1">{live.question}</span>
          {live.answers.map((a) => (
            <span
              key={a.slot}
              className="rounded-[3px] border border-border-strong px-2.5 py-1 text-fg"
            >
              {a.label}
            </span>
          ))}
        </div>
        {preview && <p className="mt-2 text-xs text-fg-muted">{CHOICE_LINES.previewNote}</p>}
      </div>

      {!editing && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {live.answers.length < CHOICE_MAX && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  const used = new Set(live.answers.map((a) => `${a.intent_dim}:${a.source_dim}`));
                  const v =
                    state.versions.find((x) => !used.has(`${x.intent_dim}:${x.source_dim}`)) ??
                    state.versions[0];
                  setEditing({
                    ...live,
                    answers: [
                      ...live.answers,
                      {
                        slot: `new${live.answers.length}`,
                        label: "",
                        intent_dim: v?.intent_dim ?? "",
                        source_dim: v?.source_dim ?? "",
                      },
                    ],
                  });
                }}
              >
                <Plus size={12} aria-hidden />
                Add an answer
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={suggest}
            >
              {busy === "write" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              {CHOICE_LINES.suggest}
            </Button>
          </div>
          <span className="text-xs text-fg-muted">
            {numbers ? `Last ${counts.days} days · ` : ""}
            {CHOICE_MIN} to {CHOICE_MAX} answers
          </span>
        </div>
      )}
      {message}
      <Notice />
      <Never />
    </div>
  );
}
