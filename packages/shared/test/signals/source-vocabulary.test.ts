import { describe, expect, it } from "vitest";
import {
  isUnknownReferrerHost,
  isUnknownUtmSource,
  matchReferrerHost,
  matchUtmMedium,
  matchUtmSource,
} from "../../src/signals/source-vocabulary.ts";

describe("matchUtmSource", () => {
  it("names the AI product from ChatGPT's own tag and from free-form values", () => {
    expect(matchUtmSource("chatgpt.com")).toEqual({
      channel: "ai",
      source: "chatgpt",
      by: "exact",
    });
    expect(matchUtmSource("ChatGPT-iOS")).toMatchObject({
      channel: "ai",
      source: "chatgpt",
      by: "pattern",
    });
    expect(matchUtmSource("perplexity")).toMatchObject({ channel: "ai", source: "perplexity" });
    expect(matchUtmSource("claude.ai")).toMatchObject({ channel: "ai", source: "claude" });
    expect(matchUtmSource("grok")).toMatchObject({ channel: "ai", source: "grok" });
    expect(matchUtmSource("meta.ai")).toMatchObject({ channel: "ai", source: "meta" });
  });

  it("recognises social platforms exactly and by pattern, paid by shape, email tools", () => {
    expect(matchUtmSource("linkedin")).toMatchObject({
      channel: "social",
      source: "linkedin",
      by: "exact",
    });
    expect(matchUtmSource("linkedin_newsletter")).toMatchObject({
      channel: "social",
      source: "linkedin",
      by: "pattern",
    });
    expect(matchUtmSource("fb")).toMatchObject({ channel: "social", source: "facebook" });
    expect(matchUtmSource("google-ads")).toMatchObject({ channel: "paid" });
    expect(matchUtmSource("fbads")).toMatchObject({ channel: "paid" });
    expect(matchUtmSource("mailchimp")).toMatchObject({ channel: "email" });
    expect(matchUtmSource("google")).toMatchObject({ channel: "organic", source: "google" });
  });

  it("returns null for values nothing recognises (those are counted for learning)", () => {
    expect(matchUtmSource("partner-xyz")).toBeNull();
    expect(matchUtmSource("")).toBeNull();
    expect(isUnknownUtmSource("partner-xyz")).toBe(true);
    expect(isUnknownUtmSource("chatgpt.com")).toBe(false);
  });
});

describe("matchUtmMedium", () => {
  it("maps paid, ai, email, social and organic mediums", () => {
    expect(matchUtmMedium("cpc")?.channel).toBe("paid");
    expect(matchUtmMedium("paid_social")?.channel).toBe("paid");
    expect(matchUtmMedium("ai-assistant")?.channel).toBe("ai");
    expect(matchUtmMedium("newsletter")?.channel).toBe("email");
    expect(matchUtmMedium("organic-social")?.channel).toBe("social");
    expect(matchUtmMedium("seo")?.channel).toBe("organic");
    expect(matchUtmMedium("banana")).toBeNull();
  });
});

describe("matchReferrerHost", () => {
  it("maps AI, social, community, search and country-coded Google", () => {
    expect(matchReferrerHost("www.chatgpt.com")).toMatchObject({
      channel: "ai",
      source: "chatgpt",
    });
    expect(matchReferrerHost("grok.com")).toMatchObject({ channel: "ai", source: "grok" });
    expect(matchReferrerHost("chat.deepseek.com")).toMatchObject({
      channel: "ai",
      source: "deepseek",
    });
    expect(matchReferrerHost("l.facebook.com")?.channel).toBe("social");
    expect(matchReferrerHost("bsky.app")?.channel).toBe("social");
    expect(matchReferrerHost("news.ycombinator.com")?.channel).toBe("community");
    expect(matchReferrerHost("www.google.co.uk")).toMatchObject({
      channel: "organic",
      source: "google",
    });
    expect(matchReferrerHost("yandex.ru")?.channel).toBe("organic");
    expect(matchReferrerHost("mail.google.com")?.channel).toBe("email");
    expect(isUnknownReferrerHost("some-partner.example")).toBe(true);
  });
});
