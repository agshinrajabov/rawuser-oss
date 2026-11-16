"use client";

import { ConnectQuestion, HeldBox } from "@/components/readiness/SpecialCategory";
import { useReadiness } from "@/components/readiness/useReadiness";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Separator } from "@/components/ui/Separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";
import { apiFetch } from "@/lib/api";
import { connectCategory } from "@/lib/readiness";
import { cn } from "@/lib/utils";
import type { ElementTargets, Manifest, ManifestResponse, SelectorHealth } from "@/types/api";
import { Check, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CaptureHelper } from "./CaptureHelper";
import { ConversionsReviewCard } from "./ConversionsReviewCard";
import { PagesList } from "./PagesList";
import { PickOnPage } from "./PickOnPage";
import { SnippetHandoff } from "./SnippetHandoff";

interface ManifestTableProps {
  manifest: Manifest;
  onCssChange: (dotPath: string, value: string) => void;
  /** Advisory per-selector validation from /detect (T1c). Absent on loaded manifests. */
  health?: SelectorHealth;
}

/**
 * Human-readable warning for a dot-path whose CSS selectors all failed
 * validation. Returns null when at least one selector matched exactly once
 * (healthy) or when there is no health data at all.
 */
function healthWarning(health: SelectorHealth | undefined, dotPath: string): string | null {
  const checks = health?.[dotPath];
  if (!checks || checks.length === 0) return null;
  if (checks.some((c) => c.status === "ok")) return null;
  if (checks.every((c) => c.status === "unsupported")) return null; // no verdict — stay quiet
  const none = checks.filter((c) => c.status === "none").length;
  const multiple = checks.filter((c) => c.status === "multiple").length;
  if (multiple > 0 && none === 0)
    return "These selectors match more than one element, so the swap would hit all of them. Edit them to something more specific.";
  if (none > 0 && multiple === 0)
    return "These selectors matched nothing on the page. They may be hallucinated, or the element renders only in the browser. Try a capture, or edit the selector.";
  return "No selector matched exactly one element. Review or edit before shipping.";
}

function ManifestTable({ manifest, onCssChange, health }: ManifestTableProps) {
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit(dotPath: string, currentValue: string) {
    setDraft(currentValue);
    setEditingPath(dotPath);
  }

  function commitEdit(dotPath: string) {
    onCssChange(dotPath, draft.trim());
    setEditingPath(null);
  }

  function handleKeyDown(e: React.KeyboardEvent, dotPath: string) {
    if (e.key === "Enter") commitEdit(dotPath);
    if (e.key === "Escape") setEditingPath(null);
  }

  useEffect(() => {
    if (editingPath !== null) {
      inputRef.current?.focus();
    }
  }, [editingPath]);

  const rows = Object.entries(manifest) as [string, ElementTargets][];

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[180px]">Element</TableHead>
          <TableHead className="w-[200px]">CSS</TableHead>
          <TableHead>Text</TableHead>
          <TableHead>Structural</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([dotPath, targets]) => {
          const cssFirst = targets.css[0] ?? "";
          const textFirst = targets.text[0] ?? "";
          const isEditing = editingPath === dotPath;
          const warning = healthWarning(health, dotPath);

          return (
            <TableRow key={dotPath}>
              <TableCell>
                <span className="font-mono text-sm text-fg inline-flex items-center gap-1.5">
                  {dotPath}
                  {warning && (
                    <span title={warning} className="inline-flex">
                      <TriangleAlert
                        className="h-3.5 w-3.5 shrink-0 text-state-warn"
                        aria-label={warning}
                      />
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell>
                {isEditing ? (
                  <Input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitEdit(dotPath)}
                    onKeyDown={(e) => handleKeyDown(e, dotPath)}
                    className="h-input-sm font-mono text-xs"
                  />
                ) : (
                  <button
                    type="button"
                    title="Click to edit"
                    onClick={() => startEdit(dotPath, cssFirst)}
                    className={cn(
                      "max-w-[180px] truncate font-mono text-xs text-fg text-left",
                      "px-2 py-1 rounded-sm hover:bg-surface-muted transition-colors duration-fast",
                      "block w-full",
                    )}
                  >
                    {cssFirst || <span className="text-fg-faint italic">-</span>}
                  </button>
                )}
              </TableCell>
              <TableCell>
                <span
                  className="font-mono text-xs text-fg-muted max-w-[180px] truncate block"
                  title={textFirst}
                >
                  {textFirst || <span className="text-fg-faint">-</span>}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className="font-mono text-xs text-fg-muted max-w-[180px] truncate block"
                  title={targets.structural}
                >
                  {targets.structural || <span className="text-fg-faint">-</span>}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function OnboardFlow() {
  const searchParams = useSearchParams();
  const customerId = searchParams.get("customer_id") ?? "";
  const { customers, refresh: refreshCustomers } = useCustomerList();
  const currentCustomer = customers.find((c) => c.id === customerId) ?? null;

  const [sourceUrl, setSourceUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);

  const [confirmEnabled, setConfirmEnabled] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [shipped, setShipped] = useState(false);

  const [section2Visible, setSection2Visible] = useState(false);
  // The special-category question before the tag (readiness-check mock,
  // section 03; privacy review condition 2): the same row as on Connect, and no
  // tag or capture link while it is withheld. An older worker gives no
  // answer and the screen is as it was.
  const readiness = useReadiness(customerId);
  const [asking, setAsking] = useState(false);
  const category = readiness.answer ? connectCategory(readiness.answer) : null;
  const withheld = readiness.answer?.tag_withheld === true;
  const held = withheld && category && "held" in category ? category.held : null;
  // True when the manifest shown was loaded (already confirmed + live), not
  // freshly detected — so we show it read-only with a Re-detect option instead
  // of a blank detect form (ADR 0024 / U1).
  const [preConfirmed, setPreConfirmed] = useState(false);
  // Bumped after a confirm so the Connected-pages list (R1c) refetches.
  const [pagesRefresh, setPagesRefresh] = useState(0);
  // On mount, load the customer's confirmed manifest so the operator sees what's
  // already live instead of an empty form. No manifest → stay on the blank form.
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    apiFetch<ManifestResponse>(
      `/admin/onboard/manifest?customer_id=${encodeURIComponent(customerId)}`,
    )
      .then((data) => {
        if (cancelled || data.status !== "confirmed") return;
        setSourceUrl(data.source_url);
        setPreConfirmed(true);
        setManifest(data);
        setSection2Visible(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  useEffect(() => {
    // Only run the fresh-detection reveal for a newly detected manifest — a
    // pre-confirmed (loaded) one is shown directly, no confirm timer.
    if (manifest !== null && !preConfirmed) {
      setSection2Visible(false);
      const raf = requestAnimationFrame(() => setSection2Visible(true));
      setConfirmEnabled(false);
      setShipped(false);
      setConfirmError(null);
      const t = setTimeout(() => setConfirmEnabled(true), 1500);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(t);
      };
    }
  }, [manifest, preConfirmed]);

  async function handleDetect() {
    if (!sourceUrl.trim() || !customerId) return;
    setError(null);
    setLoading(true);
    setManifest(null);
    setPreConfirmed(false);
    try {
      const data = await apiFetch<ManifestResponse>("/admin/onboard/detect", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId, source_url: sourceUrl }),
      });
      setManifest(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Detection failed. Check the URL and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    setConfirming(true);
    setConfirmError(null);
    try {
      await apiFetch<ManifestResponse>("/admin/onboard/confirm", {
        method: "POST",
        // Confirm the SAME path we detected (A1 per-path). Without page_path the
        // API defaults to '/', so a detected /start manifest would never be
        // confirmed — it would silently confirm '/' instead.
        body: JSON.stringify({ customer_id: customerId, page_path: manifest?.page_path ?? "/" }),
      });
      setShipped(true);
      setPagesRefresh((k) => k + 1);
      // has_confirmed_manifest feeds the Next-step banner; refresh so it moves on.
      refreshCustomers();
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : "Confirmation failed. Try again.");
    } finally {
      setConfirming(false);
    }
  }

  function handleRedetect() {
    setManifest(null);
    setSection2Visible(false);
    setError(null);
    setConfirmError(null);
    setShipped(false);
    setPreConfirmed(false);
  }

  // Operator picked a page from the Connected-pages list — load its URL into the
  // detect form (ready to re-detect) and clear any in-progress review. We don't
  // auto-detect: re-detection spends on the AI call, so the operator confirms it
  // by clicking Detect.
  function handleSelectPage(page: ManifestResponse) {
    setSourceUrl(page.source_url);
    handleRedetect();
  }

  function handleCssChange(dotPath: string, value: string) {
    if (!manifest) return;
    const entry = manifest.manifest[dotPath];
    if (!entry) return;
    const updated = {
      ...manifest,
      manifest: {
        ...manifest.manifest,
        [dotPath]: { ...entry, css: [value, ...entry.css.slice(1)] },
      },
    };
    setManifest(updated);
  }

  const isDetectDisabled = loading || !sourceUrl.trim() || !customerId;
  const elementCount = manifest ? Object.keys(manifest.manifest).length : 0;

  return (
    <div className="space-y-4">
      {category && (
        <ConnectQuestion
          customerId={customerId}
          category={category}
          asking={asking}
          onAsk={() => setAsking(true)}
          onAnswered={() => {
            setAsking(false);
            readiness.reload();
            refreshCustomers();
          }}
        />
      )}
      {currentCustomer !== null && !currentCustomer.live_at && (
        <Card className="p-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-fg">Guided setup</p>
            <p className="text-xs text-fg-muted">
              Tag, one look at the page, go live. The screens below are the manual tools.
            </p>
          </div>
          <Button asChild size="sm">
            <Link href={`/start?customer_id=${encodeURIComponent(customerId)}`}>Open</Link>
          </Button>
        </Card>
      )}
      {customerId && (
        <PagesList
          customerId={customerId}
          refreshKey={pagesRefresh}
          activePath={manifest?.page_path ?? null}
          onSelectPage={handleSelectPage}
        />
      )}

      <Card className="p-4">
        <p className="text-[0.9375rem] font-semibold text-fg mb-1">Add or re-detect a page</p>
        <p className="text-xs text-fg-muted mb-2">
          Enter the full URL of a page to personalize (e.g. your homepage, or a landing page like
          <span className="font-mono"> /start</span>). Rawuser detects its elements.
        </p>
        <Separator className="mb-3" />
        <div className="space-y-3">
          {!customerId && (
            <p className="text-sm text-fg-muted">Select a customer from the top bar to begin.</p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="source-url">URL</Label>
            <Input
              id="source-url"
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://example.com"
              required
              aria-required="true"
              disabled={!customerId}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isDetectDisabled) handleDetect();
              }}
            />
          </div>

          <Button type="button" onClick={handleDetect} disabled={isDetectDisabled}>
            {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
            {loading ? "Detecting…" : "Detect elements"}
          </Button>

          {error && <p className="text-state-err text-sm mt-2">{error}</p>}

          {customerId && sourceUrl.trim() !== "" && held && (
            <>
              <Separator className="my-3" />
              <HeldBox>{held}</HeldBox>
            </>
          )}
          {customerId && sourceUrl.trim() !== "" && !held && (
            <>
              <Separator className="my-3" />
              <CaptureHelper
                customerId={customerId}
                sourceUrl={sourceUrl}
                onCaptured={() => {
                  // A rendered-DOM capture landed — nudge the operator to
                  // re-run detection, which will prefer the capture.
                  setError(null);
                }}
              />
            </>
          )}
        </div>
      </Card>

      {manifest !== null && (
        <Card
          className={cn(
            "p-4 transition-opacity duration-medium ease-smooth",
            section2Visible ? "opacity-100" : "opacity-0",
          )}
        >
          <p className="text-[0.9375rem] font-semibold text-fg mb-2 flex items-center gap-2">
            {preConfirmed ? (
              <>
                <Check className="h-4 w-4 text-state-success" />
                Connected · {elementCount} element{elementCount !== 1 ? "s" : ""} live
              </>
            ) : (
              <>
                Review manifest ({elementCount} element{elementCount !== 1 ? "s" : ""} detected, $
                {manifest.cost_usd.toFixed(2)})
              </>
            )}
          </p>
          {preConfirmed && (
            <p className="text-xs text-fg-muted mb-2">
              These are the elements Rawuser personalizes on {manifest.source_url}. Re-detect if the
              page changed.
            </p>
          )}
          {!preConfirmed && manifest.html_source === "capture" && (
            <p className="text-xs text-fg-muted mb-2 flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-state-success" />
              Detected from your captured rendered page.
            </p>
          )}
          <Separator className="mb-3" />

          <ManifestTable
            manifest={manifest.manifest}
            onCssChange={handleCssChange}
            health={preConfirmed ? undefined : manifest.selector_health}
          />

          <div className="mt-3">
            <PickOnPage
              customerId={customerId}
              pagePath={manifest.page_path}
              onPicked={(picked) => {
                // The picked manifest is stored unconfirmed by the worker;
                // show it for review and ask for a fresh confirm.
                setManifest({
                  ...manifest,
                  manifest: picked,
                  confirmed_at: null,
                  status: "unconfirmed",
                });
                setPreConfirmed(false);
                setShipped(false);
              }}
            />
          </div>

          {confirmError && <p className="text-state-err text-sm mt-3">{confirmError}</p>}

          {shipped && !preConfirmed && (
            <p className="text-state-success text-sm mt-3 flex items-center gap-1.5">
              <Check className="h-4 w-4" />
              Shipped to visitors of {customerId}
            </p>
          )}

          {preConfirmed ? (
            <div className="mt-4">
              <Button type="button" variant="ghost" onClick={handleRedetect}>
                <RotateCcw className="h-4 w-4" />
                Re-detect
              </Button>
            </div>
          ) : !shipped ? (
            <div className="flex items-center gap-2 mt-4">
              <Button
                type="button"
                onClick={handleConfirm}
                disabled={!confirmEnabled || confirming}
              >
                {confirming && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm and ship
              </Button>
              <Button type="button" variant="ghost" onClick={handleRedetect}>
                <RotateCcw className="h-4 w-4" />
                Redetect
              </Button>
            </div>
          ) : (
            <div className="mt-3">
              <Button type="button" variant="ghost" onClick={handleRedetect}>
                <RotateCcw className="h-4 w-4" />
                Redetect
              </Button>
            </div>
          )}
        </Card>
      )}

      {shipped && manifest !== null && (
        <ConversionsReviewCard customerId={customerId} manifest={manifest.manifest} />
      )}

      {(shipped || preConfirmed) && currentCustomer !== null && (
        <SnippetHandoff
          customer={currentCustomer}
          pagePath={manifest?.page_path ?? "/"}
          held={held}
        />
      )}
    </div>
  );
}
