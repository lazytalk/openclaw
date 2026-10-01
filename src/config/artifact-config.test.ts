import { describe, expect, it } from "vitest";
import { resolveArtifactLimits } from "../agents/artifact-limits.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
describe("managed artifact host configuration", () => {
  it("accepts generic larger quotas and resolves documented defaults", () => {
    expect(resolveArtifactLimits()).toMatchObject({
      maxBytes: 536870912,
      totalBytes: 2147483648,
      maxArtifacts: 128,
      maxConcurrentTransfers: 4,
    });
    const config = {
      artifacts: { maxBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3, maxConcurrentTransfers: 2 },
    };
    expect(ToolsSchema.safeParse(config).success).toBe(true);
    expect(resolveArtifactLimits(config.artifacts).maxBytes).toBe(1024 ** 3);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe quota %s", (value) => {
    expect(ToolsSchema.safeParse({ artifacts: { maxBytes: value } }).success).toBe(false);
    expect(() => resolveArtifactLimits({ maxBytes: value })).toThrow();
  });
  it("rejects a total reservation below the per-file ceiling", () => {
    expect(() => resolveArtifactLimits({ maxBytes: 100, totalBytes: 99 })).toThrow("totalBytes");
  });
});
