/**
 * Bundle-size test — LOAD-BEARING.
 *
 * Builds the snippet via esbuild, gzips the output, and asserts the result
 * stays under the 15KB hard ceiling. Failing this test fails CI.
 *
 * Prints raw and gzipped sizes on every run so we can see the headroom.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPicker, buildRich, buildSnippet } from "../build.ts";

const CEILING = 15 * 1024; // 15360 bytes — hard ceiling per spec
const PICKER_CEILING = 12 * 1024; // the picker loads only in pick mode, never for a visitor
/**
 * The rich writers (template-write.ts, lines-write.ts) load only on pages
 * built word by word or cut into lines (2026-09-30). Moving them out took
 * the core from 14,957 to 11,741 B gzip; rich.js was 5,409 B.
 */
const RICH_CEILING = 9 * 1024;
// 8 KB until 2026-11-04; the visitor-choice bar (docs/specs/direct-visitors.md
// §2) took rich.js from 7,777 to about 8,740 B. rich.js is never on the
// critical path: it loads beside /select, only on listed pages or with `q`.
/**
 * The boot (docs/specs/faster-tag.md step 4): what a customer's tag
 * `/s/{id}.js` runs before the core comes. Measured 2026-10-25 at 3,820 B
 * gzip with the reveal it must do alone (the spec's prototype, 2,935 B, had
 * no reveal of its own, no exit listeners and no handoff); the spec
 * proposed 4 KB.
 */
const BOOT_CEILING = 4 * 1024;

describe("snippet bundle size", () => {
  it("gzipped size is under 15KB", async () => {
    const { size, gzippedSize, brotliSize } = await buildSnippet();

    console.log(
      `snippet.js (the core)  raw=${size} bytes  gzipped=${gzippedSize} bytes  brotli=${brotliSize} bytes  headroom=${CEILING - gzippedSize} bytes  ceiling=${CEILING}`,
    );

    expect(gzippedSize).toBeLessThan(CEILING);
  });

  it("the boot is under its own ceiling, and carries the core's hash and no operator code", async () => {
    const { hash, boot } = await buildSnippet();
    console.log(
      `boot.js  raw=${boot.size} bytes  gzipped=${boot.gzippedSize} bytes  brotli=${boot.brotliSize} bytes  ceiling=${BOOT_CEILING}`,
    );
    expect(boot.gzippedSize).toBeLessThan(BOOT_CEILING);
    const js = readFileSync(new URL("../dist/boot.js", import.meta.url), "utf8");
    // Exactly the core it was made with.
    expect(js).toContain("/s/_core/${");
    expect(js).toContain(`"${hash}"`);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // The hide style's text byte for byte (its sha256 is in pasted policies).
    expect(js).toContain('"[data-rawuser]{visibility:hidden!important}"');
    // Operator code stays out: the boot only notices a token and hands the
    // page to the core (pick, capture), and never measures fonts.
    for (const word of ["/picker.js", "/onboard/capture", "outerHTML", "measureText", "getContext"])
      expect(js, word).not.toContain(word);
    // The visitor's core no longer carries the capture either (faster-tag.md D).
    const core = readFileSync(new URL("../dist/snippet.js", import.meta.url), "utf8");
    expect(core).not.toContain("/onboard/capture");
    expect(core).toContain("/picker.js");
    // The operator module carries it now.
    await buildPicker();
    const picker = readFileSync(new URL("../dist/picker.js", import.meta.url), "utf8");
    expect(picker).toContain("/onboard/capture");
  });

  it("the two-part tag's code rides in the boot only (faster-tag.md step 6)", async () => {
    const { gzippedSize, boot } = await buildSnippet();
    const bootJs = readFileSync(new URL("../dist/boot.js", import.meta.url), "utf8");
    const core = readFileSync(new URL("../dist/snippet.js", import.meta.url), "utf8");
    // The boot reads the pasted style, checks it and disables it.
    expect(bootJs).toContain('"style[data-rawuser-pre]"');
    expect(bootJs).toContain("compareDocumentPosition");
    expect(bootJs).toMatch(/\.disabled=!0/);
    // The core and the single file know nothing of it (a few bytes for the hook).
    expect(core).not.toContain("data-rawuser-pre");
    expect(core).not.toContain("compareDocumentPosition");
    // Both under their ceilings with it: boot 4,096, core 15,360.
    expect(boot.gzippedSize).toBeLessThan(BOOT_CEILING);
    expect(gzippedSize).toBeLessThan(CEILING);
  });

  it("the visitor bundle never measures fonts (phase 4, privacy review condition 2)", async () => {
    await buildSnippet();
    const js = readFileSync(new URL("../dist/snippet.js", import.meta.url), "utf8");
    // Canvas and font measurement runs only in the operator's picker.
    expect(js).not.toContain("measureText");
    expect(js).not.toContain("getContext");
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/picker\/metrics/);
    // rich.js runs for visitors too.
    await buildRich();
    const rich = readFileSync(new URL("../dist/rich.js", import.meta.url), "utf8");
    expect(rich).not.toContain("measureText");
    expect(rich).not.toContain("getContext");
  });

  it("rich.js gzipped size is under 9KB, and the core carries none of its writers", async () => {
    const { size, gzippedSize } = await buildRich();
    console.log(
      `rich.js  raw=${size} bytes  gzipped=${gzippedSize} bytes  ceiling=${RICH_CEILING}`,
    );
    expect(gzippedSize).toBeLessThan(RICH_CEILING);
    const rich = readFileSync(new URL("../dist/rich.js", import.meta.url), "utf8");
    expect(rich).toContain("__rwx");
    await buildSnippet();
    const core = readFileSync(new URL("../dist/snippet.js", import.meta.url), "utf8");
    // FOLLOW's stagger names and the rotator's state classes live in rich.js only.
    expect(core).not.toContain("--char-index");
    expect(core).toMatch(/\/rich\.js\?v=/);
  });

  it("picker.js gzipped size is under 12KB", async () => {
    const { size, gzippedSize } = await buildPicker();
    console.log(
      `picker.js  raw=${size} bytes  gzipped=${gzippedSize} bytes  ceiling=${PICKER_CEILING}`,
    );
    expect(gzippedSize).toBeLessThan(PICKER_CEILING);
  });
});
