/**
 * Light state tints for the first-run screens. The state tokens are CSS
 * variables, so Tailwind's opacity modifier (`bg-state-warn/10`) produces no
 * CSS; the tint is a color-mix of the token instead, as Badge.tsx does. The
 * text is the same token mixed with black so it passes WCAG AA on its tint
 * (success 5.19:1, warn 5.06:1, err 5.16:1 over the #fafafa page ground).
 */
export const TINT = {
  ok: "bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] text-[color:color-mix(in_srgb,var(--state-success)_70%,black)]",
  warn: "bg-[color-mix(in_srgb,var(--state-warn)_10%,transparent)] text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]",
  err: "bg-[color-mix(in_srgb,var(--state-err)_10%,transparent)] text-[color:color-mix(in_srgb,var(--state-err)_85%,black)]",
} as const;

/** A faint warn wash behind a block that holds ordinary text. */
export const WARN_WASH = "bg-[color-mix(in_srgb,var(--state-warn)_5%,transparent)]";
