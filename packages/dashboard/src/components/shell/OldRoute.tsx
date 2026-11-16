"use client";

import { redirectFor } from "@/lib/routes";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { useCurrentUser } from "./CurrentUserContext";

/**
 * An old address (lib/routes.ts): a customer is sent to the new home with
 * the query kept; a superadmin keeps the old screen where it is an admin
 * tool. Renders nothing until the session is read, so a customer never sees
 * the old screen flash. Must sit inside AppShell (it reads the session).
 */
export function OldRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const to =
    loading || !user ? null : redirectFor(pathname, params.toString(), user.role === "superadmin");

  useEffect(() => {
    if (to) router.replace(to);
  }, [to, router]);

  if (loading || !user || to) return null;
  return <>{children}</>;
}
