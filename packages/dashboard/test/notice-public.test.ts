/**
 * docs/privacy-notice.md gives a site owner the words for its privacy
 * notice. They are the words the dashboard shows beside Go live and beside
 * each switch, so the page and the screens cannot drift apart.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHOICE_NOTICE, SWITCH_LINES } from "../src/lib/direct";
import { NOTICE_PARAGRAPH } from "../src/lib/golive";

/** In the public repository the page is in docs/; in ours it waits in the overlay. */
function page(): string {
  for (const at of ["../../../docs/", "../../../ops/public/overlay/docs/"]) {
    const url = new URL(`${at}privacy-notice.md`, import.meta.url);
    if (existsSync(url)) return readFileSync(url, "utf8");
  }
  throw new Error("docs/privacy-notice.md is not there");
}

/** The page as running text: quote marks of a block and line breaks aside. */
const flat = page().replace(/^> ?/gm, "").replace(/\s+/g, " ");

describe("the notice page and the screens say the same words", () => {
  it("the paragraph beside Go live, word for word", () => {
    expect(flat).toContain(NOTICE_PARAGRAPH);
  });

  it("the sentence of the question on the page", () => {
    expect(flat).toContain(CHOICE_NOTICE);
  });

  it("the sentence of every switch that has one", () => {
    const withNotice = Object.entries(SWITCH_LINES).filter(
      ([, v]) => typeof v === "object" && v !== null && "notice" in v,
    ) as [string, { notice: string }][];
    expect(withNotice.map(([k]) => k).sort()).toEqual([
      "insights",
      "learned_default",
      "market_versions",
      "page_one",
      "remember",
    ]);
    for (const [name, v] of withNotice) expect(flat, name).toContain(v.notice);
  });

  it("names each switch as the dashboard labels it", () => {
    for (const key of [
      "insights",
      "page_one",
      "learned_default",
      "market_versions",
      "remember",
    ] as const)
      expect(flat, key).toContain(SWITCH_LINES[key].label);
  });
});
