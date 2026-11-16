/**
 * The shapes the audit's legal pages are set from. The words themselves are
 * the operator's and live in src/hosted/ (docs/specs/open-source-release.md,
 * 6.6); this file holds none.
 */

/** One numbered term of the audit terms page: a paragraph, a list, or both. */
export type AuditTerm = { title: string; text?: string; list?: string[] };

export type DpaListItem = { text: string; sub?: string[] };

/** One block of the data processing agreement's page. */
export type DpaBlock =
  | { kind: "title" | "note" | "h2" | "h3" | "p"; text: string }
  | { kind: "clause"; num: string; text: string }
  | { kind: "list"; style: "bullet" | "number" | "alpha"; items: DpaListItem[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" };

/** Every word the blocks hold, in order, marks and all. */
export function dpaWords(blocks: DpaBlock[]): string[] {
  return blocks.flatMap((b): string[] => {
    switch (b.kind) {
      case "hr":
        return [];
      case "clause":
        return [b.num, b.text];
      case "list":
        return b.items.flatMap((it) => [it.text, ...(it.sub ?? [])]);
      case "table":
        return [...b.head, ...b.rows.flat()];
      default:
        return [b.text];
    }
  });
}

/**
 * A template still waiting for its lawyer: any "[" left in the words (the
 * parties, dates, periods, the transfer module, the governing law, a
 * subprocessor's location). The page says "Draft. Not yet in force." until
 * none is left.
 */
export function isDraft(blocks: DpaBlock[]): boolean {
  return dpaWords(blocks).some((w) => w.includes("["));
}
