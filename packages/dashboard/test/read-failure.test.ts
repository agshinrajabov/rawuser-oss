import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import { READ_FAILED, readFailureLine } from "../src/lib/read-failure";

const failure = (status: number, body: unknown) =>
  new ApiError(status, `API error ${status}: ${JSON.stringify(body)}`);

describe("what the first-run screen says when reading the page fails", () => {
  it("names the model fault and the setting, when the API gives a reason", () => {
    const line = readFailureLine(
      failure(500, { error: "Element detection failed", reason: "model_empty" }),
    );
    expect(line).toContain("reasoning");
    expect(line).toContain("MODEL_EXTRA_BODY");
    expect(
      readFailureLine(failure(500, { error: "Element detection failed", reason: "model_refused" })),
    ).toContain("MODEL_API_KEY");
    expect(
      readFailureLine(
        failure(500, { error: "Element detection failed", reason: "model_not_configured" }),
      ),
    ).toContain("No model is set");
  });

  it("with no reason, a plain line and never the API's own words", () => {
    const line = readFailureLine(failure(500, { error: "Element detection failed" }));
    expect(line).toBe(READ_FAILED);
    expect(line).not.toContain("API error");
    expect(line).not.toContain("{");
  });

  it("a code is turned into a sentence, and a sentence the API wrote is kept", () => {
    expect(readFailureLine(failure(409, { error: "no_capture" }))).toBe(
      "The look at your page has expired. Open your page again.",
    );
    expect(
      readFailureLine(
        failure(409, { error: "This page is outside the sections kept for this site" }),
      ),
    ).toBe("This page is outside the sections kept for this site.");
    expect(readFailureLine(failure(409, { error: "some_other_code" }))).toBe(READ_FAILED);
  });

  it("an unknown reason, a body that is not JSON, or no error at all: the plain line", () => {
    expect(readFailureLine(failure(500, { error: "x y", reason: "brand_new" }))).toBe("x y.");
    expect(readFailureLine(new ApiError(502, "API error 502: <html>bad gateway</html>"))).toBe(
      READ_FAILED,
    );
    expect(readFailureLine(new Error("Failed to fetch"))).toBe(READ_FAILED);
    expect(readFailureLine(null)).toBe(READ_FAILED);
  });
});
