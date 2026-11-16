"use client";

/**
 * /setup?token=X — public password-claim flow for new customer users.
 *
 * V2 M3 Batch C P1. The customer arrives via a one-time setup_url the
 * operator forwards out-of-band. This page reads the ?token= from the
 * URL, asks for a password (twice), and POSTs to /admin/customer-users/setup.
 *
 * On success the server returns a session token, which we store in
 * sessionStorage under the same key the rest of the app uses and
 * go to the Overview (the first run while the site is not live).
 */

import {
  SignInButton,
  SignInError,
  SignInFoot,
  SignInFrame,
  SignInLabel,
  SignInSub,
  SignInTitle,
  signInInput,
} from "@/components/auth/SignIn";
import { ENROL_PATH } from "@/lib/api";
import { setSession } from "@/lib/auth";
import { type LoginAnswer, readLoginAnswer } from "@/lib/mfa";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

const API_ORIGIN = process.env.NEXT_PUBLIC_ADMIN_API_ORIGIN ?? "http://localhost:8787";

function SetupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const token = searchParams.get("token") ?? "";
  // Match the server's own minimum (8 chars) so we don't waste a roundtrip.
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;
  const disabled = loading || !token || password.length < 8 || password !== confirm;

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch(`${API_ORIGIN}/admin/customer-users/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      if (resp.ok) {
        // The setup link answers like a sign-in (security-hardening.md §1.3).
        const next = readLoginAnswer((await resp.json()) as LoginAnswer);
        if (next.kind === "done") {
          setSession({ token: next.token, user: next.user });
          router.replace("/");
        } else if (next.kind === "enrol") {
          setSession({ token: next.token, user: next.user, enrolOnly: true });
          router.replace(ENROL_PATH);
        } else if (next.kind === "second-step") {
          // Two-step is on: the password is set, sign in with it and a code.
          router.replace("/login");
        } else {
          setError("Something went wrong. Please try again.");
        }
      } else if (resp.status === 404) {
        // Generic 404 — link expired, consumed, or never existed.
        setError("This setup link is no longer valid. Ask your operator for a fresh invitation.");
      } else if (resp.status === 400) {
        setError("Please enter a password of at least 8 characters.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Couldn't reach the API. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  // Missing token case: a helpful message rather than a broken form.
  if (!token) {
    return (
      <p className="mt-4 text-[13px] leading-normal text-fg-muted">
        This setup link is missing its token. Open the link you were sent exactly as it is, or ask
        for a new one.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="mt-5 flex flex-col gap-3.5">
        <div>
          <SignInLabel htmlFor="password">New password</SignInLabel>
          <input
            id="password"
            ref={passwordRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            required
            minLength={8}
            disabled={loading}
            className={signInInput}
          />
        </div>
        <div>
          <SignInLabel htmlFor="confirm">Confirm password</SignInLabel>
          <input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type it again"
            autoComplete="new-password"
            required
            disabled={loading}
            className={signInInput}
          />
        </div>
      </div>

      {(tooShort || mismatch || error) && (
        <SignInError>
          {error ??
            (tooShort ? "Password must be at least 8 characters." : "Passwords don't match.")}
        </SignInError>
      )}

      <SignInButton disabled={disabled}>{loading ? "Setting up" : "Create account"}</SignInButton>
    </form>
  );
}

export default function SetupPage() {
  return (
    <SignInFrame>
      <SignInTitle>Set your password</SignInTitle>
      <SignInSub>One time only. After this you sign in at the regular sign-in page.</SignInSub>
      <Suspense fallback={null}>
        <SetupForm />
      </Suspense>
      <SignInFoot>Setup links expire after 7 days.</SignInFoot>
    </SignInFrame>
  );
}
