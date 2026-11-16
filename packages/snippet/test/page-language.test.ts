import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { pageLanguage } from "../src/fetch.ts";

function doc(html: string): Document {
  return new JSDOM(html).window.document;
}
const loc = (pathname: string, hostname = "lumera.test") => ({
  pathname,
  hostname,
  href: `https://${hostname}${pathname}`,
});

describe("pageLanguage", () => {
  it("reads a language path prefix first (/az, /en-us)", () => {
    expect(pageLanguage(loc("/az"), doc('<html lang="en"></html>'))).toBe("az");
    expect(pageLanguage(loc("/en-US/pricing"), doc("<html></html>"))).toBe("en");
    expect(pageLanguage(loc("/az/"), doc("<html></html>"))).toBe("az");
  });

  it("does not mistake an ordinary first segment for a language", () => {
    expect(pageLanguage(loc("/pricing"), doc("<html></html>"))).toBeNull();
    expect(pageLanguage(loc("/vs-agency"), doc("<html></html>"))).toBeNull();
  });

  it("reads a two-letter subdomain, but not www", () => {
    expect(pageLanguage(loc("/", "az.example.com"), doc("<html></html>"))).toBe("az");
    expect(pageLanguage(loc("/", "www.example.com"), doc("<html></html>"))).toBeNull();
  });

  it("reads the hreflang self-link for the current path", () => {
    const d = doc(`<html><head>
      <link rel="alternate" hreflang="en" href="https://lumera.test/">
      <link rel="alternate" hreflang="az" href="https://lumera.test/az">
      <link rel="alternate" hreflang="x-default" href="https://lumera.test/">
    </head></html>`);
    expect(pageLanguage(loc("/"), d)).toBe("en");
  });

  it("falls back to <html lang>", () => {
    expect(pageLanguage(loc("/"), doc('<html lang="az-Latn"></html>'))).toBe("az");
    expect(pageLanguage(loc("/"), doc("<html></html>"))).toBeNull();
  });
});
