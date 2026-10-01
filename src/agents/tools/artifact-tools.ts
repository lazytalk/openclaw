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
        "Copy a managed artifact into the active sandbox for binary processing. Returns the sandbox path and size. References expire; import the source again when unavailable.",
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
        "Capture a file from the active sandbox workspace as an immutable managed artifact for upload. Returns an opaque reference and SHA-256, never binary content. Bounded by the host tools.artifacts.maxBytes limit (512 MiB by default).",
      parameters: Type.Object({
        sandboxPath: Type.String(),
        fileName: Type.Optional(Type.String()),
      }),
      async execute(_id, input, signal) {
        const params = asNonArrayRecord(input) ?? {};
        const sandboxPath = readToolStringParam(params, "sandboxPath", { required: true });
        const fileName = readToolStringParam(params, "fileName");
        return jsonResult(await files.export({ sandboxPath, fileName, signal }));
      },
    },
  ];
}
