import { normalizePath as edgeNormalize } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { normalizePath as snippetNormalize } from "../src/path.ts";

/**
 * The snippet keeps a LOCAL copy of normalizePath (zero-runtime-shared-imports
 * rule). The edge uses the shared copy. If they ever diverge, a visit silently
 * falls back to the '/' manifest. This test imports both and asserts identical
 * output across a fixture set covering every normalization rule.
 */
const FIXTURES = [
  "",
  "/",
  "/start",
  "/Start",
  "/START",
  "/start/",
  "/a/b/",
  "//start",
  "/a//b///c",
  "start",
  "/start?utm_campaign=x",
  "/?token=secret",
  "/start#enroll",
  "/p#a?b",
  "/p?a#b",
  "/courses/ux-ui-dizayn-esaslari",
  "/CERTIFICATE/verify/abc123",
];

describe("normalizePath parity — snippet local copy === shared source", () => {
  for (const input of FIXTURES) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      expect(snippetNormalize(input)).toBe(edgeNormalize(input));
    });
  }

  it("agrees on null/undefined", () => {
    expect(snippetNormalize(null)).toBe(edgeNormalize(null));
    expect(snippetNormalize(undefined)).toBe(edgeNormalize(undefined));
  });
});
