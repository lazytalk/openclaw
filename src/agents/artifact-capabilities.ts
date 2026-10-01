import { createHash } from "node:crypto";
import type { ToolsConfig } from "../config/types.tools.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { resolveArtifactLimits } from "./artifact-limits.js";
import type { ExecutionWorkspaceBridge } from "./execution-workspace.js";

/** Global health omits workspace availability; that fact belongs to an admitted run. */
export function artifactCapabilities(
  config?: ToolsConfig["artifacts"],
  workspace?: ExecutionWorkspaceBridge,
) {
  const descriptor = {
    ...resolveArtifactLimits(config),
    materialize: Boolean(workspace),
    export: Boolean(workspace),
    backend: workspace?.backend ?? ("unavailable" as const),
    runtimeIdentity: { version: VERSION, buildId: resolveRuntimeServiceBuildId() },
  };
  return Object.freeze({
    ...descriptor,
    signature: createHash("sha256").update(JSON.stringify(descriptor)).digest("hex"),
  });
}
