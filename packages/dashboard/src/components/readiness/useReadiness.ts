"use client";

import { type ReadinessResponse, readReadiness } from "@/lib/readiness";
import { useCallback, useEffect, useState } from "react";

/**
 * GET /admin/onboard/readiness for one customer. `loading` until the first
 * answer; `missing` on an older worker (404), a wrong shape or any failure,
 * which every screen treats as "behave as before this change"; `ok` with
 * the answer. `reload` reads again after an answer to the question.
 */
export interface Readiness {
  state: "loading" | "missing" | "ok";
  answer: ReadinessResponse | null;
  reload: () => void;
}

export function useReadiness(customerId: string, dep?: unknown): Readiness {
  const [state, setState] = useState<Readiness["state"]>("loading");
  const [answer, setAnswer] = useState<ReadinessResponse | null>(null);
  const [key, setKey] = useState(0);
  const reload = useCallback(() => setKey((k) => k + 1), []);

  // key: the reload trigger; dep: a fresh quickstart result reads again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key and dep are refresh triggers
  useEffect(() => {
    if (!customerId) {
      setState("missing");
      setAnswer(null);
      return;
    }
    let cancelled = false;
    void readReadiness(customerId).then((out) => {
      if (cancelled) return;
      if (out.kind === "ok") {
        setAnswer(out.answer);
        setState("ok");
      } else {
        setAnswer(null);
        setState("missing");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [customerId, key, dep]);

  return { state, answer, reload };
}
