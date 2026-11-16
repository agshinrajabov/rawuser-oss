import { describe, expect, it } from "vitest";
import { detectAiSource } from "../../src/signals/ai-source.ts";

describe("detectAiSource", () => {
  it("returns null aiSource for plain browser UA with no referrer", () => {
    const result = detectAiSource(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      null,
    );
    expect(result.aiSource).toBeNull();
    expect(result.isBot).toBe(false);
    expect(result.isCitationClick).toBe(false);
  });

  // --- Bot UAs ---
  it("detects GPTBot as chatgpt bot", () => {
    const result = detectAiSource("GPTBot/1.2", null);
    expect(result.aiSource).toBe("chatgpt");
    expect(result.isBot).toBe(true);
    expect(result.isCitationClick).toBe(false);
  });

  it("detects OAI-SearchBot as chatgpt bot", () => {
    const result = detectAiSource("OAI-SearchBot/1.0", null);
    expect(result.aiSource).toBe("chatgpt");
    expect(result.isBot).toBe(true);
  });

  it("detects ClaudeBot as claude bot", () => {
    const result = detectAiSource("ClaudeBot/1.0", null);
    expect(result.aiSource).toBe("claude");
    expect(result.isBot).toBe(true);
  });

  it("detects Claude-SearchBot as claude bot", () => {
    const result = detectAiSource("Claude-SearchBot/1.0", null);
    expect(result.aiSource).toBe("claude");
    expect(result.isBot).toBe(true);
  });

  it("detects PerplexityBot as perplexity bot", () => {
    const result = detectAiSource("PerplexityBot/1.0", null);
    expect(result.aiSource).toBe("perplexity");
    expect(result.isBot).toBe(true);
  });

  it("detects Google-Extended as gemini bot", () => {
    const result = detectAiSource("Mozilla/5.0 (compatible; Google-Extended)", null);
    expect(result.aiSource).toBe("gemini");
    expect(result.isBot).toBe(true);
  });

  // --- User-driven (citation click) UAs ---
  it("detects ChatGPT-User as chatgpt citation click", () => {
    const result = detectAiSource("ChatGPT-User/1.0", null);
    expect(result.aiSource).toBe("chatgpt");
    expect(result.isBot).toBe(false);
    expect(result.isCitationClick).toBe(true);
  });

  it("detects Claude-User as claude citation click", () => {
    const result = detectAiSource("Claude-User/1.0", null);
    expect(result.aiSource).toBe("claude");
    expect(result.isBot).toBe(false);
    expect(result.isCitationClick).toBe(true);
  });

  it("detects Perplexity-User as perplexity citation click", () => {
    const result = detectAiSource("Perplexity-User/1.0", null);
    expect(result.aiSource).toBe("perplexity");
    expect(result.isBot).toBe(false);
    expect(result.isCitationClick).toBe(true);
  });

  // --- Referrer hosts ---
  it("detects chatgpt.com referrer as chatgpt (not bot)", () => {
    const result = detectAiSource("Mozilla/5.0 Chrome/120", "chatgpt.com");
    expect(result.aiSource).toBe("chatgpt");
    expect(result.isBot).toBe(false);
    expect(result.isCitationClick).toBe(false);
  });

  it("detects claude.ai referrer as claude", () => {
    const result = detectAiSource("Mozilla/5.0 Chrome/120", "claude.ai");
    expect(result.aiSource).toBe("claude");
    expect(result.isBot).toBe(false);
  });

  it("detects perplexity.ai referrer as perplexity", () => {
    const result = detectAiSource(null, "perplexity.ai");
    expect(result.aiSource).toBe("perplexity");
    expect(result.isBot).toBe(false);
  });

  it("detects gemini.google.com referrer as gemini", () => {
    const result = detectAiSource(null, "gemini.google.com");
    expect(result.aiSource).toBe("gemini");
  });

  it("detects copilot.microsoft.com referrer as copilot", () => {
    const result = detectAiSource(null, "copilot.microsoft.com");
    expect(result.aiSource).toBe("copilot");
  });

  it("detects you.com referrer", () => {
    const result = detectAiSource(null, "you.com");
    expect(result.aiSource).toBe("you");
  });

  it("detects phind.com referrer", () => {
    const result = detectAiSource(null, "phind.com");
    expect(result.aiSource).toBe("phind");
  });

  it("suffix-matches www subdomain for referrer hosts", () => {
    const result = detectAiSource("Mozilla/5.0 Chrome/120", "www.chatgpt.com");
    expect(result.aiSource).toBe("chatgpt");
  });

  // --- Priority: bot UA wins over referrer ---
  it("bot UA overrides chatgpt.com referrer", () => {
    const result = detectAiSource("GPTBot/1.2", "chatgpt.com");
    expect(result.aiSource).toBe("chatgpt");
    expect(result.isBot).toBe(true);
    expect(result.isCitationClick).toBe(false);
  });

  it("is case-insensitive for UA matching", () => {
    const result = detectAiSource("gptbot/1.2", null);
    expect(result.isBot).toBe(true);
    expect(result.aiSource).toBe("chatgpt");
  });

  it("returns null for unknown referrer host", () => {
    const result = detectAiSource("Mozilla/5.0", "example-blog.com");
    expect(result.aiSource).toBeNull();
    expect(result.isBot).toBe(false);
  });
});
