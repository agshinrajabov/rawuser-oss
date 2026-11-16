/**
 * Apply once the page is ready for it: its fonts, the rich writers when the
 * page needs them, and on a client-side navigation the route's elements.
 * Moved out of index.ts on 2026-09-30 so the waits can be tested; the
 * behaviour is the one index.ts had, plus the rich wait.
 */

import { applyVariant } from "./apply.ts";
import type { SelectResponse } from "./types.ts";

/**
 * Fitted in the page's own fonts: the lengths are measured, and a fallback
 * font chose wrong on a pilot site (2026-09-30). Half a second at most; a
 * later font gets a second fit (apply.ts keepFitted).
 */
export const FONT_WAIT_MS = 500;
/** Retry window for applying to a route whose elements are still rendering. */
export const APPLY_RETRY_MS = 100;
export const APPLY_RETRY_MAX = 30;

/** Resolves once the frame that is due has been rendered (at once where there are no frames). */
const painted = () =>
  new Promise((r) => {
    try {
      requestAnimationFrame(() => setTimeout(r));
    } catch {
      r(0);
    }
  });

/**
 * The page's fonts, or half a second: what a fit waits for before it measures.
 *
 * When the fonts were still on their way, the frame that swaps them in is
 * rendered first, the parts still hidden, and only then do we write (A11).
 * The promise resolves before that frame, so the write used to land in it:
 * the page's own font shift and anything of ours were then one layout-shift
 * entry, and `swap_shift` reported the page's (the pilot's site at 390, 0.0165 on
 * 3 of 3 cold loads; 15 of 16 on a local page built to do the same). One
 * frame more behind the hide on such a load, inside the same half second.
 */
export function fontsReady(): Promise<unknown> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  return Promise.race([
    fonts?.status === "loading" ? fonts.ready.then(painted) : fonts?.ready,
    new Promise((r) => setTimeout(r, FONT_WAIT_MS)),
  ]);
}

/**
 * Resolves with whether the variant was applied. `rich` settles when the
 * rich writers are in or the reveal cap is reached (rich-loader.ts); it runs
 * alongside the fonts wait, so a page that needs both waits for the longer
 * of the two, never their sum. `late` is asked just before every write: once
 * it says the cap revealed the page, or the tab left the pass's path
 * (quiet-swap.md 2b), nothing is written and this resolves false (Late
 * answers, docs/specs/quiet-swap.md). `first` runs in the same
 * task as the write, just before it (the tab's carried copy put back when
 * the edge serves another, so no script of the page reads the page's own
 * words in between).
 */
export function applyWhenReady(
  response: SelectResponse,
  spa: boolean,
  rich: Promise<unknown> = Promise.resolve(),
  late: () => boolean = () => false,
  first?: () => void,
  /** The fonts wait, when the caller started it earlier (core.ts, the parse wait). */
  fonts?: Promise<unknown>,
): Promise<boolean> {
  const variant = response.variant;
  if (!variant) return Promise.resolve(false);
  if (!spa)
    return Promise.all([fonts ?? fontsReady(), rich]).then(() => {
      if (late()) return false;
      first?.();
      return applyVariant(variant, response.targets);
    });
  // After a client-side navigation the router may still be rendering:
  // retry briefly.
  return rich.then(
    () =>
      new Promise<boolean>((resolve) => {
        let tries = 0;
        const attempt = () => {
          if (late()) return resolve(false);
          if (applyVariant(variant, response.targets)) return resolve(true);
          tries++;
          if (tries >= APPLY_RETRY_MAX) return resolve(false);
          setTimeout(attempt, APPLY_RETRY_MS);
        };
        attempt();
      }),
  );
}
