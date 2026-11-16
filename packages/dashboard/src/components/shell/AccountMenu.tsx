"use client";

/**
 * The top bar's account label, now a small menu: Account and Sign out
 * (two-step mock §03, call 4). It used to sign out on one click.
 * Keyboard (mock §08): Enter, Space or Down opens on the first item; the
 * arrows move; Esc closes and returns to the label.
 */

import { cn } from "@/lib/utils";
import { ChevronDown, LogOut, User } from "lucide-react";
import Link from "next/link";
import * as React from "react";

const item = cn(
  "flex h-8 w-full items-center gap-2.5 rounded-[3px] px-2.5 text-left text-[13px] text-fg",
  "outline-none hover:bg-surface-muted focus-visible:bg-surface-muted",
);

export type AccountMenuViewProps = {
  label: string;
  email: string | null;
  open: boolean;
  onToggle: () => void;
  onKeyOpen: () => void;
  onSignOut: () => void;
  onItemKey: (e: React.KeyboardEvent) => void;
  onNavigate: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  menuRef?: React.Ref<HTMLDivElement>;
};

export function AccountMenuView({
  label,
  email,
  open,
  onToggle,
  onKeyOpen,
  onSignOut,
  onItemKey,
  onNavigate,
  buttonRef,
  menuRef,
}: AccountMenuViewProps) {
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        id="account-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "account-menu" : undefined}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            onKeyOpen();
          }
        }}
        className={cn(
          "inline-flex h-input-sm items-center gap-1.5 rounded-sm px-2 text-sm",
          "transition-colors duration-fast ease-smooth hover:bg-surface-muted hover:text-fg",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
          open ? "bg-surface-muted text-fg" : "text-fg-muted",
        )}
      >
        <span className="max-w-[96px] truncate sm:max-w-[260px]">{label}</span>
        <ChevronDown size={14} aria-hidden className="shrink-0" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id="account-menu"
          role="menu"
          aria-labelledby="account-menu-button"
          onKeyDown={onItemKey}
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[200px] rounded-md border border-border-strong bg-surface p-1"
        >
          {email && (
            <p className="mb-1 truncate border-b border-border px-2.5 pb-2 pt-1.5 text-xs text-fg-muted">
              {email}
            </p>
          )}
          <Link
            href="/settings?tab=account"
            role="menuitem"
            tabIndex={-1}
            className={item}
            onClick={onNavigate}
          >
            <User size={14} aria-hidden />
            Account
          </Link>
          <button type="button" role="menuitem" tabIndex={-1} className={item} onClick={onSignOut}>
            <LogOut size={14} aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function AccountMenu({
  label,
  email,
  onSignOut,
}: {
  label: string;
  email: string | null;
  onSignOut: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // First item on open.
  React.useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (t && !menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function close(focusButton: boolean) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  return (
    <AccountMenuView
      label={label}
      email={email}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onKeyOpen={() => setOpen(true)}
      onSignOut={() => {
        setOpen(false);
        onSignOut();
      }}
      onNavigate={() => setOpen(false)}
      onItemKey={(e) => {
        const list = items();
        const at = list.indexOf(document.activeElement as HTMLElement);
        if (e.key === "Escape") {
          e.preventDefault();
          close(true);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          list[(at + 1) % list.length]?.focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          list[(at - 1 + list.length) % list.length]?.focus();
        } else if (e.key === "Home") {
          e.preventDefault();
          list[0]?.focus();
        } else if (e.key === "End") {
          e.preventDefault();
          list[list.length - 1]?.focus();
        } else if (e.key === "Tab") {
          close(false);
        }
      }}
      buttonRef={buttonRef}
      menuRef={menuRef}
    />
  );
}
