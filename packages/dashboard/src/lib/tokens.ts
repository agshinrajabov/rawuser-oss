/**
 * Design token exports — typed constants for use in JS/TS contexts
 * where CSS variables can't reach (e.g. chart colors, canvas).
 *
 * Values mirror the CSS custom properties in globals.css exactly.
 * Source of truth: ADR 0011, packages/marketing/tailwind.config.ts.
 * NO electric mint. NO chromatic accent. Zero-accent system.
 */

export const tokens = {
  color: {
    bg: "#fafafa",
    surface: "#ffffff",
    surfaceMuted: "#f4f4f5",
    fg: "#0a0a0a",
    fgMuted: "#71717a",
    fgFaint: "#a1a1aa",
    border: "#e4e4e7",
    ctaBg: "#0a0a0a",
    ctaFg: "#fafafa",
  },
  motion: {
    fast: "150ms cubic-bezier(0.4, 0, 0.2, 1)",
    medium: "300ms cubic-bezier(0.4, 0, 0.2, 1)",
    delight: "500ms cubic-bezier(0.22, 1, 0.36, 1)",
  },
  radius: {
    sm: "8px",
    md: "12px",
    pill: "9999px",
  },
} as const;
