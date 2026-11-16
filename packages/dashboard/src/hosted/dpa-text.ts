/**
 * The data processing agreement as /audit/dpa/ shows it. It is the document
 * of whoever runs an install, so none ships with the code: write yours here
 * as blocks the page can set (a title, headings, numbered clauses, lists,
 * tables). Inline `**bold**` and `code` are kept. While a "[" placeholder is
 * left in the words the page says "Draft. Not yet in force."
 */

import type { DpaBlock } from "@/components/audit/legal-blocks";

export const DPA: DpaBlock[] = [
  { kind: "title", text: "Data processing agreement" },
  {
    kind: "p",
    text: "The operator of this install has not published a data processing agreement yet.",
  },
];
