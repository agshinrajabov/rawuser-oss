/**
 * The snippet's private copy of the template rules must equal the shared one
 * (docs/specs/template-writing.md §4.1), on the lab page and on hand trees.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTemplate as shared,
  templateLength as sharedLength,
  templateText as sharedText,
} from "@rawuser/shared/template";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  type TplNode,
  readTemplate as local,
  templateLength as localLength,
  templateText as localText,
  treeOf,
} from "../src/template.ts";

const LAB = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "word-split-hero.html"),
  "utf8",
);

const t = (text: string): TplNode => ({ kind: "text", text });
const el = (tag: string, classes: string[], ...children: TplNode[]): TplNode => ({
  kind: "el",
  tag,
  classes,
  children,
});
const w = (word: string, ...extra: string[]) => el("span", ["w", ...extra], t(word));

const HAND: TplNode[][] = [
  [
    w("one", "dim"),
    t(" "),
    el("span", ["g"], el("svg", [])),
    w("two"),
    t(" "),
    w("three"),
    el("br", []),
    w("four"),
    t(" "),
    w("five"),
  ],
  [
    w("Now"),
    t(" "),
    w("choose"),
    t(" "),
    w("what"),
    t(" "),
    w("they"),
    t(" "),
    w("can"),
    t(" "),
    el("span", ["rot"], el("span", ["active"], t("read")), el("span", [], t("buy"))),
    t("."),
  ],
  "Welcome".split("").map((c) => el("span", [], t(c))),
  [w("a")],
];

describe("template parity (snippet copy vs @rawuser/shared)", () => {
  it("reads the lab headline identically", () => {
    const d = new JSDOM(LAB).window.document;
    const tree = treeOf(d.querySelector('[data-rawuser="hero.headline"]') as Element);
    const a = local(tree);
    expect(a).toEqual(shared(tree));
    const tpl = a?.template ?? "";
    expect(localText(tpl)).toBe(sharedText(tpl));
    expect(localLength(tpl)).toBe(sharedLength(tpl));
  });

  it("reads every hand tree identically", () => {
    for (const tree of HAND) expect(local(tree)).toEqual(shared(tree));
  });
});
