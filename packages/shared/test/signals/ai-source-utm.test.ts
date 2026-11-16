import { describe, expect, it } from "vitest";
import { classify } from "../../src/classify/index.ts";
import { detectAiSource } from "../../src/signals/ai-source.ts";
import { extractSignals } from "../../src/signals/extract.ts";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36";

describe("detectAiSource with utm", () => {
  it("reads ChatGPT's own utm_source when the referrer is gone", () => {
    expect(detectAiSource(CHROME, null, { source: "chatgpt.com" })).toEqual({
      aiSource: "chatgpt",
      isBot: false,
      isCitationClick: false,
    });
    expect(detectAiSource(CHROME, null, { medium: "ai-assistant" }).aiSource).toBe("chatgpt");
    expect(detectAiSource(CHROME, null, { source: "linkedin" }).aiSource).toBeNull();
  });

  it("bot and referrer still win over utm, new hosts and UAs are known", () => {
    expect(
      detectAiSource("Mozilla/5.0 (compatible; GPTBot/1.0)", null, { source: "linkedin" }).isBot,
    ).toBe(true);
    expect(detectAiSource(CHROME, "grok.com", null).aiSource).toBe("grok");
    expect(detectAiSource("MistralAI-User/1.0", null, null)).toMatchObject({
      aiSource: "mistral",
      isCitationClick: true,
    });
    expect(detectAiSource("Mozilla/5.0 (compatible; DuckAssistBot/1.0)", null, null)).toMatchObject(
      { aiSource: "duckai", isBot: true },
    );
  });
});

describe("classify through extractSignals", () => {
  function vec(url: string, ua = CHROME) {
    const s = extractSignals({
      url: new URL(url),
      headers: new Headers({ "user-agent": ua }),
      cf: null,
    });
    return { s, v: classify(s, Date.now(), null) };
  }

  it("utm_source=chatgpt.com becomes source.ai", () => {
    const { s, v } = vec("https://edge.test/select?customer_id=c&utm_source=chatgpt.com");
    expect(s.aiSource).toBe("chatgpt");
    expect(v.source.ai).toBeGreaterThan(0.9);
  });

  it("free-form social and paid values classify without a table row", () => {
    expect(
      vec("https://edge.test/select?customer_id=c&utm_source=linkedin_newsletter").v.source.social,
    ).toBeGreaterThan(0.5);
    expect(
      vec("https://edge.test/select?customer_id=c&utm_medium=paid_social&utm_source=fb").v.source
        .paid,
    ).toBeGreaterThan(0.5);
    expect(
      vec("https://edge.test/select?customer_id=c&utm_medium=newsletter").v.source.direct,
    ).toBeGreaterThan(0);
  });

  it("the Gemini iOS app webview counts as an AI source", () => {
    const { s } = vec(
      "https://edge.test/select?customer_id=c",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GoogleWv/1.0 (WKWebView) GeminiiOS/1.2025.4170000",
    );
    expect(s.aiSource).toBe("gemini");
  });
});
