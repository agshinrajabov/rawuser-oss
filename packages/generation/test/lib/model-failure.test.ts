import { describe, expect, it } from "vitest";
import { modelFailure } from "../../src/lib/model-failure.ts";

describe("why a model call failed, as a word the operator can act on", () => {
  it("a reasoning model that spent its whole answer thinking", () => {
    expect(modelFailure("Model output truncated at max_tokens=4096 (content 0 chars)")).toBe(
      "model_empty",
    );
    // Cut mid-answer is another fault: there was an answer.
    expect(
      modelFailure("Model output truncated at max_tokens=4096 (content 812 chars)"),
    ).toBeNull();
  });

  it("nothing set, a refused key, no answer", () => {
    expect(modelFailure("The model is not configured")).toBe("model_not_configured");
    expect(modelFailure("Workers AI binding is not configured")).toBe("model_not_configured");
    expect(modelFailure("Model request failed: HTTP 401")).toBe("model_refused");
    expect(modelFailure("Model request failed: HTTP 403")).toBe("model_refused");
    expect(modelFailure("Model request failed: HTTP 503")).toBe("model_silent");
    expect(modelFailure("The operation was aborted due to timeout")).toBe("model_silent");
  });

  it("anything else is not a model fault it can name", () => {
    expect(modelFailure("Unexpected token < in JSON")).toBeNull();
    expect(modelFailure("")).toBeNull();
  });
});
