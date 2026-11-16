/**
 * The snippet's private copy of the shape rules must equal the shared one.
 */
import { shapeFromParts as shared } from "@rawuser/shared/inline-shape";
import { describe, expect, it } from "vitest";
import { type InlinePart, shapeFromParts as local } from "../src/shape.ts";

const CASES: InlinePart[][] = [
  [{ kind: "text", text: "Plain" }],
  [
    { kind: "el", tag: "svg", text: "" },
    { kind: "text", text: " Label" },
  ],
  [
    { kind: "text", text: "Start " },
    { kind: "el", tag: "span", text: "→" },
  ],
  [
    { kind: "text", text: "We build " },
    { kind: "el", tag: "em", text: "hand-made" },
    { kind: "text", text: " products." },
  ],
  [
    { kind: "el", tag: "span", text: "a" },
    { kind: "el", tag: "span", text: "b" },
    { kind: "el", tag: "span", text: "c" },
    { kind: "el", tag: "span", text: "d" },
    { kind: "el", tag: "span", text: "e" },
  ],
  [
    { kind: "el", tag: "i", text: "x" },
    { kind: "text", text: "Icon font then words" },
  ],
  [
    { kind: "el", tag: "img", text: "" },
    { kind: "el", tag: "span", text: "Only words in a span" },
    { kind: "el", tag: "svg", text: "" },
  ],
];

describe("shape rules parity", () => {
  it("snippet and shared agree on every case", () => {
    for (const parts of CASES) expect(local(parts)).toEqual(shared(parts));
  });
});
