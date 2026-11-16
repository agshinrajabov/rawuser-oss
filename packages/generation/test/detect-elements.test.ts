/**
 * Unit tests for detect-elements.ts (Unit B.1).
 *
 * All external dependencies are mocked:
 *   - generateVariant is mocked so no model is called.
 *   - global fetch is spied on to test fetchPageHtml without network.
 *
 * Coverage:
 *   - detectElements returns a parsed Manifest on valid JSON from generateVariant.
 *   - parseAndValidateManifest throws on invalid JSON (no fences).
 *   - parseAndValidateManifest throws on wrong shape (missing css field).
 *   - fetchPageHtml returns HTML and truncates at SIZE_CAP_BYTES.
 *   - fetchPageHtml rejects non-http(s) URLs (e.g. file://).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETECT_TIMEOUT_MS,
  type DetectResult,
  type ElementTargets,
  type Manifest,
  cleanHtml,
  detectElements,
  fetchPageHtml,
  parseAndValidateManifest,
} from "../src/detect-elements.ts";
import {
  buildDetectionPreamble,
  buildDetectionUserPrompt,
} from "../src/prompts/element-detection.ts";
import { FETCHER_UA } from "./install-env.ts";
import { MODEL_ENV } from "./model-env.ts";

// ---------------------------------------------------------------------------
// Mock generateVariant
// ---------------------------------------------------------------------------

vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(),
}));

// Import after mock registration
const { generateVariant } = await import("../src/generateVariant.ts");
const mockGenerateVariant = vi.mocked(generateVariant);

const ENV = { ...MODEL_ENV };

const VALID_MANIFEST_JSON = JSON.stringify({
  "hero.headline": {
    css: ["h1.hero-title", "#hero h1"],
    text: ["Build websites that"],
    structural: "first h1 in the hero section",
  },
  "hero.body": {
    css: ["p.hero-body"],
    text: [],
    structural: "first paragraph beneath the hero headline",
  },
  "hero.cta.label": {
    css: ["a.hero-cta", "button.cta-primary"],
    text: ["Get started"],
    structural: "primary CTA button in the hero section",
  },
});

function makeGenerateResult(text: string) {
  return {
    text,
    model: "model-detect",
    costUsd: 0.01,
    promptHash: "abc123",
    cacheHit: false,
    cacheReadTokens: 0,
  };
}

// ---------------------------------------------------------------------------
// detectElements: happy path
// ---------------------------------------------------------------------------

describe("detectElements: happy path", () => {
  it("returns a parsed Manifest when generateVariant returns valid JSON", async () => {
    mockGenerateVariant.mockResolvedValueOnce(makeGenerateResult(VALID_MANIFEST_JSON));

    const result: DetectResult = await detectElements("<html><body>test</body></html>", ENV);

    expect(result.manifest).toBeDefined();
    expect(Object.keys(result.manifest)).toContain("hero.headline");
    expect(Object.keys(result.manifest)).toContain("hero.body");
    expect(Object.keys(result.manifest)).toContain("hero.cta.label");

    const heroHeadline = result.manifest["hero.headline"] as ElementTargets;
    expect(heroHeadline.css).toEqual(["h1.hero-title", "#hero h1"]);
    expect(heroHeadline.text).toEqual(["Build websites that"]);
    expect(heroHeadline.structural).toBe("first h1 in the hero section");
  });

  it("returns correct cost_usd from generateVariant", async () => {
    mockGenerateVariant.mockResolvedValueOnce(makeGenerateResult(VALID_MANIFEST_JSON));
    const result = await detectElements("<html/>", ENV);
    expect(result.cost_usd).toBe(0.01);
  });

  it("returns source_html_bytes equal to html.length", async () => {
    mockGenerateVariant.mockResolvedValueOnce(makeGenerateResult(VALID_MANIFEST_JSON));
    const html = "<html><body>some content</body></html>";
    const result = await detectElements(html, ENV);
    expect(result.source_html_bytes).toBe(html.length);
  });

  it("calls generateVariant once on the detect role, with room for a whole manifest", async () => {
    mockGenerateVariant.mockClear();
    mockGenerateVariant.mockResolvedValueOnce(makeGenerateResult(VALID_MANIFEST_JSON));
    await detectElements("<html/>", ENV);
    expect(mockGenerateVariant).toHaveBeenCalledTimes(1);
    // One direct call on the primary tier: no fallback and no spare reads
    // the page with another model than the one chosen for detection.
    expect(mockGenerateVariant).toHaveBeenCalledWith(
      expect.objectContaining({ role: "detect", maxTokens: 4096 }),
      ENV,
    );
    expect(mockGenerateVariant.mock.calls[0]).toHaveLength(2);
    expect(mockGenerateVariant.mock.calls[0]?.[0]).not.toHaveProperty("model");
  });

  it("calls generateVariant with a cachedPreamble (prompt caching enabled)", async () => {
    mockGenerateVariant.mockResolvedValueOnce(makeGenerateResult(VALID_MANIFEST_JSON));
    await detectElements("<html/>", ENV);
    const callArg = mockGenerateVariant.mock.calls[mockGenerateVariant.mock.calls.length - 1]?.[0];
    expect(callArg).toBeDefined();
    expect(typeof callArg?.cachedPreamble).toBe("string");
    expect((callArg?.cachedPreamble ?? "").length).toBeGreaterThan(0);
  });

  it("strips leading whitespace/text before the JSON object", async () => {
    const withLeadingText = `Here is the manifest:\n\n${VALID_MANIFEST_JSON}`;
    mockGenerateVariant.mockResolvedValueOnce(makeGenerateResult(withLeadingText));
    const result = await detectElements("<html/>", ENV);
    expect(Object.keys(result.manifest).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// detectElements: a model that never answers
// ---------------------------------------------------------------------------

describe("detectElements: under a time limit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a model that takes the request and sends nothing back", async () => {
    vi.useFakeTimers();
    mockGenerateVariant.mockReturnValueOnce(new Promise(() => {}));
    const pending = detectElements("<html></html>", ENV);
    const refused = expect(pending).rejects.toThrow(`Timeout after ${DETECT_TIMEOUT_MS}ms`);
    await vi.advanceTimersByTimeAsync(DETECT_TIMEOUT_MS);
    await refused;
  });

  it("passes the model's own failure on as it is worded", async () => {
    mockGenerateVariant.mockRejectedValueOnce(new Error("Model request failed: HTTP 503"));
    await expect(detectElements("<html></html>", ENV)).rejects.toThrow(
      "Model request failed: HTTP 503",
    );
  });
});

// ---------------------------------------------------------------------------
// parseAndValidateManifest: invalid JSON
// ---------------------------------------------------------------------------

describe("parseAndValidateManifest: invalid JSON", () => {
  it("throws when the model returns no JSON object", () => {
    expect(() => parseAndValidateManifest("Sorry, I could not find any elements.")).toThrow(
      /no JSON object found/,
    );
  });

  it("throws on malformed JSON (unmatched braces)", () => {
    expect(() => parseAndValidateManifest("{ not valid json")).toThrow(/Manifest parse failed/);
  });

  it("throws on an empty string", () => {
    expect(() => parseAndValidateManifest("")).toThrow(/no JSON object found/);
  });

  it("strips markdown fences and still parses", () => {
    // The model sometimes wraps in ```json ... ``` despite instructions.
    // Our parser finds the first { so it should handle this gracefully.
    const withFences = `\`\`\`json\n${VALID_MANIFEST_JSON}\n\`\`\``;
    // Should NOT throw: the { comes after the fence text
    expect(() => parseAndValidateManifest(withFences)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseAndValidateManifest: wrong shape
// ---------------------------------------------------------------------------

describe("parseAndValidateManifest: wrong shape", () => {
  it("throws when css field is missing", () => {
    const noCSS = JSON.stringify({
      "hero.headline": {
        text: ["some text"],
        structural: "first h1 in main",
        // css is missing
      },
    });
    expect(() => parseAndValidateManifest(noCSS)).toThrow(/css.*must be a non-empty array/);
  });

  it("throws when css field is an empty array", () => {
    const emptyCSS = JSON.stringify({
      "hero.headline": {
        css: [],
        text: [],
        structural: "first h1 in main",
      },
    });
    expect(() => parseAndValidateManifest(emptyCSS)).toThrow(/css.*must be a non-empty array/);
  });

  it("throws when text field is missing", () => {
    const noText = JSON.stringify({
      "hero.headline": {
        css: ["h1"],
        structural: "first h1 in main",
        // text is missing
      },
    });
    expect(() => parseAndValidateManifest(noText)).toThrow(/text.*must be an array/);
  });

  it("throws when structural field is missing", () => {
    const noStructural = JSON.stringify({
      "hero.headline": {
        css: ["h1"],
        text: [],
        // structural is missing
      },
    });
    expect(() => parseAndValidateManifest(noStructural)).toThrow(/structural.*must be a non-empty/);
  });

  it("throws when structural field is an empty string", () => {
    const emptyStructural = JSON.stringify({
      "hero.headline": {
        css: ["h1"],
        text: [],
        structural: "",
      },
    });
    expect(() => parseAndValidateManifest(emptyStructural)).toThrow(
      /structural.*must be a non-empty/,
    );
  });

  it("throws when top-level is an array", () => {
    // [] contains no { so the parser rejects with "no JSON object found"
    expect(() => parseAndValidateManifest("[]")).toThrow(/Manifest parse failed/);
  });

  it("accepts an empty manifest (no detectable sections)", () => {
    // A page with none of the target sections present: model returns {}.
    const empty = JSON.stringify({});
    const result = parseAndValidateManifest(empty);
    expect(result).toEqual({});
  });

  it("accepts a valid manifest with empty text array", () => {
    const noText = JSON.stringify({
      "hero.headline": {
        css: ["h1.title"],
        text: [],
        structural: "first h1 on page",
      },
    });
    const result = parseAndValidateManifest(noText);
    expect(result["hero.headline"]?.text).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchPageHtml: happy path
// ---------------------------------------------------------------------------

describe("fetchPageHtml: happy path", () => {
  const SIZE_CAP_BYTES = 50 * 1024;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the full HTML when under the size cap", async () => {
    const html = "<html><body>hello world</body></html>";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );

    const result = await fetchPageHtml("https://example.com", {
      userAgent: FETCHER_UA,
    });
    expect(result).toBe(html);
  });

  it("truncates HTML at SIZE_CAP_BYTES when the page is large", async () => {
    // Build a string slightly larger than 50KB
    const bigHtml = "A".repeat(SIZE_CAP_BYTES + 500);
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(bigHtml, { status: 200, headers: { "content-type": "text/html" } }),
    );

    const result = await fetchPageHtml("https://example.com", {
      userAgent: FETCHER_UA,
    });
    expect(result.length).toBe(SIZE_CAP_BYTES);
    expect(result).toBe(bigHtml.slice(0, SIZE_CAP_BYTES));
  });

  it("sends the correct Rawuser User-Agent header", async () => {
    let capturedHeaders: Headers | undefined;
    vi.spyOn(global, "fetch").mockImplementationOnce(async (_, init) => {
      capturedHeaders = new Headers((init as RequestInit).headers);
      return new Response("<html/>", { status: 200 });
    });

    await fetchPageHtml("https://example.com", { userAgent: FETCHER_UA });
    expect(capturedHeaders?.get("User-Agent")).toContain("Rawuser");
  });

  it("throws when the HTTP response is not ok", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(fetchPageHtml("https://example.com", { userAgent: FETCHER_UA })).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

// ---------------------------------------------------------------------------
// fetchPageHtml: URL validation
// ---------------------------------------------------------------------------

describe("fetchPageHtml: URL validation", () => {
  it("rejects file:// URLs", async () => {
    await expect(fetchPageHtml("file:///etc/passwd", { userAgent: FETCHER_UA })).rejects.toThrow(
      /Only http\/https URLs supported/,
    );
  });

  it("rejects ftp:// URLs", async () => {
    await expect(
      fetchPageHtml("ftp://example.com/page", { userAgent: FETCHER_UA }),
    ).rejects.toThrow(/Only http\/https URLs supported/);
  });

  it("accepts http:// URLs", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response("<html/>", { status: 200 }));
    await expect(
      fetchPageHtml("http://example.com", { userAgent: FETCHER_UA }),
    ).resolves.toBeDefined();
  });

  it("accepts https:// URLs", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response("<html/>", { status: 200 }));
    await expect(
      fetchPageHtml("https://example.com", { userAgent: FETCHER_UA }),
    ).resolves.toBeDefined();
  });

  it("throws on a malformed URL", async () => {
    await expect(fetchPageHtml("not-a-url", { userAgent: FETCHER_UA })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Manifest type check: complete valid manifest
// ---------------------------------------------------------------------------

describe("parseAndValidateManifest: V2 Module 3 conversion_candidate field", () => {
  it("accepts conversion_candidate: true and preserves it", () => {
    const json = JSON.stringify({
      "hero.cta.label": {
        css: ["#hero-cta"],
        text: ["Get started"],
        structural: "primary CTA button in the hero",
        conversion_candidate: true,
      },
    });
    const result = parseAndValidateManifest(json);
    expect(result["hero.cta.label"]?.conversion_candidate).toBe(true);
  });

  it("accepts conversion_candidate: false and preserves it", () => {
    const json = JSON.stringify({
      "hero.headline": {
        css: ["h1"],
        text: [],
        structural: "first h1",
        conversion_candidate: false,
      },
    });
    const result = parseAndValidateManifest(json);
    expect(result["hero.headline"]?.conversion_candidate).toBe(false);
  });

  it("treats absent conversion_candidate as undefined (legacy manifests stay valid)", () => {
    const json = JSON.stringify({
      "hero.headline": {
        css: ["h1"],
        text: [],
        structural: "first h1",
      },
    });
    const result = parseAndValidateManifest(json);
    expect(result["hero.headline"]?.conversion_candidate).toBeUndefined();
  });

  it("treats string 'true' as invalid → undefined (string is not boolean)", () => {
    const json = JSON.stringify({
      "hero.cta.label": {
        css: ["#cta"],
        text: [],
        structural: "cta",
        conversion_candidate: "true",
      },
    });
    const result = parseAndValidateManifest(json);
    expect(result["hero.cta.label"]?.conversion_candidate).toBeUndefined();
  });

  it("treats numeric 1 as invalid → undefined", () => {
    const json = JSON.stringify({
      "hero.cta.label": {
        css: ["#cta"],
        text: [],
        structural: "cta",
        conversion_candidate: 1,
      },
    });
    const result = parseAndValidateManifest(json);
    expect(result["hero.cta.label"]?.conversion_candidate).toBeUndefined();
  });

  it("co-exists with length fields without dropping any of them", () => {
    const json = JSON.stringify({
      "hero.cta.label": {
        css: ["#cta"],
        text: ["Get started"],
        structural: "primary cta",
        original_char_length: 11,
        original_word_count: 2,
        conversion_candidate: true,
      },
    });
    const result = parseAndValidateManifest(json);
    const entry = result["hero.cta.label"];
    expect(entry?.conversion_candidate).toBe(true);
    expect(entry?.original_char_length).toBe(11);
    expect(entry?.original_word_count).toBe(2);
  });
});

describe("buildDetectionPreamble: V2 Module 3 conversion_candidate instructions", () => {
  it("preamble explains the conversion_candidate field with decision rules", () => {
    const preamble = buildDetectionPreamble();
    expect(preamble).toContain("conversion_candidate");
    expect(preamble).toContain("primary conversion action");
    // Decision rules anchor: signup / get started / demo
    expect(preamble.toLowerCase()).toContain("sign up");
    expect(preamble.toLowerCase()).toContain("get started");
    expect(preamble.toLowerCase()).toContain("demo");
  });

  it("preamble lists the new section paths pricing.cta.label and forms.submit_label", () => {
    const preamble = buildDetectionPreamble();
    expect(preamble).toContain("pricing.cta.label");
    expect(preamble).toContain("forms.submit_label");
  });

  it("preamble includes a conversion_candidate: true example AND a false example", () => {
    const preamble = buildDetectionPreamble();
    expect(preamble).toContain('"conversion_candidate": true');
    expect(preamble).toContain('"conversion_candidate": false');
  });

  it("preamble rule requires conversion_candidate on every emitted element", () => {
    const preamble = buildDetectionPreamble();
    expect(preamble.toLowerCase()).toContain("must be present on every emitted element");
  });

  it("user prompt explicitly enumerates pricing.cta.label and forms.submit_label", () => {
    const userPrompt = buildDetectionUserPrompt("<html></html>");
    expect(userPrompt).toContain("pricing.cta.label");
    expect(userPrompt).toContain("forms.submit_label");
    expect(userPrompt).toContain("conversion_candidate");
  });
});

describe("parseAndValidateManifest: full manifest round-trip", () => {
  it("parses a full 5-section manifest correctly", () => {
    const fullManifest = JSON.stringify({
      "hero.headline": {
        css: ["h1#hero-title", "section.hero h1"],
        text: ["Transform your website"],
        structural: "first h1 in the hero section",
      },
      "hero.body": {
        css: ["p.hero-subtitle"],
        text: [],
        structural: "first paragraph beneath the hero headline",
      },
      "hero.cta.label": {
        css: ["a.cta-primary"],
        text: ["Get started free"],
        structural: "primary CTA anchor in the hero section",
      },
      "features.headline": {
        css: ["h2.features-title"],
        text: ["Why choose us"],
        structural: "first h2 in the features section",
      },
      "features.body": {
        css: ["p.features-body"],
        text: [],
        structural: "first paragraph in the features section",
      },
    } satisfies Manifest);

    const result = parseAndValidateManifest(fullManifest);
    expect(Object.keys(result)).toHaveLength(5);
    expect(result["hero.cta.label"]?.css).toContain("a.cta-primary");
    expect(result["features.headline"]?.structural).toBe("first h2 in the features section");
  });
});

// ---------------------------------------------------------------------------
// cleanHtml: T1a token diet (element-detection-v2)
// ---------------------------------------------------------------------------

describe("cleanHtml: strips non-content markup", () => {
  it("removes script, style, noscript, svg, and iframe blocks", () => {
    const html = [
      "<html><head>",
      "<script>var x = 1;</script>",
      "<style>.a { color: red; }</style>",
      "</head><body>",
      "<noscript>enable JS</noscript>",
      '<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>',
      '<iframe src="https://x.test"></iframe>',
      "<h1>Keep me</h1>",
      "</body></html>",
    ].join("");
    const cleaned = cleanHtml(html);
    expect(cleaned).not.toContain("var x = 1");
    expect(cleaned).not.toContain("color: red");
    expect(cleaned).not.toContain("enable JS");
    expect(cleaned).not.toContain("viewBox");
    expect(cleaned).not.toContain("iframe");
    expect(cleaned).toContain("<h1>Keep me</h1>");
  });

  it("removes HTML comments and link tags", () => {
    const html = '<!-- a comment --><link rel="stylesheet" href="/a.css"><p>Text</p>';
    const cleaned = cleanHtml(html);
    expect(cleaned).not.toContain("a comment");
    expect(cleaned).not.toContain("stylesheet");
    expect(cleaned).toContain("<p>Text</p>");
  });

  it("collapses runs of whitespace so the size cap buys real content", () => {
    const html = "<p>a</p>\n\n\n    <p>b</p>\t\t<p>c</p>";
    const cleaned = cleanHtml(html);
    expect(cleaned).toBe("<p>a</p> <p>b</p> <p>c</p>");
  });

  it("handles attributes inside stripped tags (script with src, multiline style)", () => {
    const html =
      '<script src="/app.js" defer></script><style media="all">\nbody{margin:0}\n</style><main>ok</main>';
    const cleaned = cleanHtml(html);
    expect(cleaned).not.toContain("app.js");
    expect(cleaned).not.toContain("margin");
    expect(cleaned).toContain("<main>ok</main>");
  });

  it("leaves content-bearing markup and text intact", () => {
    const html =
      '<h1 class="hero">Turn every visitor</h1><a href="/signup" id="cta">Start free</a>';
    expect(cleanHtml(html)).toBe(html);
  });
});
