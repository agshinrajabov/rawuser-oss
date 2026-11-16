"use client";

import { hashToken } from "@/lib/audit";
import { useEffect, useState } from "react";

/**
 * One address, two pages: with a `#t=` token the public page, without it the
 * signed-in one. Decided after mount (the static export cannot see the
 * fragment), before the child reads and drops the token.
 */
export function useFragmentMode(): "public" | "signed" | null {
  const [mode, setMode] = useState<"public" | "signed" | null>(null);
  useEffect(() => {
    setMode(hashToken(window.location.hash) ? "public" : "signed");
  }, []);
  return mode;
}
