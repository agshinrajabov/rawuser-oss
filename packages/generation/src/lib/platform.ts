/**
 * Which builder made the site, and who hosts it
 * (docs/specs/install-friction.md, D, "Detection").
 *
 * A pure function over the HTML and headers the probe or the apply read
 * already has; first match wins, in the spec's order. The platform picks the
 * install steps on the Connect screen; the hosting picks where a CSP lives.
 *
 * Checked on live pages 2026-10-04: our Webflow page (data-wf-site,
 * generator Webflow, website-files.com), a pilot site (Next.js, /_next/static/,
 * x-powered-by), a prospect's site (Next.js on Vercel), a Lovable test site (Lovable: the
 * lovable-badge and lovable.app hosts in the page; no generator meta, no
 * gpteng script any more). A bare Vite shell (a prospect's site: an empty
 * #root and /assets/index-*.js, nothing else) is not taken as Lovable: any
 * Vite app looks like that, and "Ask Lovable" would be the wrong step. It is
 * `other`, whose step (first line inside head of index.html) is right for
 * every Vite app.
 */

export const PLATFORMS = [
  "webflow",
  "framer",
  "wix",
  "squarespace",
  "shopify",
  "wordpress",
  "lovable",
  "nextjs",
  "vercel",
  "other",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const HOSTINGS = ["vercel", "netlify", "cloudflare_pages", "cloudflare"] as const;
export type Hosting = (typeof HOSTINGS)[number];

export interface PlatformInput {
  html: string;
  headers: Headers | null;
  /** The final page URL's hostname. */
  host: string;
}

function header(headers: Headers | null, name: string): string {
  return (headers?.get(name) ?? "").toLowerCase();
}

/** Every <meta name="generator"> content, lowercased. */
function generators(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']?generator["'\s>]/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = content?.[1] ?? content?.[2] ?? content?.[3];
    if (value) out.push(value.toLowerCase());
  }
  return out;
}

function hostIs(host: string, suffix: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === suffix || h.endsWith(`.${suffix}`);
}

type Rule = (i: PlatformInput, gen: string[]) => boolean;

const RULES: Array<[Platform, Rule]> = [
  [
    "webflow",
    (i, gen) =>
      /<html\b[^>]*\bdata-wf-(?:site|page)\s*=/i.test(i.html) ||
      gen.some((g) => g.startsWith("webflow")) ||
      /\bwebsite-files\.com\//i.test(i.html) ||
      hostIs(i.host, "webflow.io"),
  ],
  [
    "framer",
    (i, gen) =>
      gen.some((g) => g.startsWith("framer")) ||
      /framerusercontent\.com/i.test(i.html) ||
      /\bdata-framer-[a-z-]+/i.test(i.html) ||
      hostIs(i.host, "framer.website") ||
      hostIs(i.host, "framer.app"),
  ],
  [
    "wix",
    (i, gen) =>
      gen.some((g) => g.includes("wix.com")) ||
      /static\.wixstatic\.com/i.test(i.html) ||
      header(i.headers, "x-wix-request-id") !== "",
  ],
  [
    "squarespace",
    (i) => /This is Squarespace\./.test(i.html) || /static1\.squarespace\.com/i.test(i.html),
  ],
  [
    "shopify",
    (i) =>
      /cdn\.shopify\.com/i.test(i.html) ||
      /\bShopify\.theme\b/.test(i.html) ||
      header(i.headers, "x-shopid") !== "" ||
      header(i.headers, "powered-by").includes("shopify"),
  ],
  [
    "wordpress",
    (i, gen) =>
      gen.some((g) => g.startsWith("wordpress")) || /\/wp-(?:content|includes)\//i.test(i.html),
  ],
  [
    "lovable",
    (i) =>
      hostIs(i.host, "lovable.app") ||
      hostIs(i.host, "lovableproject.com") ||
      /cdn\.gpteng\.co/i.test(i.html) ||
      /<meta\b[^>]*\bname\s*=\s*["']?author["']?[^>]*\bcontent\s*=\s*["']?lovable\b/i.test(
        i.html,
      ) ||
      /<meta\b[^>]*\bcontent\s*=\s*["']?lovable["']?[^>]*\bname\s*=\s*["']?author\b/i.test(
        i.html,
      ) ||
      /\blovable-badge\b/.test(i.html) ||
      // og:image and friends point at Lovable's preview hosts; a link in the copy does not count.
      /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*lovable\.(?:app|dev)/i.test(i.html),
  ],
  [
    "nextjs",
    (i) =>
      /\/_next\/static\//.test(i.html) ||
      /__NEXT_DATA__|self\.__next_f/.test(i.html) ||
      header(i.headers, "x-powered-by").includes("next.js"),
  ],
  [
    "vercel",
    (i) => header(i.headers, "server") === "vercel" || header(i.headers, "x-vercel-id") !== "",
  ],
];

export function detectPlatform(input: PlatformInput): Platform {
  const gen = generators(input.html);
  for (const [platform, rule] of RULES) {
    if (rule(input, gen)) return platform;
  }
  return "other";
}

/** Who serves the page, for where a Content-Security-Policy header is set. */
export function detectHosting(input: Pick<PlatformInput, "headers" | "host">): Hosting | null {
  const server = header(input.headers, "server");
  if (server === "vercel" || header(input.headers, "x-vercel-id") !== "") return "vercel";
  if (server === "netlify" || header(input.headers, "x-nf-request-id") !== "") return "netlify";
  if (hostIs(input.host, "pages.dev")) return "cloudflare_pages";
  if (server === "cloudflare" || header(input.headers, "cf-ray") !== "") return "cloudflare";
  return null;
}
