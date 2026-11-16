/**
 * The customer's own sentences from their live page, used as the style
 * anchor in the generation preamble (docs/specs/generation-quality.md §2).
 *
 * Read once per run, never stored. Prefers the operator's rendered-DOM
 * capture (CSR sites) when one is in KV; otherwise fetches the page with
 * the detection fetcher (same UA, timeout and cap), on the recorded host
 * only. Any failure, a redirect to another host included, means no
 * samples, never a failed run.
 */

import type { Manifest } from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";
import { templateAllWords } from "@rawuser/shared/template";
import { captureKey } from "./admin/onboard.ts";
import { cleanHtml, fetchPageHtml } from "./detect-elements.ts";
import { htmlToText } from "./dna-suggest.ts";
import { type InstallEnv, fetcherUserAgent } from "./install-config.ts";

const MIN_WORDS = 4;
const MAX_WORDS = 25;
const MAX_SAMPLES = 6;

/** Sentences from the page text worth imitating: headline-sized, complete, not nav. */
export function extractSamples(html: string, max = MAX_SAMPLES): string[] {
  const text = htmlToText(html);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    for (const raw of line.split(/(?<=[.!?])\s+/)) {
      const s = raw.trim();
      const words = s.split(/\s+/).filter(Boolean).length;
      if (words < MIN_WORDS || words > MAX_WORDS) continue;
      if (/[|©®™{}<>]|https?:\/\/|@/.test(s)) continue;
      if (/^\W*$/.test(s)) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** The capture in KV, and the fetcher's user agent for the read when there is none. */
export type PageReadEnv = { VARIANTS: KVNamespace } & Pick<InstallEnv, "BOT_INFO_URL">;

export async function loadPageSamples(
  customerId: string,
  domain: string | null | undefined,
  env: PageReadEnv,
): Promise<string[]> {
  return (await loadPageRead(customerId, domain, env)).samples;
}

/** One read of the page: its samples, and its whole text for the claims lock. */
export interface PageRead {
  samples: string[];
  /** The page as text (htmlToText), empty when nothing was read. */
  text: string;
}

/**
 * The same read as loadPageSamples, keeping the page's text as well: the
 * claims lock (docs/specs/claims-lock.md) holds a sensitive customer's
 * versions to what the page itself says, and the samples are six sentences.
 */
export async function loadPageRead(
  customerId: string,
  domain: string | null | undefined,
  env: PageReadEnv,
): Promise<PageRead> {
  const none: PageRead = { samples: [], text: "" };
  try {
    const captured = await env.VARIANTS.get(captureKey(customerId, "/"));
    if (captured) {
      const cleaned = cleanHtml(captured);
      return { samples: extractSamples(cleaned), text: htmlToText(cleaned) };
    }
    if (!domain) return none;
    const host = domain
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!host) return none;
    // Only the recorded host: a redirect to another host ends the read
    // (no samples), never followed.
    const html = await fetchPageHtml(siteOrigin(host), {
      sameHostAs: host,
      userAgent: fetcherUserAgent(env),
    });
    return { samples: extractSamples(html), text: htmlToText(html) };
  } catch {
    return none;
  }
}

/**
 * The samples without the words of a part built word by word: its lines
 * would reach the model as "the customer's own words" and invite it to
 * copy them into that part's template (the lab run, 2026-09-27: "arrive
 * through AI tools." and "Choose what they can read compare buy skip ."
 * rode in the preamble; 14 of 30 versions returned the page's headline).
 * Numbers are still read from every sample.
 */
export function samplesBesideTemplates(
  samples: readonly string[],
  manifests: ReadonlyArray<Manifest | null | undefined>,
): string[] {
  const words = manifests.flatMap((m) =>
    Object.values(m ?? {}).flatMap((e) =>
      typeof e.inline?.template === "string" ? [templateAllWords(e.inline.template)] : [],
    ),
  );
  if (words.length === 0) return [...samples];
  return samples.filter((s) => {
    const key = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    return key.length < 8 || !words.some((w) => w.includes(key));
  });
}
