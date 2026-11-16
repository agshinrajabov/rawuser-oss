"use client";

import { SecondStep } from "@/components/auth/SecondStep";
import {
  SignInButton,
  SignInError,
  SignInFoot,
  SignInFrame,
  SignInLabel,
  SignInTitle,
  signInInput,
} from "@/components/auth/SignIn";
import { ENROL_PATH } from "@/lib/api";
import { setSession } from "@/lib/auth";
import { helpLine } from "@/lib/identity";
import { type LoginAnswer, homeFor, readLoginAnswer } from "@/lib/mfa";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const API_ORIGIN = process.env.NEXT_PUBLIC_ADMIN_API_ORIGIN ?? "http://localhost:8787";

export default function LoginPage() {
  const router = useRouter();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The second step's challenge, in memory only: a reload starts over.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [cameBack, setCameBack] = useState(false);

  const disabled = loading || !email.trim() || !password.trim();

  useEffect(() => {
    if (challenge) return;
    // Back from the second step: the email is filled, the password is next.
    if (cameBack) passwordRef.current?.focus();
    else emailRef.current?.focus();
  }, [challenge, cameBack]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;

    setLoading(true);
    setError(null);

    try {
      const resp = await fetch(`${API_ORIGIN}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (resp.ok) {
        const next = readLoginAnswer((await resp.json()) as LoginAnswer);
        if (next.kind === "second-step") {
          setChallenge(next.challenge);
          setPassword("");
        } else if (next.kind === "enrol") {
          // The role needs two-step sign-in and it is off: set it up first.
          setSession({ token: next.token, user: next.user, enrolOnly: true });
          router.replace(ENROL_PATH);
        } else if (next.kind === "done") {
          setSession({ token: next.token, user: next.user });
          // Superadmin lands on /customers, a customer on its Overview.
          router.replace(homeFor(next.user));
        } else {
          setError("Something went wrong. Please try again.");
        }
      } else if (resp.status === 401) {
        setError("Invalid email or password.");
      } else if (resp.status === 429) {
        // The server's own sentence: how long to wait.
        const data = (await resp.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Too many sign-in attempts. Wait a minute and try again.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Couldn't reach the API. Is the generation worker running?");
    } finally {
      setLoading(false);
    }
  }

  if (challenge) {
    return (
      <SignInFrame>
        <SecondStep
          email={email}
          challenge={challenge}
          onBack={() => {
            setChallenge(null);
            setCameBack(true);
            setError(null);
          }}
        />
      </SignInFrame>
    );
  }

  return (
    <SignInFrame>
      <SignInTitle>Sign in</SignInTitle>

      <form onSubmit={handleSubmit}>
        <div className="mt-5 flex flex-col gap-3.5">
          <div>
            <SignInLabel htmlFor="email">Email</SignInLabel>
            <input
              id="email"
              ref={emailRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
              disabled={loading}
              className={signInInput}
            />
          </div>

          <div>
            <SignInLabel htmlFor="password">Password</SignInLabel>
            <input
              id="password"
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              disabled={loading}
              className={signInInput}
            />
          </div>
        </div>

        {error && <SignInError>{error}</SignInError>}

        <SignInButton disabled={disabled}>{loading ? "Signing in…" : "Sign in"}</SignInButton>
      </form>

      <SignInFoot>{`Trouble signing in? ${helpLine()}`}</SignInFoot>
    </SignInFrame>
  );
}
