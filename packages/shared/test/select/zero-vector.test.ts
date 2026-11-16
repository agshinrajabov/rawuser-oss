import { describe, expect, it } from "vitest";
import { classify } from "../../src/classify/index.ts";
import { selectVariantKey } from "../../src/select/index.ts";
import { extractSignals } from "../../src/signals/extract.ts";

describe("selectVariantKey with no evidence", () => {
  it("an unrecognised utm_source lands on direct, never on the first source dim", () => {
    const s = extractSignals({
      url: new URL("https://edge.test/select?customer_id=c&utm_source=partner-xyz"),
      headers: new Headers({ "user-agent": "Mozilla/5.0 Chrome/128" }),
      cf: null,
    });
    const v = classify(s, Date.now(), null);
    expect(Object.values(v.source).every((x) => x === 0)).toBe(true);
    expect(selectVariantKey(v).source_dim).toBe("direct");
  });
});
