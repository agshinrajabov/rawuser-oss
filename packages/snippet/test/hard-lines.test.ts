/**
 * The privacy lines that never move (docs/privacy-rules.md), held on the
 * code a visitor's browser runs: the boot, the core and the rich writers,
 * as built. The picker is left out on purpose: it runs only for the site's
 * operator, on a link the operator opens.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRich, buildSnippet } from "../build.ts";

const built = (name: string) =>
  readFileSync(new URL(`../dist/${name}.js`, import.meta.url), "utf8");
let scripts: Record<string, string> = {};

beforeAll(async () => {
  await buildSnippet();
  await buildRich();
  scripts = { boot: built("boot"), core: built("snippet"), rich: built("rich") };
}, 120_000);

const each = (check: (name: string, js: string) => void) => {
  for (const [name, js] of Object.entries(scripts)) check(name, js);
};

describe("the hard lines, in the scripts a visitor's browser runs", () => {
  it("builds all three", () => {
    expect(Object.keys(scripts)).toEqual(["boot", "core", "rich"]);
    each((name, js) => expect(js.length, name).toBeGreaterThan(1000));
  });

  it("no cookie is set or read", () => {
    each((name, js) => expect(js, name).not.toMatch(/\.cookie\b|cookieStore/));
  });

  it("nothing a fingerprint is made of is read", () => {
    const parts = [
      "getContext",
      "measureText",
      "toDataURL",
      "AudioContext",
      "RTCPeerConnection",
      "WebGL",
      "deviceMemory",
      "hardwareConcurrency",
      "devicePixelRatio",
      "maxTouchPoints",
      "getBattery",
      "enumerateDevices",
      ".plugins",
      ".mimeTypes",
      "navigator.platform",
      "navigator.userAgent",
      "userAgentData",
      "screen.width",
      "screen.height",
      "colorDepth",
      "getTimezoneOffset",
      "resolvedOptions",
      "queryLocalFonts",
    ];
    each((name, js) => {
      for (const part of parts) expect(js.includes(part), `${name} reads ${part}`).toBe(false);
    });
  });

  it("the only thing read from the browser's settings is its language", () => {
    each((name, js) => {
      const read = [...js.matchAll(/navigator\.([a-zA-Z]+)/g)].map((m) => m[1]);
      for (const what of read)
        expect(["language", "sendBeacon"], `${name}: navigator.${what}`).toContain(what);
    });
  });

  it("no host is named: the script talks to the edge it was loaded from, and to nothing else", () => {
    each((name, js) => {
      const hosts = [...js.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]);
      // A namespace address in markup is a name, not a request.
      expect(
        hosts.filter((h) => h !== "www.w3.org"),
        name,
      ).toEqual([]);
    });
  });

  it("the device keeps tab storage, and one entry for the returning visitor in the rich script alone", () => {
    expect(scripts.boot).not.toContain("localStorage");
    expect(scripts.core).not.toContain("localStorage");
    expect(scripts.rich).toContain("__rw_pick");
    each((name, js) => expect(js, name).not.toMatch(/indexedDB|openDatabase|caches\.open/));
  });

  it("five storage keys are all there is, and local storage is touched for one of them", () => {
    const keys = new Set<string>();
    each((_, js) => {
      for (const m of js.matchAll(/__rw_[a-z_]+/g)) keys.add(m[0]);
    });
    expect([...keys].sort()).toEqual([
      "__rw_body",
      "__rw_carry",
      "__rw_pick",
      "__rw_q",
      "__rw_visit",
    ]);
    const local = [...(scripts.rich ?? "").matchAll(/localStorage\.\w+\(([^,)]*)/g)].map(
      (m) => m[1],
    );
    expect(local.length).toBeGreaterThan(0);
    expect([...new Set(local)]).toEqual(['"__rw_pick"']);
  });
});
