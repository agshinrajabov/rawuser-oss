/**
 * The package as someone installs it: built, self-contained, typed, and
 * doing what its README says.
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

type Lib = typeof import("../src/index.ts");
let lib: Lib;
let js = "";
/** Every file the build wrote, entry files and chunk. */
let all = "";

beforeAll(async () => {
  const built = await buildPackage();
  js = readFileSync(built.file, "utf8");
  all = built.files.map((f) => readFileSync(resolve(PKG, "..", "..", f), "utf8")).join("\n");
  lib = (await import(/* @vite-ignore */ `${built.file}?t=${Date.now()}`)) as Lib;
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

describe("@rawuser/signals, built", () => {
  it("imports nothing but its own shared chunk", () => {
    for (const m of js.matchAll(/^\s*import\b[^;]*?from\s*"([^"]+)"/gm))
      expect(m[1]).toMatch(/^\.\/chunk-[A-Z0-9]+\.js$/);
    expect(js).not.toMatch(/\brequire\(/);
    expect(js).not.toContain("@rawuser/shared");
  });

  it("stores nothing and calls nothing", () => {
    expect(all).not.toMatch(
      /\bfetch\(|XMLHttpRequest|sendBeacon|document\.cookie|localStorage|sessionStorage|indexedDB/,
    );
  });

  it("finds what the README's table says, for each of its four visits", () => {
    expect(read("https://example.com/?utm_source=chatgpt.com").aiSource).toBe("chatgpt");
    const cited = read("https://example.com/", {
      referer: "https://www.perplexity.ai/search?q=anything",
    });
    expect(cited.aiSource).toBe("perplexity");
    expect(cited.referrerHost).toBe("www.perplexity.ai");
    const inApp = read("https://example.com/", {
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0",
    });
    expect(inApp.appSource).toEqual({ app: "instagram", channel: "social", confidence: "high" });
    const ad = read("https://example.com/pricing?gclid=abc123");
    expect(ad.clickId).toBe("google-ads");
    expect(ad.linkFamily).toBe("paid-search");
    for (const cell of [
      '`aiSource: "chatgpt"`',
      '`aiSource: "perplexity"`, `referrerHost: "www.perplexity.ai"`',
      '`appSource: { app: "instagram", channel: "social", confidence: "high" }`',
      '`clickId: "google-ads"`, `linkFamily: "paid-search"`',
    ]) {
      expect(README).toContain(cell);
    }
  });

  it("the README's counts are the tables' own", () => {
    expect(README).toContain(`- ${lib.AI_REFERRER_HOSTS.length} AI assistant hosts`);
    expect(README).toContain(`- ${lib.APP_UAS.length} in-app browser markers`);
    expect(README).toContain(`- ${lib.CLICK_ID_PARAM_NAMES.length} click id and tracked-link`);
    expect(README).toContain(`- ${lib.SOURCE_NAMES.length} named sources`);
  });

  it("exports every name the README names", () => {
    // The intent door's names are checked in intent.test.ts.
    const where = README.slice(0, README.indexOf("## Why it came"));
    const named = [...where.matchAll(/`([A-Za-z_]+)`/g)]
      .map((m) => m[1] as string)
      .filter((n) => /^[a-z]+[A-Z]|^[A-Z_]+$/.test(n) && n !== "URL");
    expect(named.length).toBeGreaterThan(8);
    for (const n of named) expect(Object.keys(lib), n).toContain(n);
  });

  it("leaves alone what the README says it leaves alone", () => {
    const s = read("https://example.com/?gclid=SECRET-VALUE-123&utm_source=x", {
      referer: "https://www.google.com/search?q=private+words",
    });
    const out = JSON.stringify(s);
    expect(out).not.toContain("SECRET-VALUE-123");
    expect(out).not.toContain("private");
    expect(out).not.toContain("Mozilla");
    expect(s.referrerHost).toBe("www.google.com");
    expect(s.country).toBeNull();
    expect(
      lib.extractSignals({
        url: new URL("https://example.com/"),
        headers: new Headers(),
        cf: { country: "DE" },
      }).country,
    ).toBe("DE");
  });
});

describe("@rawuser/signals, as a package", () => {
  it("is MIT, public, and ships only its build, its README and its licence", () => {
    expect(manifest.name).toBe("@rawuser/signals");
    expect(manifest.license).toBe("MIT");
    expect(manifest.private).toBeUndefined();
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(Object.keys(manifest.exports)).toEqual([".", "./intent"]);
    const licence = readFileSync(join(PKG, "LICENSE"), "utf8");
    expect(licence.startsWith("MIT License\n\nCopyright (c) 2026 PixelHurts, LLC\n")).toBe(true);
  });

  describe("in a project that installs it", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "signals-consumer-"));
      const at = join(dir, "node_modules/@rawuser/signals");
      mkdirSync(at, { recursive: true });
      cpSync(join(PKG, "dist"), join(at, "dist"), { recursive: true });
      cpSync(join(PKG, "package.json"), join(at, "package.json"));
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(dir, "use.ts"),
        [
          'import { type Signals, extractSignals } from "@rawuser/signals";',
          'const s: Signals = extractSignals({ url: new URL("https://example.com/"), headers: new Headers() });',
          "const ai: string | null = s.aiSource;",
          "// @ts-expect-error the types are the real ones, not any",
          "s.notAField;",
          "export { ai };",
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
