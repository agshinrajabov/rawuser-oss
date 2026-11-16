/**
 * The old visitor-choice row's first-paint reserve (docs/specs/direct-visitors.md
 * §2, until 2026-11-04): the style `#__rawuser-q` that a customer's script
 * added before the boot. The bar that replaced the row reserves nothing; a
 * script cached from before (a day at most) may still add it, so every way
 * out still removes it.
 */
export const RESERVE_ID = "__rawuser-q";

export const dropReserve = (): void => document.getElementById(RESERVE_ID)?.remove();
