/**
 * The sign-in family's look, in the dashboard v2 system (2026-11-02): the
 * wordmark over one card, an 18 px title, sentence-case labels, 32 px
 * fields, the black square-cornered button. Error lines stay grey (two-step
 * mock §11, call 3). Shared by the password step, the second step and the
 * required set-up at /login/two-step (mock §11, call 9).
 */

import { Brand } from "@/components/shell/Brand";
import { cn } from "@/lib/utils";
import Link from "next/link";
import * as React from "react";

export function SignInFrame({
  children,
  align = "center",
}: {
  children: React.ReactNode;
  /** The codes step is taller than a phone: it starts at the top. */
  align?: "center" | "top";
}) {
  return (
    <div
      className={cn(
        "flex min-h-dvh justify-center bg-bg px-5 py-8 sm:px-4",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      <div className="w-full max-w-[400px]">
        <div className="mb-5">
          <Link href="/" className="text-[13px] font-semibold leading-none tracking-tight text-fg">
            <Brand />
          </Link>
        </div>
        <div className="rounded-md border border-border bg-surface px-5 py-6 sm:px-6">
          {children}
        </div>
      </div>
    </div>
  );
}

export const SignInTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h1
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-snug tracking-[-0.005em] text-fg [text-wrap:balance] focus:outline-none",
      className,
    )}
    {...props}
  />
));
SignInTitle.displayName = "SignInTitle";

export function SignInSub({
  children,
  className,
}: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={cn("mt-1 text-[13px] leading-normal text-fg-muted [text-wrap:pretty]", className)}
    >
      {children}
    </p>
  );
}

export function SignInLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12.5px] font-medium text-fg">
      {children}
    </label>
  );
}

/** The field: the login page's border, dark on focus, muted when off. */
export const signInInput = cn(
  "block w-full h-9 rounded-sm border border-border-strong bg-surface px-3",
  "text-[13.5px] text-fg placeholder:text-fg-faint outline-none",
  "transition-colors duration-150 ease-smooth focus:border-fg",
  "disabled:bg-surface-muted disabled:text-fg-faint disabled:cursor-not-allowed",
);

/** Six digits, mono and spaced. */
export const signInCode = "font-mono text-[19px] tracking-[0.3em] tabular-nums";
/** XXXX-XXXX-XXXX-XXXX. */
export const signInRecovery = "font-mono text-base tracking-[0.06em]";

/** The grey line under the fields (call 3: the sign-in errors stay grey). */
export function SignInError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="mt-3 animate-fade-in text-[13px] leading-normal text-fg-muted"
    >
      {children}
    </p>
  );
}

export const SignInButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "submit", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "mt-5 block h-9 w-full rounded-sm bg-cta-bg px-4 text-center text-[13.5px] font-medium text-cta-fg",
      "transition-opacity duration-150 ease-smooth hover:opacity-90",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
      "disabled:cursor-not-allowed disabled:opacity-40",
      className,
    )}
    {...props}
  />
));
SignInButton.displayName = "SignInButton";

/** A dotted-underline text button, for "Use a recovery code instead" and the foot. */
export function SignInLinkButton({
  onClick,
  children,
  muted = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "underline decoration-dotted underline-offset-[3px] rounded-sm",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
        muted ? "text-fg-muted hover:text-fg" : "text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function SignInAlt({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-[13px]">{children}</p>;
}

export function SignInFoot({ children }: { children: React.ReactNode }) {
  return <p className="mt-5 text-xs text-fg-faint">{children}</p>;
}
