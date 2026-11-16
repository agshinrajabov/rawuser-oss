/**
 * The QR code is drawn in the browser (privacy review condition 7,
 * docs/specs/security-hardening.md §1.4 and §1.6): the otpauth URI holds
 * the secret and never goes to a QR web service or any other host.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { modulesPath, qrModules } from "../../src/lib/qr";

const SRC = join(__dirname, "../../src");
const URI =
  "otpauth://totp/Rawuser:lena%40brisk.test?secret=MEVXRVCQURTAEBOG65YQ37I7LATJPUU5&issuer=Rawuser&algorithm=SHA1&digits=6&period=30";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe("the QR code", () => {
  it("is made from the URI by the bundled generator: a square with its three finders", async () => {
    const { size, path } = await qrModules(URI);
    // ~120 characters at level M: version 6 or 7 (41 or 45 modules).
    expect(size).toBeGreaterThanOrEqual(41);
    expect(size).toBeLessThanOrEqual(49);
    expect((size - 17) % 4).toBe(0);
    // Each finder's top row is seven dark modules: top left, top right, bottom left.
    expect(path).toContain("M0 0h7v1h-7z");
    expect(path).toContain(`M${size - 7} 0h7v1h-7z`);
    expect(path).toContain(`M0 ${size - 7}h7v1h-7z`);
    // Deterministic: the same URI draws the same code.
    expect((await qrModules(URI)).path).toBe(path);
  });

  it("merges each row's dark run into one rectangle", () => {
    const dark = new Set(["0,0", "0,1", "0,3", "1,2"]);
    expect(modulesPath(4, (r, c) => dark.has(`${r},${c}`))).toBe(
      "M0 0h2v1h-2zM3 0h1v1h-1zM2 1h1v1h-1z",
    );
  });
});

describe("privacy review condition 7: the URI stays in the browser", () => {
  const all = files(SRC);

  it("only lib/qr.ts loads the generator, as a dynamic import", () => {
    const users = all.filter((f) => readFileSync(f, "utf8").includes("qrcode-generator"));
    expect(users.map((f) => relative(SRC, f))).toEqual(["lib/qr.ts"]);
    const qr = readFileSync(join(SRC, "lib/qr.ts"), "utf8");
    expect(qr).toContain('await import("qrcode-generator")');
    expect(qr).not.toMatch(/^import .*qrcode-generator/m);
  });

  it("lib/qr.ts is used only by the parts the dialog and the set-up page share", () => {
    const users = all
      .filter((f) => /from "@\/lib\/qr"|from "\.\/qr"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(users).toEqual(["components/account/TwoStepParts.tsx"]);
  });

  it("the URI is passed only to the QR drawing, never sent, never in a URL", () => {
    for (const f of all) {
      const src = readFileSync(f, "utf8");
      if (!/otpauth_uri|\.uri\b/.test(src)) continue;
      // No call, image or link can carry it out.
      expect(src, relative(SRC, f)).not.toMatch(/fetch\([^)]*uri/i);
      expect(src, relative(SRC, f)).not.toMatch(/<img/);
      expect(src, relative(SRC, f)).not.toMatch(/(src|href)=\{[^}]*uri/i);
      expect(src, relative(SRC, f)).not.toMatch(/https?:\/\/[^"'`\s]*(qr|chart)/i);
    }
  });
});
