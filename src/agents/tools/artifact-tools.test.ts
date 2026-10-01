import { expect, it, vi } from "vitest";
import type { PluginToolFiles } from "../../plugins/tool-files.types.js";
import { createArtifactTools } from "./artifact-tools.js";

it("binds model parameters to generic artifact capabilities and returns metadata only", async () => {
  const metadata = {
    artifactRef: "artifact:test",
    fileName: "file.bin",
    size: 3,
    sha256: "abc",
    expiresAt: 1,
  };
  const files: PluginToolFiles = {
    importStream: async () => {
      throw new Error("Unused import");
    },
    openStream: async () => {
      throw new Error("Unused open");
    },
    materialize: vi.fn(async () => ({ sandboxPath: "/workspace/generated/file.bin", size: 3 })),
    export: vi.fn(async () => metadata),
  };
  const tools = createArtifactTools(files);
  const signal = new AbortController().signal;
  const materialize = tools.find((tool) => tool.name === "artifact_materialize")!;
  const exported = tools.find((tool) => tool.name === "artifact_export")!;
  await materialize.execute("test", { artifactRef: metadata.artifactRef }, signal);
  const result = await exported.execute(
    "test",
    { sandboxPath: "/workspace/generated/file.bin", fileName: "file.bin" },
    signal,
  );
  expect(files.materialize).toHaveBeenCalledWith({ artifactRef: metadata.artifactRef, signal });
  expect(files.export).toHaveBeenCalledWith({
    sandboxPath: "/workspace/generated/file.bin",
    fileName: "file.bin",
    signal,
  });
  expect(result.details).toEqual(metadata);
  await expect(materialize.execute("invalid", null, signal)).rejects.toThrow();
});
