/**
 * Plugin `ctx.files` adapter.
 *
 * A thin, provider-neutral facade over native session-retained resource custody
 * and native execution projection. It keeps no in-memory artifact registry, no
 * TTL, and no requester-specific ACL: ownership and authority come from the
 * ambient admitted session handed to the tool context.
 */
import path from "node:path";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import {
  importSessionResourceStream,
  openSessionResourceStream,
  resolveSessionResourceMaxBytes,
  type SessionResourceMetadata,
} from "../gateway/session-resource-store.js";
import type { PluginArtifact, PluginToolFiles } from "../plugins/tool-files.types.js";
import type { ExecutionWorkspaceBridge } from "./execution-workspace.js";

function toArtifact(metadata: SessionResourceMetadata): PluginArtifact {
  return {
    artifactRef: metadata.artifactRef,
    fileName: metadata.fileName,
    ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
    size: metadata.size,
    sha256: metadata.sha256,
  };
}

function clampBytes(requested: number | undefined, ceiling: number): number {
  if (!Number.isSafeInteger(requested) || (requested as number) < 1) {
    return ceiling;
  }
  return Math.min(requested as number, ceiling);
}

export function createPluginToolFiles(params: {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  workspace?: ExecutionWorkspaceBridge;
  maxBytes?: number;
  registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
  assertCurrent?: () => void;
}): PluginToolFiles {
  const maxBytes = resolveSessionResourceMaxBytes(params.maxBytes);
  const source = {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  };
  params.registerRunCleanup?.(async () => {
    await params.workspace?.cleanup();
  });
  const assertCurrentProps = params.assertCurrent ? { assertCurrent: params.assertCurrent } : {};
  const effectiveMax = (requested: number | undefined) => clampBytes(requested, maxBytes);
  const files: PluginToolFiles = {
    async importStream(input) {
      params.assertCurrent?.();
      const metadata = await importSessionResourceStream({
        ...source,
        stream: input.stream,
        fileName: input.fileName,
        contentType: input.contentType ?? mimeTypeFromFilePath(input.fileName),
        maxBytes: effectiveMax(input.maxBytes),
        ...(input.signal ? { signal: input.signal } : {}),
        ...assertCurrentProps,
        source: "plugin",
      });
      return toArtifact(metadata);
    },
    async openStream(input) {
      const { metadata, stream } = await openSessionResourceStream({
        artifactRef: input.artifactRef,
        maxBytes,
        ...source,
        ...(input.signal ? { signal: input.signal } : {}),
        ...assertCurrentProps,
      });
      return { ...toArtifact(metadata), stream };
    },
    async materialize(input) {
      params.assertCurrent?.();
      if (!params.workspace) {
        throw new Error(
          "Active execution workspace required for materialization; run through a supported sandbox",
        );
      }
      const { metadata, stream } = await openSessionResourceStream({
        artifactRef: input.artifactRef,
        maxBytes,
        ...source,
        ...(input.signal ? { signal: input.signal } : {}),
        ...assertCurrentProps,
      });
      const filePath = await params.workspace.create(metadata.fileName, stream, input.signal);
      return {
        workspacePath: filePath,
        sandboxPath: filePath,
        backend: params.workspace.backend,
        size: metadata.size,
      };
    },
    async export(input) {
      params.assertCurrent?.();
      if (!params.workspace) {
        throw new Error(
          "Active execution workspace required for export; run through a supported sandbox",
        );
      }
      const filePath = input.workspacePath ?? input.sandboxPath;
      if (
        !filePath ||
        (input.workspacePath && input.sandboxPath && input.workspacePath !== input.sandboxPath)
      ) {
        throw new Error("Supply one execution workspace path");
      }
      const metadata = await importSessionResourceStream({
        ...source,
        stream: params.workspace.read(filePath, effectiveMax(input.maxBytes), input.signal),
        fileName: input.fileName ?? path.posix.basename(filePath.replace(/\\/gu, "/")),
        contentType: input.contentType ?? mimeTypeFromFilePath(filePath),
        maxBytes: effectiveMax(input.maxBytes),
        ...(input.signal ? { signal: input.signal } : {}),
        ...assertCurrentProps,
        role: "export",
        source: "plugin",
      });
      return toArtifact(metadata);
    },
  };
  return files;
}
