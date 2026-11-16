/**
 * Layer G (2026-10-03, docs/specs/source-recovery.md): android-app://
 * referrers, the in-app markers we lacked, the missing AI hosts, Telegram
 * Web and four click-id names. End to end through extractSignals, classify
 * and selectVariantKey where it matters, so each new source is shown to
 * behave like its existing peer.
 *
 * UA strings marked "inapp-spy" are copied verbatim from
 * shalanah/inapp-spy src/tests/mobile.ts (MIT).
 */

import { describe, expect, it } from "vitest";
import { classify } from "../../src/classify/index.ts";
import { selectVariantKey } from "../../src/select/index.ts";
import { parseClickId } from "../../src/signals/click-id.ts";
import { classifyDevice } from "../../src/signals/device.ts";
import { extractSignals } from "../../src/signals/extract.ts";
import { hasMeaningfulSignal } from "../../src/signals/meaningful.ts";
import { isPackageShaped, parseReferrer, parseReferrerHost } from "../../src/signals/referrer.ts";
import {
  APP_PACKAGES,
  isUnknownReferrerHost,
  matchAppPackage,
  matchReferrerHost,
} from "../../src/signals/source-vocabulary.ts";

// inapp-spy fixtures.
const UA = {
  facebookIosMetaIab:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22G100 Safari/604.1 MetaIAB Facebook",
  facebookIosFban:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 [FBAN/FBIOS;FBAV/488.0.0.68.101;FBBV/658219612;FBDV/iPhone12,8;FBMD/iPhone;FBSN/iOS;FBSV/18.1;FBSS/2;FBID/phone;FBLC/en_US;FBOP/5;FBRV/0;IABMV/1]",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.83 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/488.0.0.62.79;IABMV/1;]",
  instagramIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76 Instagram 393.1.0.36.70 (iPhone15,3; iOS 18_5; en_US; en; scale=3.00; 1290x2796; IABMV/1; 776538208) Safari/604.1)",
  whatsappIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0.1 Mobile/15E148 Safari/604.1 [WAiOS/2.25.31]",
  whatsappAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.124 Mobile Safari/537.36 [WA4A/2.25.32.75;]",
  redditAndroid15:
    "Mozilla/5.0 (Linux; Android 15; 23129RN51X Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/148.0.7778.215 Mobile Safari/537.36 Reddit/Version 2026.23.0/Build 2623040/Android 15",
  redditAndroid14:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 Reddit/Version 2024.41.0/Build 2102450/Android 14",
  googleAppIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/334.0.674067880 Mobile/15E148 Safari/604.1",
};

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

/** Signals for a /select request carrying the page's referrer as `ref`, like the snippet sends. */
function visit(opts: { ref?: string; ua?: string; query?: string }) {
  const url = new URL(`https://customer.example/select${opts.query ? `?${opts.query}` : ""}`);
  if (opts.ref !== undefined) url.searchParams.set("ref", opts.ref);
  return extractSignals({
    url,
    headers: new Headers(opts.ua ? { "user-agent": opts.ua } : {}),
    selfHost: "customer.example",
  });
}

function sourceOf(opts: { ref?: string; ua?: string; query?: string }) {
  const signals = visit(opts);
  const vector = classify(signals, Date.UTC(2026, 9, 3, 12), "UTC");
  return { signals, vector, selection: selectVariantKey(vector) };
}

// ---------------------------------------------------------------------------
// G1. android-app:// referrers
// ---------------------------------------------------------------------------

describe("Layer G1: parseReferrer on android-app:// referrers", () => {
  it("keeps a package id as the host and marks it as an app", () => {
    expect(parseReferrer("android-app://com.facebook.katana/")).toEqual({
      host: "com.facebook.katana",
      isApp: true,
    });
    // The legacy helper still returns the bare authority, never a path.
    expect(parseReferrerHost("android-app://com.google.android.gm/some/path?x=1")).toBe(
      "com.google.android.gm",
    );
  });

  it("lowercases the package id (Slack's Play id is com.Slack)", () => {
    expect(parseReferrer("android-app://com.Slack/")).toEqual({ host: "com.slack", isApp: true });
  });

  it("treats a hostname authority as a web host", () => {
    expect(parseReferrer("android-app://m.facebook.com/")).toEqual({
      host: "m.facebook.com",
      isApp: false,
    });
    expect(parseReferrer("android-app://perplexity.ai/")?.isApp).toBe(false);
    expect(parseReferrer("android-app://id.pinterest.com/")?.isApp).toBe(false);
  });

  it("never marks an http(s) referrer as an app", () => {
    expect(parseReferrer("https://mastodon.social/@x")).toEqual({
      host: "mastodon.social",
      isApp: false,
    });
  });

  it("decides the authority shape by where the TLD-like label sits", () => {
    expect(isPackageShaped("com.example.app")).toBe(true);
    expect(isPackageShaped("org.telegram.messenger")).toBe(true);
    expect(isPackageShaped("jp.naver.line.android")).toBe(true);
    expect(isPackageShaped("ai.perplexity.app.android")).toBe(true);
    expect(isPackageShaped("app.example.com")).toBe(false);
    expect(isPackageShaped("m.facebook.com")).toBe(false);
    expect(isPackageShaped("perplexity.ai")).toBe(false);
    expect(isPackageShaped("t3.chat")).toBe(false);
  });
});

describe("Layer G1: the package table is exact", () => {
  it("has 29 rows, every key lowercase and package-shaped", () => {
    const keys = Object.keys(APP_PACKAGES);
    expect(keys).toHaveLength(29);
    for (const k of keys) {
      expect(k).toBe(k.toLowerCase());
      expect(isPackageShaped(k)).toBe(true);
    }
  });

  it.each([
    ["com.facebook.katana", "social"],
    ["com.facebook.orca", "social"],
    ["com.instagram.android", "social"],
    ["com.linkedin.android", "social"],
    ["com.twitter.android", "social"],
    ["com.zhiliaoapp.musically", "social"],
    ["com.ss.android.ugc.trill", "social"],
    ["com.pinterest", "social"],
    ["com.snapchat.android", "social"],
    ["org.telegram.messenger", "social"],
    ["com.whatsapp", "social"],
    ["com.reddit.frontpage", "community"],
    ["com.discord", "community"],
    ["com.slack", "community"],
    ["com.google.android.gm", "email"],
    ["com.microsoft.office.outlook", "email"],
    ["com.google.android.googlequicksearchbox", "organic"],
    ["com.google.android.apps.searchlite", "organic"],
    ["com.openai.chatgpt", "ai"],
    ["com.anthropic.claude", "ai"],
    ["ai.perplexity.app.android", "ai"],
    ["com.google.android.apps.bard", "ai"],
  ])("%s → %s", (pkg, channel) => {
    expect(matchAppPackage(pkg)?.channel).toBe(channel);
    expect(matchReferrerHost(pkg, true)?.channel).toBe(channel);
  });

  it("Gmail is email and the Google app is organic, never Google paid search", () => {
    expect(matchReferrerHost("com.google.android.gm", true)).toEqual({
      channel: "email",
      source: "gmail",
      by: "exact",
    });
    expect(matchReferrerHost("com.google.android.googlequicksearchbox", true)?.channel).toBe(
      "organic",
    );
  });

  it("never substring- or suffix-matches an unknown package id", () => {
    // Shaped to hit the country-coded Google pattern if it were a host.
    expect(matchReferrerHost("com.google.earth")?.channel).toBe("organic");
    expect(matchReferrerHost("com.google.earth", true)).toBeNull();
    expect(matchReferrerHost("com.google.android.apps.docs", true)).toBeNull();
    expect(matchAppPackage("com.facebook")).toBeNull();
    expect(matchAppPackage("com.facebook.katana.beta")).toBeNull();
    expect(isUnknownReferrerHost("com.google.earth", true)).toBe(true);
    expect(isUnknownReferrerHost("com.facebook.katana", true)).toBe(false);
  });
});

describe("Layer G1: android-app referrers through extract, classify and select", () => {
  it("Facebook app → social, meaningful", () => {
    const { signals, selection } = sourceOf({
      ref: "android-app://com.facebook.katana/",
      ua: CHROME_ANDROID,
    });
    expect(signals.referrerHost).toBe("com.facebook.katana");
    expect(signals.referrerIsApp).toBe(true);
    expect(hasMeaningfulSignal(signals)).toBe(true);
    expect(selection.source_dim).toBe("social");
  });

  it("LinkedIn, Telegram and WhatsApp apps → social", () => {
    for (const pkg of ["com.linkedin.android", "org.telegram.messenger", "com.whatsapp"]) {
      expect(
        sourceOf({ ref: `android-app://${pkg}/`, ua: CHROME_ANDROID }).selection.source_dim,
      ).toBe("social");
    }
  });

  it("Reddit app → community with technical depth, like reddit.com", () => {
    const app = sourceOf({ ref: "android-app://com.reddit.frontpage/", ua: CHROME_ANDROID });
    const web = sourceOf({ ref: "https://www.reddit.com/r/SaaS/", ua: CHROME_ANDROID });
    expect(app.selection.source_dim).toBe("community");
    expect(app.vector.source).toEqual(web.vector.source);
    expect(app.vector.context.technical_depth).toBe(web.vector.context.technical_depth);
  });

  it("Google app → organic, like google.com", () => {
    const app = sourceOf({
      ref: "android-app://com.google.android.googlequicksearchbox/",
      ua: CHROME_ANDROID,
    });
    const web = sourceOf({ ref: "https://www.google.com/", ua: CHROME_ANDROID });
    expect(app.selection.source_dim).toBe("organic");
    expect(app.vector.source).toEqual(web.vector.source);
    expect(app.vector.intent).toEqual(web.vector.intent);
  });

  it("Gmail app → the same vector as a mail.google.com referrer", () => {
    const app = sourceOf({ ref: "android-app://com.google.android.gm/", ua: CHROME_ANDROID });
    const web = sourceOf({ ref: "https://mail.google.com/mail/u/0/", ua: CHROME_ANDROID });
    expect(app.vector.source).toEqual(web.vector.source);
    expect(app.vector.intent).toEqual(web.vector.intent);
    expect(app.selection.source_dim).toBe(web.selection.source_dim);
  });

  it("ChatGPT, Claude, Perplexity and Gemini apps → source.ai with the product named", () => {
    const cases: Array<[string, string]> = [
      ["com.openai.chatgpt", "chatgpt"],
      ["com.anthropic.claude", "claude"],
      ["ai.perplexity.app.android", "perplexity"],
      ["com.google.android.apps.bard", "gemini"],
    ];
    for (const [pkg, ai] of cases) {
      const { signals, selection } = sourceOf({ ref: `android-app://${pkg}/`, ua: CHROME_ANDROID });
      expect(signals.aiSource).toBe(ai);
      expect(selection.source_dim).toBe("ai");
    }
  });

  it("android-app://m.facebook.com still lands as social through host matching", () => {
    const { signals, selection } = sourceOf({
      ref: "android-app://m.facebook.com/",
      ua: CHROME_ANDROID,
    });
    expect(signals.referrerHost).toBe("m.facebook.com");
    expect(signals.referrerIsApp).toBeUndefined();
    expect(selection.source_dim).toBe("social");
  });

  it("android-app://perplexity.ai (a hostname authority) is AI through the host table", () => {
    expect(
      sourceOf({ ref: "android-app://perplexity.ai/", ua: CHROME_ANDROID }).signals.aiSource,
    ).toBe("perplexity");
  });

  it("an unknown package is meaningful (a referrer) but never guessed into a channel", () => {
    const { signals, vector, selection } = sourceOf({
      ref: "android-app://com.google.earth/",
      ua: CHROME_ANDROID,
    });
    expect(signals.referrerIsApp).toBe(true);
    expect(hasMeaningfulSignal(signals)).toBe(true);
    expect(vector.source.organic).toBe(0);
    expect(selection.source_dim).toBe("direct");
  });

  it("a web referrer's Signals carry no referrerIsApp key", () => {
    expect("referrerIsApp" in visit({ ref: "https://news.ycombinator.com/" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G2. In-app UA markers
// ---------------------------------------------------------------------------

describe("Layer G2: UA markers from inapp-spy fixtures", () => {
  it("Facebook iOS with only 'MetaIAB Facebook' → facebook, social", () => {
    const s = visit({ ua: UA.facebookIosMetaIab });
    expect(s.appSource).toEqual({ app: "facebook", channel: "social", confidence: "high" });
    expect(hasMeaningfulSignal(s)).toBe(true);
    expect(sourceOf({ ua: UA.facebookIosMetaIab }).selection.source_dim).toBe("social");
  });

  it("WhatsApp iOS [WAiOS/ and Android [WA4A/ → whatsapp, social, a phone, not a bot", () => {
    for (const ua of [UA.whatsappIos, UA.whatsappAndroid]) {
      const s = visit({ ua });
      expect(s.appSource).toEqual({ app: "whatsapp", channel: "social", confidence: "high" });
      expect(s.device).toBe("mobile");
      expect(classifyDevice(ua)).toBe("mobile");
      expect(sourceOf({ ua }).selection.source_dim).toBe("social");
    }
  });

  it("Reddit Android → reddit, community, like a reddit.com referrer", () => {
    for (const ua of [UA.redditAndroid15, UA.redditAndroid14]) {
      const s = visit({ ua });
      expect(s.appSource).toEqual({ app: "reddit", channel: "community", confidence: "high" });
      expect(hasMeaningfulSignal(s)).toBe(true);
      const { vector, selection } = sourceOf({ ua });
      expect(selection.source_dim).toBe("community");
      expect(vector.source.community).toBe(0.85);
      expect(vector.context.technical_depth).toBe(0.65);
      expect(vector.intent.brand).toBe(0);
    }
  });

  it("Google app GSA/ → google, organic, never social", () => {
    const s = visit({ ua: UA.googleAppIos });
    expect(s.appSource).toEqual({ app: "google", channel: "organic", confidence: "high" });
    expect(hasMeaningfulSignal(s)).toBe(true);
    const { vector, selection } = sourceOf({ ua: UA.googleAppIos });
    expect(selection.source_dim).toBe("organic");
    expect(vector.source.social).toBe(0);
    expect(vector.source.organic).toBe(0.8);
    expect(vector.intent.brand).toBe(0);
  });

  it("IABMV/1 does not shadow the named Meta apps", () => {
    expect(visit({ ua: UA.instagramIos }).appSource?.app).toBe("instagram");
    expect(visit({ ua: UA.facebookIosFban }).appSource?.app).toBe("facebook");
    expect(visit({ ua: UA.facebookAndroid }).appSource?.app).toBe("facebook");
  });

  it("IABMV/1 alone falls back to a Meta app, social", () => {
    // Constructed: the Facebook iOS fixture with its FB* tokens removed, so
    // only Meta's in-app marker is left.
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 [IABMV/1]";
    expect(visit({ ua }).appSource).toEqual({ app: "meta", channel: "social", confidence: "high" });
  });
});

describe("Layer G2: an in-app social UA counts as social whatever the referrer", () => {
  const socialUas = [UA.facebookIosMetaIab, UA.whatsappIos, UA.whatsappAndroid, UA.instagramIos];

  it("with an unknown site B as referrer (the multi-hop case)", () => {
    for (const ua of socialUas) {
      expect(sourceOf({ ua, ref: "https://some-blog.example/post" }).selection.source_dim).toBe(
        "social",
      );
    }
  });

  it("against a community referrer (tie at 0.85, social first in tuple order)", () => {
    for (const ua of socialUas) {
      expect(sourceOf({ ua, ref: "https://news.ycombinator.com/" }).selection.source_dim).toBe(
        "social",
      );
    }
  });

  it("against an organic referrer", () => {
    for (const ua of socialUas) {
      expect(sourceOf({ ua, ref: "https://www.google.com/" }).selection.source_dim).toBe("social");
    }
  });

  it("against an unknown android-app package referrer", () => {
    expect(
      sourceOf({ ua: UA.whatsappAndroid, ref: "android-app://com.google.earth/" }).selection
        .source_dim,
    ).toBe("social");
  });
});

// ---------------------------------------------------------------------------
// G3. Hosts and click-id names
// ---------------------------------------------------------------------------

describe("Layer G3: AI hosts", () => {
  it.each([
    ["copilot.cloud.microsoft", "copilot"],
    ["copilot.com", "copilot"],
    ["pplx.ai", "perplexity"],
    ["deepseek.com", "deepseek"],
    ["platform.deepseek.com", "deepseek"],
    ["notebooklm.google.com", "notebooklm"],
    ["notebook.google.com", "notebooklm"],
    ["character.ai", "characterai"],
    ["chatglm.cn", "chatglm"],
    ["iask.ai", "iask"],
    ["www.genspark.ai", "genspark"],
    ["felo.ai", "felo"],
    ["t3.chat", "t3chat"],
    ["venice.ai", "venice"],
    ["lumo.proton.me", "lumo"],
    ["manus.im", "manus"],
    ["www.doubao.com", "doubao"],
    ["yuanbao.tencent.com", "yuanbao"],
    ["giga.chat", "gigachat"],
  ])("%s → ai (%s)", (host, ai) => {
    expect(matchReferrerHost(host)).toEqual({ channel: "ai", source: ai, by: "exact" });
    const { signals, selection } = sourceOf({ ref: `https://${host}/` });
    expect(signals.aiSource).toBe(ai);
    expect(selection.source_dim).toBe("ai");
  });

  it("next to the NotebookLM hosts, google.com stays organic and mail.google.com email", () => {
    expect(matchReferrerHost("google.com")?.channel).toBe("organic");
    expect(matchReferrerHost("mail.google.com")?.channel).toBe("email");
  });
});

describe("Layer G3: Telegram Web", () => {
  it("web.telegram.org → social", () => {
    expect(matchReferrerHost("web.telegram.org")?.channel).toBe("social");
    expect(sourceOf({ ref: "https://web.telegram.org/k/" }).selection.source_dim).toBe("social");
  });
});

describe("Layer G3: click-id names (presence only)", () => {
  it.each([
    ["gclsrc", "google-ads", "paid-search"],
    ["qclid", "quora", "paid-social"],
    ["irclid", "impact", "affiliate"],
    ["_kx", "klaviyo", "email"],
  ])("%s → %s / %s, from clk and from the raw name", (name, platform, family) => {
    expect(parseClickId(new URL(`https://x.example/select?clk=${name}`))).toEqual({
      platform,
      family,
    });
    expect(parseClickId(new URL(`https://x.example/?${name}=VALUE-NEVER-READ`))).toEqual({
      platform,
      family,
    });
  });

  it("the value never reaches Signals", () => {
    const s = visit({ query: "_kx=AAAAbbbb1111CCCC-dddd2222EEEEffff3333GGGGhh%3D.Ab12C" });
    expect(s.clickId).toBe("klaviyo");
    expect(s.linkFamily).toBe("email");
    expect(JSON.stringify(s)).not.toContain("AAAAbbbb");
  });

  it("each new name moves the vector like its family's peer", () => {
    const peer = (q: string) => sourceOf({ query: `clk=${q}` }).vector.source;
    expect(peer("gclsrc")).toEqual(peer("gclid"));
    expect(peer("qclid")).toEqual(peer("rdt_cid"));
    expect(peer("irclid")).toEqual(peer("irclickid"));
    expect(peer("_kx")).toEqual(peer("mc_eid"));
    expect(hasMeaningfulSignal(visit({ query: "clk=qclid" }))).toBe(true);
  });
});
