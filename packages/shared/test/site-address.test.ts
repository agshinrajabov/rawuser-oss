import { describe, expect, it } from "vitest";
import { isLocalHost, siteOrigin } from "../src/site-address.ts";

describe("a site's address from the domain as typed", () => {
  it("a bare domain is https, without its path, lowercased", () => {
    expect(siteOrigin("example.com")).toBe("https://example.com");
    expect(siteOrigin(" Example.com/pricing?x=1 ")).toBe("https://example.com");
    expect(siteOrigin("https://www.example.com/")).toBe("https://www.example.com");
    expect(siteOrigin("example.com:8443")).toBe("https://example.com:8443");
  });

  it("an address typed with http keeps it", () => {
    expect(siteOrigin("http://staging.example.com/")).toBe("http://staging.example.com");
    expect(siteOrigin("HTTP://Staging.example.com")).toBe("http://staging.example.com");
  });

  it("a site on this machine is http unless typed otherwise", () => {
    expect(siteOrigin("localhost:4100")).toBe("http://localhost:4100");
    expect(siteOrigin("localhost")).toBe("http://localhost");
    expect(siteOrigin("127.0.0.1:3000/app")).toBe("http://127.0.0.1:3000");
    expect(siteOrigin("shop.localhost:8080")).toBe("http://shop.localhost:8080");
    expect(siteOrigin("https://localhost:4100")).toBe("https://localhost:4100");
  });

  it("knows this machine by its names, and nothing that only looks like them", () => {
    for (const h of [
      "localhost",
      "LOCALHOST:4100",
      "a.localhost",
      "127.0.0.1",
      "127.8.9.1:80",
      "[::1]:3000",
      "http://localhost/x",
    ])
      expect(isLocalHost(h), h).toBe(true);
    for (const h of [
      "localhost.example.com",
      "example.com",
      "mylocalhost",
      "128.0.0.1",
      "10.0.0.1",
      "192.168.1.5",
    ])
      expect(isLocalHost(h), h).toBe(false);
  });
});
