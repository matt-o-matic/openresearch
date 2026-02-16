import { describe, expect, it } from "vitest";

import { OPENRESEARCH_VERSION } from "./index.js";

describe("@openresearch/core", () => {
  it("exports a semver version", () => {
    expect(OPENRESEARCH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
