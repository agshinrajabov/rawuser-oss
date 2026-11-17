/**
 * Builds the package: two ESM entry files and the chunk they share, no
 * dependency, and the type declarations beside them. The source lives in packages/shared; nothing is
 * copied by hand.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));

export async function buildPackage(): Promise<{
  file: string;
  intent: string;
  files: string[];
  bytes: number;
}> {
  rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
  const outdir = join(pkgDir, "dist");
  // Two doors, one copy of the code: the part both use goes in a shared
  // chunk, so importing both does not load the signals twice.
  const result = await esbuild.build({
    entryPoints: { index: join(pkgDir, "src/index.ts"), intent: join(pkgDir, "src/intent.ts") },
    outdir,
    bundle: true,
    splitting: true,
    chunkNames: "chunk-[hash]",
    format: "esm",
    platform: "neutral",
    target: "es2020",
    metafile: true,
    legalComments: "none",
  });
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: pkgDir, stdio: "inherit" });
  const outputs = Object.entries(result.metafile.outputs);
  return {
    file: join(outdir, "index.js"),
    intent: join(outdir, "intent.js"),
    files: outputs.map(([f]) => f),
    bytes: outputs.reduce((n, [, o]) => n + o.bytes, 0),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes } = await buildPackage();
  console.log(`dist ${bytes} bytes`);
}
