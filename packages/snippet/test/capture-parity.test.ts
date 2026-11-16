import { CAPTURE_PARAM as SHARED_CAPTURE_PARAM } from "@rawuser/shared/capture";
import { describe, expect, it } from "vitest";
import { CAPTURE_PARAM } from "../src/capture.ts";

describe("capture parameter: snippet copy matches the shared constant", () => {
  it("same name", () => {
    expect(CAPTURE_PARAM).toBe(SHARED_CAPTURE_PARAM);
  });
});
