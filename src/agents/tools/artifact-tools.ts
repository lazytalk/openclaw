import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import type { PluginToolFiles } from "../../plugins/tool-files.types.js";
import { jsonResult, readToolStringParam, type AnyAgentTool } from "./common.js";

/** Sandbox file transfer tools return metadata only; binary data stays with the host. */
export function createArtifactTools(files: PluginToolFiles): AnyAgentTool[] {
  return [
    {
      name: "artifact_materialize",
      label: "Materialize artifact",
      description:
        "Copy a managed artifact into the active execution workspace for binary processing. Returns workspacePath, backend and size (sandboxPath is a compatibility alias). Restricted-host paths are generated and confined to this run. References expire; import the source again when unavailable.",
      parameters: Type.Object({ artifactRef: Type.String() }),
      async execute(_id, input, signal) {
        const params = asNonArrayRecord(input) ?? {};
        const artifactRef = readToolStringParam(params, "artifactRef", { required: true });
        return jsonResult(await files.materialize({ artifactRef, signal }));
      },
    },
    {
      name: "artifact_export",
      label: "Export artifact",
      description:
        "Capture a file confined to the active execution workspace as an immutable managed artifact for upload. Use workspacePath from materialization; sandboxPath is accepted for compatibility. Rejects traversal and external paths. Returns an opaque reference and SHA-256, never binary content. Bounded by tools.artifacts.maxBytes (512 MiB by default).",
      parameters: Type.Object({
        workspacePath: Type.Optional(Type.String()),
        sandboxPath: Type.Optional(Type.String()),
        fileName: Type.Optional(Type.String()),
      }),
      async execute(_id, input, signal) {
        const params = asNonArrayRecord(input) ?? {};
        const workspacePath = readToolStringParam(params, "workspacePath");
        const sandboxPath = readToolStringParam(params, "sandboxPath");
        if (!workspacePath && !sandboxPath) {
          throw new Error("workspacePath is required (sandboxPath is accepted for compatibility)");
        }
        const fileName = readToolStringParam(params, "fileName");
        return jsonResult(
          await files.export({
            ...(workspacePath ? { workspacePath } : {}),
            ...(sandboxPath ? { sandboxPath } : {}),
            fileName,
            signal,
          }),
        );
      },
    },
  ];
}
