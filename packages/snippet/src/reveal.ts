/**
 * Remove the anti-flicker hide style, revealing all [data-rawuser] elements.
 *
 * Idempotent: safe to call multiple times. The style element is only removed
 * once — if it has already been detached from the DOM, this is a no-op.
 *
 * @param hideStyle The style element returned by injectHideStyle(), or null
 *                  if injection was skipped (defensive call-site pattern).
 */
export function revealAll(hideStyle: HTMLStyleElement | null): void {
  hideStyle?.remove();
}
