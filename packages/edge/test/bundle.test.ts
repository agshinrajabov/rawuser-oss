/**
 * Bundle-invariant test: the load-bearing check.
 *
 * Runs `wrangler deploy --dry-run` against the edge worker, then reads the
 * emitted bundle for any string that would show the generation package's
 * model layer was pulled in transitively. This is the only check that
 * catches indirect leaks; package.json and biome rules only catch direct
 * imports.
 *
 * If this test fails, do NOT just relax the regex. The privacy and cost
 * invariant (ADR 0003) requires the edge bundle to call no model.
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(pkgDir, ".bundle");

// The model layer's own strings (packages/generation/src/model-config.ts and
// generateVariant.ts), never the name of an assistant: the source vocabulary
// legitimately carries assistants as utm_source labels (Layer F, 2026-09-12).
// A model call cannot be made without the chat route, its key, its request
// fields or the binding's run.
const FORBIDDEN = [
  /chat\/completions/i,
  /MODEL_API_KEY/,
  /MODEL_BASE_URL/,
  /MODEL_EXTRA_BODY/,
  /WORKERS_AI_MODEL/,
  /response_format/,
  /max_completion_tokens/,
  /\bAI\.run\(/,
  /x-api-key/i,
  /messages\.create/i,
];

describe("edge bundle invariant", () => {
  it("contains no model call and nothing of the model layer", () => {
    rmSync(outDir, { recursive: true, force: true });
    execSync("npx wrangler deploy --dry-run --outdir .bundle", {
      cwd: pkgDir,
      stdio: "pipe",
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "dryrun" },
    });

    const files = readdirSync(outDir, { recursive: true, withFileTypes: true });
    const sources = files
      .filter((d) => d.isFile() && /\.(js|mjs|cjs)$/.test(d.name))
      .map((d) => join(d.parentPath ?? outDir, d.name));

    expect(sources.length, "wrangler dry-run produced no bundle output").toBeGreaterThan(0);

    for (const file of sources) {
      const content = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(
          content.match(pattern),
          `Forbidden token ${pattern} found in ${file}: the edge bundle has leaked generation code.`,
        ).toBeNull();
      }
    }
  });

  // 2026-10-18: Workers AI is a generation-only writer of last resort
  // (packages/generation/wrangler.toml). The visitor path never gets a model.
  it("the edge config binds no Workers AI, at the top level or in any environment", () => {
    const toml = readFileSync(join(pkgDir, "wrangler.toml"), "utf8").replace(/#.*$/gm, "");
    expect(toml).not.toMatch(/^\s*\[(?:env\.[\w-]+\.)?ai\]\s*$/m);
    expect(toml).not.toMatch(/^\s*ai\s*=/m);
  });
});
