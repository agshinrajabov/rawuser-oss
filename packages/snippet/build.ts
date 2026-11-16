/**
 * Programmatic esbuild configuration for @rawuser/snippet.
 *
 * Exposes buildSnippet() so the bundle-size test can invoke it directly
 * and read back raw + gzipped sizes without shelling out.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as zlib, brotliCompressSync, gzipSync } from "node:zlib";
import * as esbuild from "esbuild";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));
const entryPoint = join(pkgDir, "src/index.ts");
const outfile = join(pkgDir, "dist/snippet.js");
const pickerEntry = join(pkgDir, "src/picker/index.ts");
const pickerOutfile = join(pkgDir, "dist/picker.js");
const richEntry = join(pkgDir, "src/rich.ts");
const richOutfile = join(pkgDir, "dist/rich.js");
const bootEntry = join(pkgDir, "src/entry-boot.ts");
const bootOutfile = join(pkgDir, "dist/boot.js");

export interface BuildResult {
  /** Raw byte size of the built snippet.js */
  size: number;
  /** Gzipped byte size */
  gzippedSize: number;
}

/** The core and its boot (faster-tag.md step 4): the core's sizes, the boot's, and the core's hash. */
export interface SnippetBuild extends BuildResult {
  /** Brotli at quality 11, as the edge serves the core (`/s/_core/{hash}.js`). */
  brotliSize: number;
  hash: string;
  boot: BuildResult & { brotliSize: number };
}

/** Brotli at the highest quality, text mode: how the edge precompresses the core. */
export function brotli(raw: Buffer | string): Buffer {
  return brotliCompressSync(raw, {
    params: {
      [zlib.BROTLI_PARAM_QUALITY]: 11,
      [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
    },
  });
}

/**
 * The version stamp of a built script: the first 16 hex of its SHA-256, the
 * same hash scripts/inline-snippet-to-edge.ts puts in the edge's etag, so
 * the edge can tell a `?v=` it may cache for a year.
 */
export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

/**
 * The core (`dist/snippet.js`, from src/index.ts: `/snippet.js`, the
 * scripts that are not split, and `/s/_core/{hash}.js`) and then the boot
 * (`dist/boot.js`, src/entry-boot.ts), which carries the core's hash so it
 * loads exactly the core it was made with. Both carry rich.js's hash.
 */
export async function buildSnippet(): Promise<SnippetBuild> {
  // rich.js first: the core carries its hash as the `?v=` of its URL, so a
  // new rich.js is a new URL and the old one can be cached as immutable.
  const { hash } = await buildRich();
  await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    format: "iife",
    target: "es2020",
    minify: true,
    sourcemap: true,
    bundle: true,
    platform: "browser",
    define: { __RICH_VERSION__: JSON.stringify(hash) },
    // No globalName — the IIFE self-executes on load.
  });

  const raw = readFileSync(outfile);
  const gzipped = gzipSync(raw);
  const coreHash = contentHash(raw);

  await esbuild.build({
    entryPoints: [bootEntry],
    outfile: bootOutfile,
    format: "iife",
    target: "es2020",
    minify: true,
    sourcemap: true,
    bundle: true,
    platform: "browser",
    define: {
      __RICH_VERSION__: JSON.stringify(hash),
      __CORE_VERSION__: JSON.stringify(coreHash),
    },
  });
  const boot = readFileSync(bootOutfile);

  return {
    size: raw.length,
    gzippedSize: gzipped.length,
    brotliSize: brotli(raw).length,
    hash: coreHash,
    boot: {
      size: boot.length,
      gzippedSize: gzipSync(boot).length,
      brotliSize: brotli(boot).length,
    },
  };
}

/** The picker module (pick mode only), built separately so the snippet stays small. */
export async function buildPicker(): Promise<BuildResult> {
  await esbuild.build({
    entryPoints: [pickerEntry],
    outfile: pickerOutfile,
    format: "iife",
    target: "es2020",
    minify: true,
    sourcemap: true,
    bundle: true,
    platform: "browser",
  });
  const raw = readFileSync(pickerOutfile);
  return { size: raw.length, gzippedSize: gzipSync(raw).length };
}

/**
 * The rich writers (template-write.ts, lines-write.ts), `/rich.js`: loaded
 * only on the pages that need them (rich-loader.ts), 2026-09-30.
 */
export async function buildRich(): Promise<BuildResult & { hash: string }> {
  await esbuild.build({
    entryPoints: [richEntry],
    outfile: richOutfile,
    format: "iife",
    target: "es2020",
    minify: true,
    sourcemap: true,
    bundle: true,
    platform: "browser",
  });
  const raw = readFileSync(richOutfile);
  return { size: raw.length, gzippedSize: gzipSync(raw).length, hash: contentHash(raw) };
}

// Allow running as a script: `node --import tsx/esm build.ts`
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  buildSnippet()
    .then(({ size, gzippedSize, brotliSize, hash, boot }) => {
      console.log(
        `dist/snippet.js  raw=${size} bytes  gzipped=${gzippedSize} bytes  brotli=${brotliSize} bytes  (ceiling=15360)  core=${hash}`,
      );
      console.log(
        `dist/boot.js     raw=${boot.size} bytes  gzipped=${boot.gzippedSize} bytes  brotli=${boot.brotliSize} bytes  (ceiling=4096)`,
      );
      return buildRich();
    })
    .then(({ size, gzippedSize, hash }) => {
      console.log(
        `dist/rich.js     raw=${size} bytes  gzipped=${gzippedSize} bytes  (ceiling=8192)  v=${hash}`,
      );
      return buildPicker();
    })
    .then(({ size, gzippedSize }) => {
      console.log(
        `dist/picker.js   raw=${size} bytes  gzipped=${gzippedSize} bytes  (ceiling=12288)`,
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
