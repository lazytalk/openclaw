import type { ToolsConfig } from "../config/types.tools.js";
export function resolveArtifactLimits(config?: ToolsConfig["artifacts"]) {
  const limits = {
    maxBytes: config?.maxBytes ?? 512 * 1024 * 1024,
    totalBytes: config?.totalBytes ?? 2 * 1024 * 1024 * 1024,
    maxArtifacts: config?.maxArtifacts ?? 128,
    maxConcurrentTransfers: config?.maxConcurrentTransfers ?? 4,
  };
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
    limits.totalBytes < limits.maxBytes
  ) {
    throw new Error(
      "Artifact quotas must be positive safe integers; totalBytes must be at least maxBytes",
    );
  }
  return Object.freeze({ contractVersion: 2, streaming: true, ...limits });
}
