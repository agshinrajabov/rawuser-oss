"use client";

import { removeTarget } from "@/lib/measure";
import { mintSitePick, pollSitePick, undoNewPick } from "@/lib/site-pick";
import type { ConversionTarget } from "@/types/api";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The site pick's steps (mock site-wide-and-sensitive.html, A4 to A7), in
 * place of the row that began it: the entry row, or a site row's "Pick
 * again". The link, waiting for the pick, then the picked button with "Use
 * this button" and "Pick again". The worker stores the button at Done; the
 * list takes the new rows on "Use this button" (or when the screen closes).
 */

const POLL_MS = 3000;
/** The link lives 15 minutes (visual-picker.md section 9.1). */
const LINK_MS = 15 * 60 * 1000;
export const LINK_RAN_OUT = "The link ran out. Pick again.";

/** Where the step stands: the entry row, or the id of the row being picked again. */
export type PickSlot = "entry" | string;

export type SitePickPhase =
  | { kind: "link"; busy: boolean }
  | { kind: "waiting"; pagePath: string; since: number }
  | { kind: "picked"; target: ConversionTarget; items: ConversionTarget[] };

export interface SitePick {
  slot: PickSlot | null;
  phase: SitePickPhase | null;
  /** The API's sentence (a refusal) or a plain failure, under the step's row. */
  said: string | null;
  /** "Pick it on your page", or a row's "Pick again" (the row it replaces). */
  begin: (slot: PickSlot, replacing?: ConversionTarget | null) => void;
  open: () => void;
  cancel: () => void;
  /** "Use this button": the list takes the new rows. */
  use: () => void;
  /** "Pick again" on a picked button: a new row is taken off first. */
  again: () => void;
  /** The screen closes: a picked button is used, anything else is left. */
  settle: () => void;
}

export function useSitePick(
  customerId: string,
  items: ConversionTarget[] | null,
  onItems: (items: ConversionTarget[]) => void,
): SitePick {
  const [slot, setSlot] = useState<PickSlot | null>(null);
  const [phase, setPhase] = useState<SitePickPhase | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // The list when the step began, and the row a "Pick again" replaces.
  const before = useRef<ConversionTarget[] | null>(null);
  const replacing = useRef<ConversionTarget | null>(null);
  const live = useRef(true);
  const itemsRef = useRef(onItems);
  itemsRef.current = onItems;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const begin = useCallback(
    (s: PickSlot, r: ConversionTarget | null = null) => {
      before.current = items ? [...items] : null;
      replacing.current = r;
      setSaid(null);
      setSlot(s);
      setPhase({ kind: "link", busy: false });
    },
    [items],
  );

  const reset = useCallback(() => {
    setSlot(null);
    setPhase(null);
    replacing.current = null;
  }, []);

  const open = useCallback(() => {
    setSaid(null);
    setPhase({ kind: "link", busy: true });
    void mintSitePick(customerId).then((out) => {
      if (!live.current) return;
      if (out.kind !== "ok") {
        setSaid(out.kind === "refused" ? out.sentence : out.message);
        setPhase({ kind: "link", busy: false });
        return;
      }
      setPhase({ kind: "waiting", pagePath: out.value.pagePath, since: Date.now() });
      window.open(out.value.link, "_blank", "noopener");
    });
  }, [customerId]);

  useEffect(() => {
    if (phase?.kind !== "waiting") return;
    let cancelled = false;
    const t = setInterval(() => {
      if (Date.now() - phase.since > LINK_MS) {
        setSaid(LINK_RAN_OUT);
        setPhase({ kind: "link", busy: false });
        return;
      }
      void pollSitePick(customerId, phase.pagePath).then((out) => {
        if (cancelled || out.kind === "waiting") return;
        if (out.kind === "landed") {
          setPhase({ kind: "picked", target: out.target, items: out.items });
          return;
        }
        setSaid(out.kind === "refused" ? out.sentence : out.message);
        setPhase({ kind: "link", busy: false });
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [phase, customerId]);

  const use = useCallback(() => {
    if (phase?.kind !== "picked") return;
    const { target, items: next } = phase;
    const old = replacing.current;
    reset();
    // "Pick again" on a row that picked another button: the old row goes.
    if (old && old.id !== target.id) {
      void removeTarget(customerId, old).then((out) => {
        if (!live.current) return;
        if (out.kind === "ok") itemsRef.current(out.items);
        else {
          itemsRef.current(next);
          setSaid(out.kind === "refused" ? out.sentence : out.message);
        }
      });
      return;
    }
    itemsRef.current(next);
  }, [phase, customerId, reset]);

  const again = useCallback(() => {
    if (phase?.kind !== "picked") return;
    const target = phase.target;
    setSaid(null);
    setPhase({ kind: "link", busy: true });
    void undoNewPick(target, before.current).then((out) => {
      if (!live.current) return;
      if (out.kind !== "ok") setSaid(out.kind === "refused" ? out.sentence : out.message);
      setPhase({ kind: "link", busy: false });
    });
  }, [phase]);

  const cancel = useCallback(() => {
    setSaid(null);
    reset();
  }, [reset]);

  const settle = useCallback(() => {
    if (phase?.kind === "picked") use();
  }, [phase, use]);

  return { slot, phase, said, begin, open, cancel, use, again, settle };
}
