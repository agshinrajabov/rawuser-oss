import { describe, expect, it } from "vitest";
import { detectAppSource } from "../../src/signals/app-source.ts";

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("detectAppSource", () => {
  it("returns null for a normal mobile Safari UA", () => {
    expect(detectAppSource(IOS_SAFARI)).toBeNull();
  });

  it("returns null for null/empty UA", () => {
    expect(detectAppSource(null)).toBeNull();
    expect(detectAppSource("")).toBeNull();
  });

  it("detects the Instagram in-app browser (Android)", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.54 Mobile Safari/537.36 Instagram 328.0.0.42.90 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; shiba; shiba; en_US; 582826517)";
    expect(detectAppSource(ua)).toEqual({
      app: "instagram",
      channel: "social",
      confidence: "high",
    });
  });

  it("detects the Instagram in-app browser (iOS)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 Instagram 328.0.0.29.85 (iPhone15,2; iOS 17_4_1; en_US; en; scale=3.00; 1179x2556; 583283064)";
    expect(detectAppSource(ua)?.app).toBe("instagram");
  });

  it("detects the Facebook in-app browser via FBAN/FBAV (iOS)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 [FBAN/FBIOS;FBAV/458.0.0.36.109;FBBV/612345678;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]";
    expect(detectAppSource(ua)).toEqual({ app: "facebook", channel: "social", confidence: "high" });
  });

  it("detects the Facebook in-app browser via FB_IAB (Android)", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/123.0.6312.118 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/459.0.0.31.108;]";
    expect(detectAppSource(ua)?.app).toBe("facebook");
  });

  it("keeps Messenger under facebook", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/123.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/450.0.0.44.109;]";
    expect(detectAppSource(ua)?.app).toBe("facebook");
  });

  it("detects the LinkedIn in-app browser", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; SM-S928B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36 LinkedInApp";
    expect(detectAppSource(ua)).toEqual({ app: "linkedin", channel: "social", confidence: "high" });
  });

  it("detects the TikTok in-app browser", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_34.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US";
    expect(detectAppSource(ua)?.app).toBe("tiktok");
    const android =
      "Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.0.0 Mobile Safari/537.36 trill_2023405040 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/34.5.4 ByteLocale/en BytedanceWebview/d8a21c6";
    expect(detectAppSource(android)?.app).toBe("tiktok");
  });

  it("detects the X app browser on both platforms", () => {
    expect(
      detectAppSource(
        "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36 TwitterAndroid",
      )?.app,
    ).toBe("twitter");
    expect(
      detectAppSource(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 Twitter for iPhone/10.34",
      )?.app,
    ).toBe("twitter");
  });

  it("detects Threads via its Barcelona codename", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 Barcelona 328.0.0.0.0 (iPhone15,2; iOS 17_4; en_US; en; scale=3.00; 1179x2556; 583283064)";
    expect(detectAppSource(ua)?.app).toBe("threads");
  });

  it("does not match a desktop Chrome UA that merely visits those sites", () => {
    expect(
      detectAppSource(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ),
    ).toBeNull();
  });

  // --- Layer B: some app, unknown which ---
  it("Sec-CH-UA with the Android WebView brand → unknown app, medium", () => {
    const chromeUa =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";
    expect(
      detectAppSource(
        chromeUa,
        '"Not)A;Brand";v="8", "Chromium";v="138", "Android WebView";v="138"',
      ),
    ).toEqual({ app: "unknown", channel: "app", confidence: "medium" });
    expect(
      detectAppSource(chromeUa, '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"'),
    ).toBeNull();
  });

  it("the wv token in an Android UA → unknown app, medium", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/123.0.6312.118 Mobile Safari/537.36";
    expect(detectAppSource(ua)).toEqual({ app: "unknown", channel: "app", confidence: "medium" });
  });

  it("a named app beats the generic webview rule", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 LinkedInApp";
    expect(detectAppSource(ua)?.app).toBe("linkedin");
  });

  it("iOS WebKit without the Safari token → unknown app, low", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    expect(detectAppSource(ua)).toEqual({ app: "unknown", channel: "app", confidence: "low" });
  });

  it("iOS Safari, SFSafariViewController, Chrome and Firefox on iOS are not webviews", () => {
    expect(detectAppSource(IOS_SAFARI)).toBeNull();
    expect(
      detectAppSource(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1",
      ),
    ).toBeNull();
    expect(
      detectAppSource(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148",
      ),
    ).toBeNull();
  });
});
