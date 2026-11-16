"use client";

/**
 * ConversionsList, V2 Module 3.
 *
 * Per-customer table of active + disabled conversion targets.
 * - Checkbox toggles enabled (PATCH via upsert)
 * - Label inline-editable (commit on Enter or blur; cancel on Escape)
 * - Section path display-only (changing the path is a delete-and-add flow)
 * - Conversion label dropdown
 * - Delete with confirm button
 */

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CONVERSION_LABELS,
  CONVERSION_LABEL_DESCRIPTIONS,
  type ConversionLabel,
  type ConversionTarget,
} from "@/types/api";
import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { elementCell } from "./humanize";

/**
 * The target's own selectors, so an edit never swaps a picked button's or a
 * go-live union target's selectors for the homepage manifest's (the upsert
 * reads the manifest only when none are sent).
 */
function ownSelectors(item: ConversionTarget) {
  return item.css_selectors.length > 0 && item.structural_selector !== ""
    ? {
        css_selectors: item.css_selectors,
        text_selectors: item.text_selectors,
        structural_selector: item.structural_selector,
      }
    : {};
}

interface ConversionsListProps {
  customerId: string;
  items: ConversionTarget[];
  onMutated: () => void;
  /**
   * When true, the table renders without any editing affordances:
   * checkbox is disabled, label is plain text (no inline edit), event
   * dropdown is disabled, delete column is hidden. Used for the
   * `role='customer'` viewer who should only inspect conversion
   * targets, not change them.
   */
  readOnly?: boolean;
}

export function ConversionsList({
  customerId,
  items,
  onMutated,
  readOnly = false,
}: ConversionsListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  async function commitLabel(item: ConversionTarget) {
    const value = draftLabel.trim();
    setEditingId(null);
    if (value === "" || value === item.label) return;
    setBusyId(item.id);
    setError(null);
    try {
      await apiFetch("/admin/conversions/upsert", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customerId,
          id: item.id,
          section_path: item.section_path,
          label: value,
          conversion_label: item.conversion_label,
          enabled: item.enabled,
          ...ownSelectors(item),
        }),
      });
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(item: ConversionTarget) {
    setBusyId(item.id);
    setError(null);
    try {
      await apiFetch("/admin/conversions/upsert", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customerId,
          id: item.id,
          section_path: item.section_path,
          label: item.label,
          conversion_label: item.conversion_label,
          enabled: !item.enabled,
          ...ownSelectors(item),
        }),
      });
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusyId(null);
    }
  }

  async function changeEvent(item: ConversionTarget, next: ConversionLabel) {
    if (next === item.conversion_label) return;
    setBusyId(item.id);
    setError(null);
    try {
      await apiFetch("/admin/conversions/upsert", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customerId,
          id: item.id,
          section_path: item.section_path,
          label: item.label,
          conversion_label: next,
          enabled: item.enabled,
          ...ownSelectors(item),
        }),
      });
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(item: ConversionTarget) {
    setBusyId(item.id);
    setError(null);
    try {
      await apiFetch("/admin/conversions/delete", {
        method: "POST",
        body: JSON.stringify({ id: item.id }),
      });
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No conversion targets yet for this customer. Add one below, or detect them from the
        customer&apos;s site in Connect page.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[44px]" />
            <TableHead>Label</TableHead>
            <TableHead className="w-[200px]">Element</TableHead>
            <TableHead className="w-[160px]">Counts as</TableHead>
            {!readOnly && <TableHead className="w-[60px]" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const editing = editingId === item.id;
            const busy = busyId === item.id;
            const cell = elementCell(item);
            return (
              <TableRow key={item.id}>
                <TableCell>
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={() => toggleEnabled(item)}
                    disabled={busy || readOnly}
                    aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.label}`}
                    className="h-4 w-4"
                  />
                </TableCell>
                <TableCell>
                  {!readOnly && editing ? (
                    <Input
                      ref={inputRef}
                      value={draftLabel}
                      onChange={(e) => setDraftLabel(e.target.value)}
                      onBlur={() => commitLabel(item)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitLabel(item);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="h-input-sm text-sm"
                    />
                  ) : readOnly ? (
                    <span
                      className={cn(
                        "text-sm text-fg px-2 py-1 block",
                        item.enabled ? "" : "opacity-50",
                      )}
                    >
                      {item.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      title="Click to edit"
                      onClick={() => {
                        setDraftLabel(item.label);
                        setEditingId(item.id);
                      }}
                      className={cn(
                        "text-sm text-fg text-left px-2 py-1 rounded-sm",
                        "hover:bg-surface-muted transition-colors duration-fast block w-full",
                        item.enabled ? "" : "opacity-50",
                      )}
                    >
                      {item.label}
                    </button>
                  )}
                </TableCell>
                <TableCell>
                  <span
                    className={cn("block min-w-0", item.enabled ? "" : "opacity-50")}
                    title={item.section_path}
                  >
                    <span className="block truncate text-sm text-fg">{cell.name}</span>
                    {cell.detail && (
                      <span
                        className="mt-0.5 block truncate font-mono text-[0.6875rem] leading-tight text-fg-muted"
                        data-detail="selector"
                      >
                        {cell.detail}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  {readOnly ? (
                    <span
                      className={cn(
                        "text-xs font-mono text-fg-muted block px-2 py-1",
                        item.enabled ? "" : "opacity-50",
                      )}
                    >
                      {item.conversion_label}
                    </span>
                  ) : (
                    <select
                      value={item.conversion_label}
                      onChange={(e) => changeEvent(item, e.target.value as ConversionLabel)}
                      disabled={busy || !item.enabled}
                      title={
                        CONVERSION_LABEL_DESCRIPTIONS[item.conversion_label as ConversionLabel]
                      }
                      className={cn(
                        "h-input-sm w-full rounded-sm border border-border bg-surface",
                        "px-2 text-xs font-mono text-fg",
                        "focus:outline-none focus:ring-1 focus:ring-fg",
                      )}
                    >
                      {CONVERSION_LABELS.map((label) => (
                        <option
                          key={label}
                          value={label}
                          title={CONVERSION_LABEL_DESCRIPTIONS[label]}
                        >
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                  {!readOnly && (
                    <span className="mt-1 block text-[0.6875rem] leading-tight text-fg-muted">
                      {CONVERSION_LABEL_DESCRIPTIONS[item.conversion_label as ConversionLabel]}
                    </span>
                  )}
                </TableCell>
                {!readOnly && (
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => remove(item)}
                      disabled={busy}
                      title="Delete"
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {error && <p className="text-state-err text-sm">{error}</p>}
    </div>
  );
}
