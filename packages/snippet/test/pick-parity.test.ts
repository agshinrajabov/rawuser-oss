import { PICK_PARAM as SHARED_PICK_PARAM } from "@rawuser/shared/pick";
import { describe, expect, it } from "vitest";
import { PICK_PARAM } from "../src/pick-loader.ts";

describe("pick parameter: snippet copy matches the shared constant", () => {
  it("same name", () => {
    expect(PICK_PARAM).toBe(SHARED_PICK_PARAM);
  });
});
