import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import type { PluginToolFiles } from "../../plugins/tool-files.types.js";
import { jsonResult, readToolStringParam, type AnyAgentTool } from "./common.js";

/** Session resource transfer tools return metadata only; binary data stays with the host. */
export function createArtifactTools(files: PluginToolFiles): AnyAgentTool[] {
  return [
    {
      name: "artifact_materialize",
      label: "Materialize artifact",
      description:
        "Copy a session-retained artifact into the active execution workspace for binary processing. Returns workspacePath, backend and size. Ownership follows the current session; references are not credentials.",
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
        "Capture a file confined to the active execution workspace as a new session-retained artifact for upload. Rejects traversal and external paths. Returns an opaque reference and SHA-256, never binary content.",
      parameters: Type.Object({
        workspacePath: Type.String(),
        fileName: Type.Optional(Type.String()),
      }),
      async execute(_id, input, signal) {
        const params = asNonArrayRecord(input) ?? {};
        const workspacePath = readToolStringParam(params, "workspacePath", { required: true });
        const fileName = readToolStringParam(params, "fileName");
        return jsonResult(
          await files.export({
            workspacePath,
            ...(fileName ? { fileName } : {}),
            signal,
          }),
        );
      },
    },
  ];
}
