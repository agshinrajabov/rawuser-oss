/**
 * Builds the package: one ESM file with no dependency, and the type
 * declarations beside it. The source lives in packages/shared; nothing is
 * copied by hand.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));

export async function buildPackage(): Promise<{ file: string; bytes: number }> {
  rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
  const file = join(pkgDir, "dist/index.js");
  const result = await esbuild.build({
    entryPoints: [join(pkgDir, "src/index.ts")],
    outfile: file,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2020",
    metafile: true,
    legalComments: "none",
  });
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: pkgDir, stdio: "inherit" });
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  return { file, bytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes } = await buildPackage();
  console.log(`dist/index.js ${bytes} bytes`);
}
