"use client";

import { borrowToken, onLogoutElsewhere } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * Wraps protected pages. On first render, takes this tab's token or borrows
 * one from another open dashboard tab (lib/auth.ts, tab handoff); with
 * neither, redirects to /login. A logout in any tab sends every tab to /login.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    void borrowToken().then((token) => {
      if (!alive) return;
      if (token) setChecked(true);
      else router.replace("/login");
    });
    const off = onLogoutElsewhere(() => router.replace("/login"));
    return () => {
      alive = false;
      off();
    };
  }, [router]);

  if (!checked) {
    return (
      <div className="flex items-center justify-center min-h-dvh bg-bg">
        <div
          className="w-5 h-5 rounded-full border-2 border-border border-t-accent animate-spin"
          aria-label="Loading"
        />
      </div>
    );
  }

  return <>{children}</>;
}
