import { describe, expect, it } from "vitest";
import { parseUtm } from "../../src/signals/utm.ts";

describe("parseUtm", () => {
  it("returns empty object for URL with no UTM params", () => {
    expect(parseUtm(new URL("https://example.com/page"))).toEqual({});
  });

  it("extracts all five UTM parameters", () => {
    const url = new URL(
      "https://example.com/?utm_source=google&utm_medium=cpc&utm_campaign=enterprise&utm_term=rawuser&utm_content=ad1",
    );
    expect(parseUtm(url)).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "enterprise",
      term: "rawuser",
      content: "ad1",
    });
  });

  it("lower-cases values", () => {
    const url = new URL("https://example.com/?utm_campaign=Enterprise&utm_source=Google");
    const result = parseUtm(url);
    expect(result.campaign).toBe("enterprise");
    expect(result.source).toBe("google");
  });

  it("is case-insensitive on key names", () => {
    const url = new URL("https://example.com/?UTM_CAMPAIGN=test&UTM_SOURCE=google");
    const result = parseUtm(url);
    expect(result.campaign).toBe("test");
    expect(result.source).toBe("google");
  });

  it("trims whitespace from values", () => {
    const url = new URL("https://example.com/?utm_campaign=%20enterprise%20&utm_source=%20g%20");
    const result = parseUtm(url);
    expect(result.campaign).toBe("enterprise");
    expect(result.source).toBe("g");
  });

  it("drops empty strings after trim", () => {
    const url = new URL("https://example.com/?utm_campaign=%20&utm_source=google");
    const result = parseUtm(url);
    expect(result.campaign).toBeUndefined();
    expect(result.source).toBe("google");
  });

  it("only extracts the five standard UTM params", () => {
    const url = new URL("https://example.com/?utm_campaign=test&utm_custom=ignored&other=param");
    const result = parseUtm(url);
    expect(result.campaign).toBe("test");
    expect(Object.keys(result)).toEqual(["campaign"]);
  });

  it("returns only keys with values (no undefined keys in object)", () => {
    const url = new URL("https://example.com/?utm_source=newsletter");
    const result = parseUtm(url);
    expect(Object.keys(result)).toEqual(["source"]);
  });
});
