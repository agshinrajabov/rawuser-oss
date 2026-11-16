/**
 * Platform detection, tag position and the stored form of the install facts
 * (docs/specs/install-friction.md D; privacy review ruling 2026-10-03,
 * condition 6). The fixtures are trimmed from the real pages, read
 * 2026-10-04, keeping the markers the detection reads.
 */

import { describe, expect, it } from "vitest";
import {
  CSP_VERDICT_KEYS,
  KIND_KEYS,
  installFacts,
  storedInstallFacts,
  validateCspVerdict,
} from "../../src/lib/install-facts.ts";
import { detectHosting, detectPlatform } from "../../src/lib/platform.ts";
import { tagPosition } from "../../src/lib/tag-position.ts";
import { EDGE_ORIGINS } from "../install-env.ts";

/** The facts under the tests' install; a page with a tag or an edge origin always has them. */
function facts(input: Omit<Parameters<typeof installFacts>[0], "edgeOrigins">) {
  const f = installFacts({ ...input, edgeOrigins: EDGE_ORIGINS });
  if (!f) throw new Error("no install facts");
  return f;
}

// --- Trimmed real heads -----------------------------------------------------

/** sample-first-web-site.webflow.io/rawuser-hero: Webflow free plan, the tag in a body Code Embed. */
const WEBFLOW_FREE = `<!DOCTYPE html><html data-wf-domain="sample-first-web-site.webflow.io" data-wf-page="6abc036afbcb4df2e667b47e" data-wf-site="6524f1622a7b14ca605011e9" data-wf-status="1"><head><meta charset="utf-8"/><link href="https://cdn.prod.website-files.com" rel="preconnect" crossorigin="anonymous"/><title>One page</title><meta content="Webflow" name="generator"/><link href="https://cdn.prod.website-files.com/6524f1622a7b14ca605011e9/css/x.webflow.shared.css" rel="stylesheet" type="text/css"/><script src="https://ajax.googleapis.com/ajax/libs/webfont/1.6.26/webfont.js" type="text/javascript"></script><script type="text/javascript">WebFont.load({});</script></head><body><div class="w-embed w-script"><script src="https://edge.example.com/s/webflow-demo.js"></script></div><section class="hero"><h1 class="h">One page, written for why you came</h1></section></body></html>`;

/** A pilot site: Next.js (OpenNext on Cloudflare), stylesheets and async chunks before the tag. */
const LUMERA = `<!DOCTYPE html><html lang="az"><head><meta charSet="utf-8"/><link rel="stylesheet" href="/_next/static/chunks/05.l-0pnk67qr.css" data-precedence="next"/><link rel="stylesheet" href="/_next/static/chunks/0n0lm~l6.4kuv.css" data-precedence="next"/><script src="/_next/static/chunks/0pqt~8bl3ukh4.js" async=""></script><script src="/_next/static/chunks/turbopack-08.4y5f46d99a.js" async=""></script><script src="https://edge.example.com/s/lumera.js"></script><title>Lumera</title></head><body><main><h1>Uşağınız üçün</h1></main><script>self.__next_f.push([1,""])</script></body></html>`;

/**
 * sample-project-000000.framer.app (2026-10-25), trimmed: Framer puts its meta
 * tags, links and two inline scripts before "Start of <head>" custom code.
 */
const FRAMER = `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=1200"><meta name="generator" content="Framer 13ebf9e"><title>Shipnote</title><link rel="canonical" href="https://sample-project-000000.framer.app/"><meta property="og:url" content="https://sample-project-000000.framer.app/"><meta name="description" content="Release notes"><link href="https://framerusercontent.com/sites/icons/default-favicon-light.v1.png" rel="icon" media="(prefers-color-scheme: light)"><link rel="apple-touch-icon" href="https://framerusercontent.com/sites/icons/default-touch-icon.v3.png"><link rel="preconnect" href="https://fonts.gstatic.com"><meta property="og:type" content="website"><script>try{if(localStorage.get("__framer_force_showing_editorbar_since")){const n=document.createElement("link");n.rel = "modulepreload";document.head.appendChild(n)}}catch(e){}</script><script>!function(){var l="framer_variant";function u(a,r){}}();</script><script data-cfasync="false" src="https://edge.example.com/s/framer-demo.js"></script><style data-framer-font-css>@font-face{}</style></head><body><div id="main"><h1>Keep your customers in the loop</h1></div></body></html>`;

/** taskboard-landing-page.lovable.app: Lovable, the new tag after one stylesheet. */
const LOVABLE = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><link rel="stylesheet" href="/assets/styles-B8pTTSz2.css" data-precedence="default"/><title>TaskBoard</title><meta name="author" content="TaskBoard"/><script src="https://edge.example.com/s/taskboard-test.js"></script><style>#lovable-badge{position:fixed}</style><meta property="og:image" content="https://pub-bb2e.r2.dev/e013/id-preview-c321bb23--73465c69.lovable.app-1789380510.png"><script type="module" async="" src="/assets/index-CMmmMk3P.js"></script></head><body><h1>Plan your day</h1></body></html>`;

/** A prospect's site: a bare Vite shell, nothing names the builder. */
const VITE_SHELL = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>mybetasoft-web</title><script type="module" crossorigin src="/assets/index-D6atucUg.js"></script><link rel="stylesheet" crossorigin href="/assets/index-CbtXu9-Y.css"></head><body><div id="root"></div></body></html>`;

/** A prospect's site: Next.js on Vercel, no tag yet. */
const BRISK = `<!DOCTYPE html><html lang="en"><head><link rel="stylesheet" href="/_next/static/css/a.css"/><script src="/_next/static/chunks/webpack.js" async=""></script></head><body><h1>Brisk</h1></body></html>`;

const host = (u: string) => new URL(u).hostname;

describe("platform", () => {
  it.each([
    ["webflow", WEBFLOW_FREE, {}, "https://sample-first-web-site.webflow.io/rawuser-hero"],
    ["nextjs", LUMERA, { "x-powered-by": "Next.js", server: "cloudflare" }, "https://lumera.test/"],
    ["lovable", LOVABLE, { server: "cloudflare" }, "https://taskboard.example.com/"],
    [
      "lovable",
      "<html><body><h1>x</h1></body></html>",
      {},
      "https://taskboard-landing-page.lovable.app/",
    ],
    ["other", VITE_SHELL, { server: "cloudflare" }, "https://mybetasoft.test/"],
    ["nextjs", BRISK, { server: "Vercel", "x-vercel-id": "arn1::x" }, "https://www.brisk.test/"],
    [
      "framer",
      `<html><head><meta name="generator" content="Framer 4b1d2c3"></head><body><div data-framer-name="Hero"></div></body></html>`,
      {},
      "https://site.example.com/",
    ],
    ["framer", "<html></html>", {}, "https://acme.framer.website/"],
    [
      "wix",
      `<html><head><meta name="generator" content="Wix.com Website Builder"/></head><body><img src="https://static.wixstatic.com/media/a.jpg"></body></html>`,
      {},
      "https://www.acme.com/",
    ],
    ["wix", "<html></html>", { "x-wix-request-id": "1.2" }, "https://www.acme.com/"],
    [
      "squarespace",
      `<!-- This is Squarespace. --><html><head><link href="https://static1.squarespace.com/static/a.css"></head></html>`,
      {},
      "https://www.acme.com/",
    ],
    [
      "shopify",
      `<html><head><script>Shopify.theme = {"name":"Dawn"};</script><link href="//cdn.shopify.com/s/files/a.css"></head></html>`,
      {},
      "https://shop.acme.com/",
    ],
    ["shopify", "<html></html>", { "powered-by": "Shopify" }, "https://shop.acme.com/"],
    [
      "wordpress",
      `<html><head><meta name="generator" content="WordPress 6.6.2" /><link href="/wp-content/themes/x/style.css"></head></html>`,
      {},
      "https://blog.acme.com/",
    ],
    [
      "vercel",
      "<html><body><h1>Astro</h1></body></html>",
      { server: "Vercel" },
      "https://acme.vercel.app/",
    ],
    ["other", "<html><body><h1>Plain</h1></body></html>", { server: "nginx" }, "https://acme.com/"],
  ])("%s", (expected, html, headers, url) => {
    expect(detectPlatform({ html, headers: new Headers(headers), host: host(url) })).toBe(expected);
  });

  it("first match wins: Webflow on Vercel headers is Webflow, Next.js on Vercel is Next.js", () => {
    const vercel = new Headers({ server: "Vercel" });
    expect(detectPlatform({ html: WEBFLOW_FREE, headers: vercel, host: "acme.com" })).toBe(
      "webflow",
    );
    expect(detectPlatform({ html: BRISK, headers: vercel, host: "acme.com" })).toBe("nextjs");
    // A Next.js page that only mentions Lovable in its copy stays Next.js.
    const mention = BRISK.replace("<h1>Brisk</h1>", "<p>We tried acme.lovable.app first</p>");
    expect(detectPlatform({ html: mention, headers: null, host: "acme.com" })).toBe("nextjs");
  });

  it("hosting: Vercel, Netlify, Cloudflare Pages, Cloudflare", () => {
    expect(detectHosting({ headers: new Headers({ "x-vercel-id": "a" }), host: "a.com" })).toBe(
      "vercel",
    );
    expect(detectHosting({ headers: new Headers({ server: "Netlify" }), host: "a.com" })).toBe(
      "netlify",
    );
    expect(detectHosting({ headers: new Headers({ "x-nf-request-id": "1" }), host: "a.com" })).toBe(
      "netlify",
    );
    expect(
      detectHosting({ headers: new Headers({ server: "cloudflare" }), host: "lab.pages.dev" }),
    ).toBe("cloudflare_pages");
    expect(detectHosting({ headers: new Headers({ server: "cloudflare" }), host: "a.com" })).toBe(
      "cloudflare",
    );
    expect(detectHosting({ headers: new Headers({ server: "nginx" }), host: "a.com" })).toBeNull();
  });
});

describe("tag position", () => {
  const pos = (html: string, customerId: string, tagRuns = false) =>
    tagPosition({ html, customerId, edgeOrigins: EDGE_ORIGINS, tagRuns });

  it("Webflow free: body_top, in the Embed above the h1", () => {
    expect(pos(WEBFLOW_FREE, "webflow-demo")).toMatchObject({ position: "body_top", flags: [] });
  });

  it("lumera.test: head_first (stylesheets and async chunks first change nothing)", () => {
    expect(pos(LUMERA, "lumera")).toMatchObject({ position: "head_first", flags: [] });
  });

  it("taskboard: head_first after a stylesheet", () => {
    expect(pos(LOVABLE, "taskboard-test")).toMatchObject({ position: "head_first", flags: [] });
  });

  it("the older async tag after an inline script: head_first, flagged async", () => {
    const html = `<html><head><script>window.dataLayer=[]</script><script async src="https://rawuser-edge-production.some-account.workers.dev/snippet.js" data-customer-id="taskboard-test"></script></head><body><h1>x</h1></body></html>`;
    const r = pos(html, "taskboard-test");
    expect(r.position).toBe("head_first");
    expect(r.flags).toEqual(["async"]);
    expect(r.tag?.form).toBe("generic");
  });

  it("a blocking external script first: head_late, blocking_script_before (amber)", () => {
    const html = `<html><head><script src="/js/jquery.min.js"></script><script src="https://edge.example.com/s/acme.js"></script></head><body><h1>x</h1></body></html>`;
    expect(pos(html, "acme")).toMatchObject({
      position: "head_late",
      flags: ["blocking_script_before"],
    });
  });

  it("Framer: meta, title, links and two inline scripts before Start of <head> code: head_first", () => {
    expect(pos(FRAMER, "framer-demo")).toMatchObject({ position: "head_first", flags: [] });
  });

  it("inline scripts and a stylesheet before it stay head_first", () => {
    const html = `<html><head><link rel="stylesheet" href="/a.css"><script>var a=1</script><script nomodule>var b=2</script><style>h1{}</style><script src="https://edge.example.com/s/acme.js"></script></head><body><h1>x</h1></body></html>`;
    expect(pos(html, "acme")).toMatchObject({ position: "head_first", flags: [] });
  });

  it("an external sync script after Framer's inline scripts: head_late, blocking_script_before", () => {
    const html = FRAMER.replace(
      '<script data-cfasync="false"',
      '<script src="https://cdn.example.com/lib.js"></script><script data-cfasync="false"',
    );
    expect(pos(html, "framer-demo")).toMatchObject({
      position: "head_late",
      flags: ["blocking_script_before"],
    });
  });

  it("an external script with a type of text/javascript before it: head_late", () => {
    const html = `<html><head><script>var a=1</script><script type="text/javascript" src="/js/lib.js"></script><script src="https://edge.example.com/s/acme.js"></script></head><body><h1>x</h1></body></html>`;
    expect(pos(html, "acme")).toMatchObject({
      position: "head_late",
      flags: ["blocking_script_before"],
    });
  });

  it("JSON-LD and module scripts first do not make it late", () => {
    const html = `<html><head><script type="application/ld+json">{}</script><script type="module" src="/m.js"></script><script src="https://edge.example.com/s/acme.js"></script></head><body></body></html>`;
    expect(pos(html, "acme").position).toBe("head_first");
  });

  it("at the end of the page: body_late", () => {
    const html = `<html><head></head><body><h1>Hero</h1><p>…</p><script src="https://edge.example.com/s/acme.js" defer></script></body></html>`;
    expect(pos(html, "acme")).toMatchObject({ position: "body_late", flags: ["defer"] });
  });

  it("module and data-cfasync before src", () => {
    const html = `<html><head><script data-cfasync="false" type="module" src="https://edge.example.com/s/acme.js"></script></head></html>`;
    expect(pos(html, "acme")).toMatchObject({ position: "head_first", flags: ["module"] });
  });

  it("Rocket Loader: flagged unless our tag carries data-cfasync=false", () => {
    const rocket = `<script src="/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js" data-cf-settings="x" defer></script>`;
    const plain = `<html><head><script src="https://edge.example.com/s/acme.js"></script></head><body><h1>x</h1>${rocket}</body></html>`;
    const opted = plain.replace("<script src=", '<script data-cfasync="false" src=');
    expect(pos(plain, "acme").flags).toEqual(["rocket_loader"]);
    expect(pos(opted, "acme").flags).toEqual([]);
  });

  it("Google Tag Manager: not in the HTML, gtm.js is, and the tag has run", () => {
    const html = `<html><head><script>(function(w,d,s,l,i){j.src='https://www.googletagmanager.com/gtm.js?id='+i})(window,document,'script','dataLayer','GTM-ABC123');</script></head><body><h1>x</h1></body></html>`;
    expect(pos(html, "acme", true)).toMatchObject({ position: "not_found", flags: ["gtm"] });
    expect(pos(html, "acme", false)).toMatchObject({ position: "not_found", flags: [] });
  });

  it("another customer's tag is not ours", () => {
    expect(pos(LUMERA, "someone-else").position).toBe("not_found");
  });
});

describe("installFacts", () => {
  it("brisk.test: Next.js on Vercel, no tag, the two lines, edit in next.config.js", () => {
    const headers = new Headers({
      server: "Vercel",
      "x-vercel-id": "arn1::x",
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.posthog.com https://vitals.vercel-insights.com; frame-src 'none'",
    });
    const f = facts({
      html: BRISK,
      headers,
      pageUrl: new URL("https://www.brisk.test/"),
      customerId: "brisk",
    });
    expect(f.platform).toBe("nextjs");
    expect(f.hosting).toBe("vercel");
    expect(f.tag_position).toBe("not_found");
    expect(f.csp.where).toBe("next_config");
    expect(f.csp.lines).toEqual([
      "script-src 'self' 'unsafe-inline' https://edge.example.com",
      "connect-src 'self' https://*.posthog.com https://vitals.vercel-insights.com https://edge.example.com",
    ]);
  });

  it("where: meta, Netlify, Cloudflare Pages, a generic header, nothing to do", () => {
    const at = (h: Record<string, string>, html: string, url = "https://acme.com/") =>
      facts({ html, headers: new Headers(h), pageUrl: new URL(url), customerId: "acme" }).csp.where;
    const meta = `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`;
    expect(at({}, meta)).toBe("meta_tag");
    const csp = { "content-security-policy": "script-src 'self'" };
    expect(at({ ...csp, server: "Netlify" }, "")).toBe("netlify_headers");
    expect(at({ ...csp, server: "cloudflare" }, "", "https://lab.pages.dev/")).toBe(
      "cloudflare_headers",
    );
    expect(at({ ...csp, server: "nginx" }, "")).toBe("header");
    expect(at({ server: "nginx" }, "")).toBeNull();
  });

  it("a nonce style policy: the tag line, in the layout on Next.js, the header elsewhere", () => {
    const nonceStyle = "style-src 'self' 'nonce-q'";
    const next = facts({
      html: LUMERA,
      headers: new Headers({ "content-security-policy": nonceStyle }),
      pageUrl: new URL("https://lumera.test/"),
      customerId: "lumera",
    });
    expect(next.platform).toBe("nextjs");
    expect(next.csp.degrades).toBe(true);
    expect(next.csp.notes).toContain("style_nonce");
    expect(next.csp.where).toBe("next_layout");
    expect(next.csp.lines).toEqual([
      '<script data-cfasync="false" src="https://edge.example.com/s/lumera.js" nonce={nonce} />',
    ]);

    const plain = facts({
      html: "",
      headers: new Headers({ "content-security-policy": nonceStyle, server: "nginx" }),
      pageUrl: new URL("https://acme.com/"),
      customerId: "acme",
    });
    expect(plain.csp.where).toBe("header");
    expect(plain.csp.lines).toEqual([
      '<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="https://edge.example.com/s/acme.js"></script>',
    ]);
  });
});

describe("stored form (condition 6)", () => {
  const verdict = {
    source: "header",
    enforced: { script: "missing_host", connect: "ok", style: "ok", frames: "blocked" },
    report_only: null,
    trusted_types: false,
  };

  it("pins the key sets of csp_verdict and of each kind", () => {
    const stored = storedInstallFacts({
      csp_verdict: verdict,
      platform: "nextjs",
      tag_position: "head_first",
      tag_flags: ["async"],
    });
    expect(Object.keys(stored).sort()).toEqual([
      "csp_verdict",
      "platform",
      "tag_flags",
      "tag_position",
    ]);
    const parsed = JSON.parse(stored.csp_verdict as string);
    expect(Object.keys(parsed).sort()).toEqual([...CSP_VERDICT_KEYS].sort());
    expect(Object.keys(parsed.enforced).sort()).toEqual([...KIND_KEYS].sort());
    expect(stored.platform).toBe("nextjs");
    expect(stored.tag_position).toBe("head_first");
    expect(stored.tag_flags).toBe('["async"]');
  });

  it("drops anything outside the enums: a host, policy text, an extra key", () => {
    const sneaky = {
      ...verdict,
      policy: "script-src 'self' https://evil.example",
      enforced: { ...verdict.enforced, host: "www.brisk.test" },
    };
    const stored = storedInstallFacts({ csp_verdict: sneaky });
    expect(stored.csp_verdict).not.toContain("brisk");
    expect(stored.csp_verdict).not.toContain("evil");
    expect(Object.keys(JSON.parse(stored.csp_verdict as string)).sort()).toEqual(
      [...CSP_VERDICT_KEYS].sort(),
    );
  });

  it("an invalid value is stored as NULL, never written as given", () => {
    expect(
      storedInstallFacts({ csp_verdict: { ...verdict, source: "https://x" } }).csp_verdict,
    ).toBeNull();
    expect(
      storedInstallFacts({
        csp_verdict: { ...verdict, enforced: { ...verdict.enforced, script: "allowed" } },
      }).csp_verdict,
    ).toBeNull();
    expect(storedInstallFacts({ platform: "wix.com" }).platform).toBeNull();
    expect(storedInstallFacts({ tag_position: "head" }).tag_position).toBeNull();
    expect(storedInstallFacts({ tag_flags: ["async", "edge.example.com"] }).tag_flags).toBeNull();
    expect(validateCspVerdict("header")).toBeNull();
  });

  it("a real read's verdict passes validation unchanged", () => {
    const f = facts({
      html: LUMERA,
      headers: new Headers({ "content-security-policy": "script-src 'self'" }),
      pageUrl: new URL("https://lumera.test/"),
      customerId: "lumera",
    });
    expect(validateCspVerdict(f.csp.verdict)).toEqual(f.csp.verdict);
  });
});
