/**
 * The intent door, `@rawuser/signals/intent` (merged from @rawuser/intent
 * 0.1.0 on 2026-11-17): built, typed, and doing what the README's
 * "Why it came" section says.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPackage } from "../build.ts";

const PKG = resolve(__dirname, "..");
const README = readFileSync(join(PKG, "README.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** A fixed weekday noon, UTC: the time only feeds one context. */
const NOON = Date.UTC(2026, 0, 5, 12);

type Lib = typeof import("../src/intent.ts");
let lib: Lib;
let js = "";

beforeAll(async () => {
  const built = await buildPackage();
  js = readFileSync(built.intent, "utf8");
  lib = (await import(/* @vite-ignore */ `${built.intent}?t=${Date.now()}`)) as Lib;
}, 120_000);

const read = (address: string, headers: Record<string, string> = {}) => {
  const url = new URL(address);
  return lib.extractSignals({
    url,
    headers: new Headers({ "user-agent": UA, ...headers }),
    selfHost: url.hostname,
    entryPath: url.pathname,
  });
};
const pair = (address: string, headers: Record<string, string> = {}) => {
  const { intent_dim, source_dim } = lib.selectVariantKey(
    lib.classify(read(address, headers), NOON),
  );
  return `\`${intent_dim}\`, \`${source_dim}\``;
};

describe("@rawuser/signals/intent, built", () => {
  it("imports nothing but its own shared chunk", () => {
    for (const m of js.matchAll(/^\s*import\b[^;]*?from\s*"([^"]+)"/gm))
      expect(m[1]).toMatch(/^\.\/chunk-[A-Z0-9]+\.js$/);
    expect(js).not.toMatch(/\brequire\(/);
    expect(js).not.toContain("@rawuser/shared");
  });

  it("calls no model, stores nothing and calls nothing", () => {
    expect(js).not.toMatch(
      /\bfetch\(|XMLHttpRequest|sendBeacon|document\.cookie|localStorage|sessionStorage|indexedDB/,
    );
  });

  it("answers what the README's table says, for each of its four visits", () => {
    const rows: Array<[string, string]> = [
      ["| `/?utm_source=chatgpt.com` |", pair("https://example.com/?utm_source=chatgpt.com")],
      ["| `/pricing?gclid=...` |", pair("https://example.com/pricing?gclid=abc123")],
      [
        "| a referrer of `https://www.google.com/` |",
        pair("https://example.com/", { referer: "https://www.google.com/" }),
      ],
      ["| `/pricing`, nothing else |", pair("https://example.com/pricing")],
    ];
    for (const [visit, answer] of rows) expect(README).toContain(`${visit} ${answer} |`);
  });

  it("a visit with nothing to go on has no meaningful signal", () => {
    expect(lib.hasMeaningfulSignal(read("https://example.com/"))).toBe(false);
    expect(lib.hasMeaningfulSignal(read("https://example.com/?utm_source=chatgpt.com"))).toBe(true);
  });

  it("the README lists the dimensions the vector has, in its order", () => {
    const listed = (names: readonly string[]) => names.map((n) => `\`${n}\``).join(", ");
    const flat = README.replace(/\s+/g, " ");
    expect(flat).toContain(`Intents: ${listed(lib.INTENT_DIMENSIONS)}.`);
    expect(flat).toContain(`Sources: ${listed(lib.SOURCE_DIMENSIONS)}.`);
    expect(flat).toContain(`Contexts: ${listed(lib.CONTEXT_DIMENSIONS)}.`);
  });

  it("is a pure function: the same signals and time, the same vector", () => {
    const s = read("https://example.com/pricing?gclid=abc123");
    expect(lib.classify(s, NOON)).toEqual(lib.classify(s, NOON));
    // The hour changes one context and no intent or source.
    const night = lib.classify(s, Date.UTC(2026, 0, 5, 2));
    expect(night.intent).toEqual(lib.classify(s, NOON).intent);
    expect(night.source).toEqual(lib.classify(s, NOON).source);
  });

  it("a campaign name that points at a special category chooses nothing", () => {
    const plain = lib.classify(read("https://example.com/?utm_campaign=pricing"), NOON);
    const refused = lib.classify(read("https://example.com/?utm_campaign=diabetes-pricing"), NOON);
    expect(plain.intent.pricing).toBeGreaterThan(refused.intent.pricing);
  });

  it("exports every function the README names", () => {
    for (const n of ["classify", "extractSignals", "hasMeaningfulSignal", "selectVariantKey"]) {
      expect(README).toContain(n);
      expect(typeof (lib as Record<string, unknown>)[n], n).toBe("function");
    }
  });
});

describe("@rawuser/signals/intent, as a package", () => {
  describe("in a project that installs it", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "intent-door-consumer-"));
      const at = join(dir, "node_modules/@rawuser/signals");
      mkdirSync(at, { recursive: true });
      cpSync(join(PKG, "dist"), join(at, "dist"), { recursive: true });
      cpSync(join(PKG, "package.json"), join(at, "package.json"));
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(dir, "use.ts"),
        [
          'import { type IntentVector, classify, extractSignals, selectVariantKey } from "@rawuser/signals/intent";',
          'const s = extractSignals({ url: new URL("https://example.com/"), headers: new Headers() });',
          "const v: IntentVector = classify(s, 0);",
          'const dim: "competitor" | "evaluation" | "feature" | "problem" | "brand" | "pricing" = selectVariantKey(v).intent_dim;',
          "// @ts-expect-error the types are the real ones, not any",
          "v.notAField;",
          "export { dim };",
        ].join("\n"),
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it.each(["bundler", "node16"])(
      "its types resolve under %s resolution",
      (resolution) => {
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "ES2022",
              module: resolution === "node16" ? "node16" : "ESNext",
              moduleResolution: resolution,
              strict: true,
              noEmit: true,
              skipLibCheck: false,
              lib: ["ES2022", "DOM"],
            },
            include: ["use.ts"],
          }),
        );
        const tsc = resolve(PKG, "node_modules/.bin/tsc");
        expect(() => execFileSync(tsc, ["-p", dir], { stdio: "pipe" })).not.toThrow();
      },
      120_000,
    );
  });
});
