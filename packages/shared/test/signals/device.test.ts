import { describe, expect, it } from "vitest";
import { classifyDevice } from "../../src/signals/device.ts";

describe("classifyDevice", () => {
  it("returns desktop for null/undefined UA", () => {
    expect(classifyDevice(null)).toBe("desktop");
    expect(classifyDevice(undefined)).toBe("desktop");
    expect(classifyDevice("")).toBe("desktop");
  });

  it("returns desktop for standard Chrome on Mac UA", () => {
    expect(
      classifyDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("desktop");
  });

  it("returns mobile for iPhone UA", () => {
    expect(
      classifyDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"),
    ).toBe("mobile");
  });

  it("returns mobile for Android phone UA", () => {
    expect(
      classifyDevice(
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("mobile");
  });

  it("returns tablet for iPad UA", () => {
    expect(
      classifyDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15"),
    ).toBe("tablet");
  });

  it("returns tablet for tablet keyword in UA", () => {
    expect(classifyDevice("Mozilla/5.0 (Linux; Android 13; SM-X700 Tablet) Chrome/120")).toBe(
      "tablet",
    );
  });

  it("returns bot for Googlebot", () => {
    expect(
      classifyDevice("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"),
    ).toBe("bot");
  });

  it("returns bot for generic 'bot' substring in UA", () => {
    expect(classifyDevice("SomeCustomBot/1.0")).toBe("bot");
  });

  it("returns bot for Bingbot", () => {
    expect(classifyDevice("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe("bot");
  });

  it("returns bot for spider UA", () => {
    expect(classifyDevice("SomeSpider/1.0 (web crawler)")).toBe("bot");
  });

  it("returns mobile for Windows Phone", () => {
    expect(classifyDevice("Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0)")).toBe("mobile");
  });

  it("tablet takes precedence over mobile (both keywords present)", () => {
    // Some Android tablets include 'mobile' in UA but also 'tablet'
    expect(classifyDevice("Mozilla/5.0 (Android 13; Tablet; Mobile)")).toBe("tablet");
  });
  it("returns bot for Search Console's live test and GoogleOther", () => {
    expect(
      classifyDevice(
        "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.70 Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0;)",
      ),
    ).toBe("bot");
    expect(classifyDevice("Mozilla/5.0 (compatible; GoogleOther)")).toBe("bot");
  });
});
