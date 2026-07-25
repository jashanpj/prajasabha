import { describe, expect, it } from "vitest";
import { APP_NAME } from "./index";

describe("packages/shared entrypoint", () => {
  it("exports APP_NAME", () => {
    expect(APP_NAME).toBe("PrajaSabha");
  });
});
