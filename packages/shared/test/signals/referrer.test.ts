import { describe, expect, it } from "vitest";
import { parseReferrerHost } from "../../src/signals/referrer.ts";

describe("parseReferrerHost", () => {
  it("returns null for missing/empty input", () => {
    expect(parseReferrerHost(null)).toBeNull();
    expect(parseReferrerHost(undefined)).toBeNull();
    expect(parseReferrerHost("")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseReferrerHost("not a url")).toBeNull();
    expect(parseReferrerHost("://broken")).toBeNull();
  });

  it("returns host only — no path, no query, no fragment", () => {
    expect(parseReferrerHost("https://chatgpt.com/c/some-chat")).toBe("chatgpt.com");
    expect(parseReferrerHost("https://example.com/secret?email=a@b.test")).toBe("example.com");
    expect(parseReferrerHost("https://g2.com/products/rawuser/reviews?page=2#anchor")).toBe(
      "g2.com",
    );
  });

  it("lowercases the host", () => {
    expect(parseReferrerHost("https://CHATGPT.COM/chat")).toBe("chatgpt.com");
  });

  it("returns null for same-origin referrer", () => {
    expect(parseReferrerHost("https://mysite.com/other-page", "mysite.com")).toBeNull();
  });

  it("returns null for www subdomain of same origin", () => {
    expect(parseReferrerHost("https://www.mysite.com/page", "mysite.com")).toBeNull();
    expect(parseReferrerHost("https://mysite.com/page", "www.mysite.com")).toBeNull();
  });

  it("returns null for sub-subdomain of same origin", () => {
    expect(parseReferrerHost("https://app.mysite.com/page", "mysite.com")).toBeNull();
  });

  it("does NOT return null for different domains", () => {
    expect(parseReferrerHost("https://otherdomain.com/page", "mysite.com")).toBe("otherdomain.com");
  });

  it("privacy invariant: returned string never contains ? or /", () => {
    const result = parseReferrerHost("https://example.com/secret?email=a@b.test");
    expect(result).not.toContain("?");
    expect(result).not.toContain("/");
  });

  it("handles referrer with port (strips port from hostname)", () => {
    // URL.hostname does not include the port
    const result = parseReferrerHost("https://example.com:8080/page");
    expect(result).toBe("example.com");
    expect(result).not.toContain(":");
  });

  it("handles www. prefix in referrer", () => {
    expect(parseReferrerHost("https://www.g2.com/reviews")).toBe("www.g2.com");
  });
});
