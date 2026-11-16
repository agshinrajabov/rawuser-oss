/**
 * The rich module, `/rich.js` (2026-09-30): the writers for a headline built
 * word by word (template-write.ts) and for one the page cut into lines
 * (lines-write.ts). The core loads it only on the pages the customer script
 * lists in `window.__rw.x`, or when a /select answer needs it, and reaches
 * it through rich-api.ts. A static script: it carries no visitor data and
 * sends nothing.
 */

import { choice } from "./choice.ts";
import { linesSettled, writeLines } from "./lines-write.ts";
import type { RichWriters } from "./rich-api.ts";
import {
  keepRotationReserved,
  reserveRotationHeight,
  rotationHeights,
  writeTemplate,
} from "./template-write.ts";

const writers: RichWriters = {
  writeTemplate,
  rotationHeights,
  reserveRotationHeight,
  keepRotationReserved,
  writeLines: (el, text) => writeLines(el, text),
  linesSettled,
  choice,
};
(globalThis as { __rwx?: RichWriters }).__rwx = writers;
