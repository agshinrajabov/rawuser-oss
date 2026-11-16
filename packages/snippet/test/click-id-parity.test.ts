import { CLICK_ID_PARAM_NAMES } from "@rawuser/shared/signals/click-id";
import { describe, expect, it } from "vitest";
import { CLICK_ID_NAMES } from "../src/fetch.ts";

describe("tracked-link names: snippet copy matches the edge's table", () => {
  it("same names, same order", () => {
    expect([...CLICK_ID_NAMES]).toEqual([...CLICK_ID_PARAM_NAMES]);
  });
});
