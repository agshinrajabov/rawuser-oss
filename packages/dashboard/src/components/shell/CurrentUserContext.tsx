"use client";

import { ENROL_PATH } from "@/lib/api";
import { type SessionUser, getCurrentSession } from "@/lib/auth";
import { useRouter } from "next/navigation";
import * as React from "react";

/**
 * Provides the currently-logged-in SessionUser to the shell.
 *
 * V2 M3 Batch C P1: the shell uses `user.role` to switch between the
 * operator (superadmin) layout and the customer-scoped layout. Without
 * this context every navigation/topbar component would have to call
 * getCurrentUser() and manage its own loading state.
 *
 * The user is fetched once on mount and cached in memory by lib/auth.ts.
 */

interface CurrentUserContextValue {
  user: SessionUser | null;
  loading: boolean;
}

export const CurrentUserContext = React.createContext<CurrentUserContextValue>({
  user: null,
  loading: true,
});

export function CurrentUserProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    getCurrentSession()
      .then((s) => {
        if (cancelled) return;
        // A session that may only set up two-step sign-in has one page.
        if (s?.enrolOnly) {
          router.replace(ENROL_PATH);
          return;
        }
        setUser(s?.user ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <CurrentUserContext.Provider value={{ user, loading }}>{children}</CurrentUserContext.Provider>
  );
}

export function useCurrentUser() {
  return React.useContext(CurrentUserContext);
}
