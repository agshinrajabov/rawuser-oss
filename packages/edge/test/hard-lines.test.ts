/**
 * The privacy lines that never move (docs/privacy-rules.md), held on the
 * worker a visitor's browser talks to: its whole source, the scripts it
 * serves included.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

const source = files(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("the hard lines, in the worker on the visitor path", () => {
  it("reads its own source", () => {
    expect(source.length).toBeGreaterThan(15);
  });

  it("no cookie is set and none is read", () => {
    for (const { path, text } of source) {
      expect(text, path).not.toMatch(/set-cookie/i);
      expect(text, path).not.toMatch(/["'`]cookie["'`]/i);
      expect(text, path).not.toMatch(/\.cookie\b|cookieStore/);
    }
  });

  it("the connecting address is read in one place, the lead form's hourly limit, and for no page view", () => {
    const readers = source
      .filter(({ text }) => /cf-connecting-ip|x-forwarded-for|x-real-ip|true-client-ip/i.test(text))
      .map(({ path }) => path.slice(SRC.length));
    // An operator's own lead form, off until PILOT_FORM_ORIGINS is set: the
    // address becomes a keyed tag that lives an hour and is stored nowhere else.
    expect(readers).toEqual(["pilot.ts"]);
  });

  it("of where the visitor is, only the country is read", () => {
    // Words that name a place finer than a country, or the network. In code,
    // not in a comment: as `cf.city`, as a destructured name or as a type's field.
    const finer =
      /\b(city|regionCode|postalCode|latitude|longitude|metroCode|timezone|asOrganization|colo)\b/;
    const viaCf = /\bcf\??\.(region|asn)\b|\{[^}]*\b(region|asn)\b[^}]*\}\s*=[^;]*\bcf\b/;
    for (const { path, text } of source) {
      if (path.endsWith("-asset.ts") || path.endsWith("-assets.ts")) continue;
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .map((l) => l.replace(/\s\/\/ .*$/, ""))
        .join("\n");
      expect(finer.exec(code)?.[0], path).toBeUndefined();
      expect(viaCf.exec(code)?.[0], path).toBeUndefined();
    }
  });

  it("the user agent is read in two files, each time straight into a function that keeps a word or a count", () => {
    const calls: string[] = [];
    for (const { path, text } of source) {
      for (const m of text.matchAll(/(\w+)\([^()]*request\.headers\.get\("user-agent"\)/g))
        calls.push(`${path.slice(SRC.length)}: ${m[1]}`);
      // Read in no other way: not into a variable, not under another spelling.
      const reads = [...text.matchAll(/headers\.get\(\s*["'`]user-agent["'`]\s*\)/gi)].length;
      const direct = [...text.matchAll(/\w+\([^()]*request\.headers\.get\("user-agent"\)/g)].length;
      expect(reads, path).toBe(direct);
    }
    expect(calls.sort()).toEqual([
      "event.ts: deviceClassOf",
      "event.ts: webViewOf",
      "index.ts: countUaTokens",
    ]);
  });
});
