/**
 * Session resource execution projection.
 *
 * A durable session resource is not a filesystem path. When execution needs it,
 * bytes are projected into the active execution workspace through the placement
 * that owns that workspace. This layer never selects a backend: it consumes a
 * projection provided by the host's execution placement (`AgentWorkspaceAccess`
 * or native local execution), so Session Resource and `ctx.files` stay
 * placement-agnostic.
 *
 * Providers must bound memory by the chunk size, never by the whole resource.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, isPathInside, openLocalFileSafely } from "../infra/fs-safe.js";
import type { PluginToolFilesBackend } from "../plugins/tool-files.types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

const WORKSPACE_SUBDIR = ".openclaw-session-resources";

/**
 * Bounded ceiling for a projection that must fall back to a whole-file bridge
 * transfer. A backend that can stream declares the resource ceiling instead;
 * this keeps a buffered backend honest rather than silently accepting 512 MiB.
 */
export const DEFAULT_BUFFERED_PROJECTION_MAX_BYTES = 50 * 1024 * 1024;

/** Placement-neutral projection for session-retained resources and exports. */
export type SessionResourceProjection = {
  /** Execution placement label for diagnostics; never part of the provider contract. */
  readonly backend: PluginToolFilesBackend;
  /** Own byte ceiling for materialize; may be below the Session Resource ceiling. */
  readonly materializeMaxBytes: number;
  /** Own byte ceiling for export; may be below the Session Resource ceiling. */
  readonly exportMaxBytes: number;
  /** Stream bytes into a generated workspace file; returns the execution path. */
  createFromStream(
    fileName: string,
    stream: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ workspacePath: string; size: number }>;
  /** Stream a confined workspace file back out, bounded by `maxBytes`. */
  openReadStream(
    filePath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  /** Run-scoped cleanup of generated materials; owned by the placement. */
  cleanup?(): Promise<void>;
};

/** Asserts a caller-supplied name is a plain filename with no separator or traversal. */
function assertPlainFileName(fileName: string): void {
  const hasControlCharacter = Array.from(fileName).some(
    (character) => character.charCodeAt(0) < 32,
  );
  if (
    !fileName ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    hasControlCharacter ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new Error("Execution workspace fileName must be a plain filename");
  }
}

async function collectBounded(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("Execution workspace write requires byte chunks");
    }
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Execution workspace write exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Host path backing a container path when the placement exposes a local bind.
 * The root is the workspace host root the opened target must resolve inside.
 */
function resolveHostBacking(
  bridge: SandboxFsBridge,
  containerPath: string,
  cwd: string,
): { target: string; root: string } | undefined {
  try {
    const root = bridge.resolvePath({ filePath: cwd, cwd }).hostPath;
    const target = bridge.resolvePath({ filePath: containerPath, cwd }).hostPath;
    if (!root || !target) {
      return undefined;
    }
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return undefined;
    }
    return { target: resolvedTarget, root: resolvedRoot };
  } catch {
    return undefined;
  }
}

/**
 * Streams bytes from the same safely opened object that was authorized.
 *
 * A lexical path check is not an authorization boundary: the entry could be a
 * symlink, an intermediate-directory symlink, a hardlink, or be replaced after
 * resolution. This opens the file with OpenClaw's native no-follow safe-open,
 * proves the canonical target is inside the workspace root, rejects hardlinks
 * and non-regular files, and only then streams from that exact descriptor.
 */
async function* streamSafelyOpenedFile(params: {
  filePath: string;
  root: string;
  limit: number;
  signal?: AbortSignal;
}): AsyncIterable<Uint8Array> {
  const { filePath, root, limit, signal } = params;
  signal?.throwIfAborted();
  const opened = await openLocalFileSafely({ filePath });
  try {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      throw new Error("Authorized workspace root is unavailable");
    }
    if (!isPathInside(realRoot, opened.realPath)) {
      throw new Error("Workspace file resolves outside the authorized workspace");
    }
    if (!opened.stat.isFile()) {
      throw new Error("Workspace file is not a regular file");
    }
    if (opened.stat.nlink > 1) {
      throw new Error("Workspace file is hardlinked; refusing to export");
    }
    let total = 0;
    const stream = opened.handle.createReadStream({ autoClose: false });
    try {
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > limit) {
          throw new Error("Workspace file exceeds byte limit");
        }
        yield bytes;
      }
    } finally {
      stream.destroy();
    }
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

function confineAgainstRoot(root: string, filePath: string): string {
  if (filePath.split(/[\\/]/u).includes("..")) {
    throw new Error("Session resource path traversal outside the execution workspace is forbidden");
  }
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Session resource export must stay inside the active execution workspace");
  }
  return resolved;
}

/**
 * Native local execution projection: the execution host owns the workspace root,
 * so the copy streams host-to-host with no whole-file buffer.
 */
export function localExecutionProjection(
  root: string,
  maxBytes: number,
): SessionResourceProjection {
  const resolvedRoot = path.resolve(root);
  const generated = new Set<string>();
  return {
    backend: "host",
    materializeMaxBytes: maxBytes,
    exportMaxBytes: maxBytes,
    async createFromStream(fileName, stream, signal) {
      assertPlainFileName(fileName);
      const id = randomUUID();
      const dir = path.join(resolvedRoot, WORKSPACE_SUBDIR, id);
      const relativeFile = path.posix.join(WORKSPACE_SUBDIR, id, fileName);
      // Register the destination before any write so a partial or cancelled
      // write is still owned by run cleanup.
      generated.add(dir);
      signal?.throwIfAborted();
      // Open the destination through the native safe-write boundary: mutations
      // reject symlinks and stay anchored to the workspace root, so a swapped
      // parent directory cannot redirect the write outside the workspace.
      const safeRoot = await fsSafeRoot(resolvedRoot, {
        mutationSymlinks: "reject",
        mkdir: true,
        mode: 0o600,
      });
      let opened: Awaited<ReturnType<typeof safeRoot.openWritable>> | undefined;
      let size = 0;
      try {
        opened = await safeRoot.openWritable(relativeFile, {
          writeMode: "replace",
          mkdir: true,
          mode: 0o600,
        });
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) {
            throw new Error("Execution workspace write requires byte chunks");
          }
          size += chunk.byteLength;
          if (size > maxBytes) {
            throw new Error(`Execution workspace write exceeds ${maxBytes} bytes`);
          }
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await opened.handle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
            );
            if (bytesWritten <= 0) {
              throw new Error("Execution workspace write stalled");
            }
            offset += bytesWritten;
          }
        }
      } catch (error) {
        // Close the descriptor before removing the partial directory.
        await opened?.handle.close().catch(() => undefined);
        opened = undefined;
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        generated.delete(dir);
        throw error;
      } finally {
        await opened?.handle.close().catch(() => undefined);
      }
      generated.add(dir);
      return { workspacePath: path.join(resolvedRoot, relativeFile), size };
    },
    async *openReadStream(filePath, limit, signal) {
      const resolved = confineAgainstRoot(resolvedRoot, filePath);
      yield* streamSafelyOpenedFile({ filePath: resolved, root: resolvedRoot, limit, signal });
    },
    async cleanup() {
      for (const dir of generated) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      generated.clear();
    },
  };
}

/**
 * Bridge-owned projection for a non-local placement. Streams through the
 * placement bridge when it exposes streaming primitives; otherwise it reuses the
 * bridge's bounded whole-file transfer.
 */
export function bridgeProjection(
  bridge: SandboxFsBridge,
  cwd: string,
  maxBytes: number,
): SessionResourceProjection {
  const generated = new Set<string>();
  const confine = (filePath: string): string => {
    if (filePath.split(/[\\/]/u).includes("..")) {
      throw new Error(
        "Session resource path traversal outside the execution workspace is forbidden",
      );
    }
    const resolved = bridge.resolvePath({ filePath, cwd }).containerPath;
    const relative = path.posix.relative(cwd, resolved);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.posix.isAbsolute(relative)
    ) {
      throw new Error("Session resource export must stay inside the active execution workspace");
    }
    return resolved;
  };
  // Derive each direction's ceiling from the primitive it actually uses: a
  // streaming primitive keeps the resource ceiling; a whole-file fallback reports
  // its own bounded ceiling instead of silently accepting a whole-file buffer.
  // (Export may also stream through a local host backing path, but the bridge
  // advertises the conservative bridge-derived value.)
  const materializeCeiling = bridge.writeFileStream
    ? maxBytes
    : Math.min(maxBytes, DEFAULT_BUFFERED_PROJECTION_MAX_BYTES);
  const exportCeiling = bridge.readFileStream
    ? maxBytes
    : Math.min(maxBytes, DEFAULT_BUFFERED_PROJECTION_MAX_BYTES);
  return {
    backend: "sandbox",
    materializeMaxBytes: materializeCeiling,
    exportMaxBytes: exportCeiling,
    async createFromStream(fileName, stream, signal) {
      assertPlainFileName(fileName);
      const relativePath = path.posix.join(WORKSPACE_SUBDIR, randomUUID(), fileName);
      signal?.throwIfAborted();
      const resolved = confine(relativePath);
      // Register the destination before any write so a partial or cancelled
      // write is still owned by run cleanup.
      generated.add(resolved);
      let size: number;
      try {
        if (bridge.writeFileStream) {
          size = await bridge.writeFileStream({
            filePath: relativePath,
            cwd,
            stream,
            mkdir: true,
            maxBytes: materializeCeiling,
            signal,
          });
        } else {
          const bytes = await collectBounded(stream, materializeCeiling, signal);
          signal?.throwIfAborted();
          await bridge.writeFile({
            filePath: relativePath,
            cwd,
            data: bytes,
            mkdir: true,
            signal,
          });
          size = bytes.byteLength;
        }
      } catch (error) {
        await bridge.remove({ filePath: resolved, cwd, force: true }).catch(() => undefined);
        generated.delete(resolved);
        throw error;
      }
      return { workspacePath: resolved, size };
    },
    async *openReadStream(filePath, limit, signal) {
      const resolved = confine(filePath);
      signal?.throwIfAborted();
      // A local placement bind-mounts the workspace from the host, so the same
      // authorized bytes can be streamed from the host backing path without
      // buffering. Remote/cloud placements expose no host path and fall through
      // to the backend transfer.
      const hostBacking = resolveHostBacking(bridge, resolved, cwd);
      if (hostBacking) {
        yield* streamSafelyOpenedFile({
          filePath: hostBacking.target,
          root: hostBacking.root,
          limit,
          signal,
        });
        return;
      }
      if (bridge.readFileStream) {
        yield* bridge.readFileStream({
          filePath: resolved,
          cwd,
          maxBytes: Math.min(limit, exportCeiling),
          signal,
        });
        return;
      }
      const boundedLimit = Math.min(limit, exportCeiling);
      const data = await bridge.readFile({
        filePath: resolved,
        cwd,
        maxBytes: boundedLimit,
        signal,
      });
      signal?.throwIfAborted();
      if (data.byteLength > boundedLimit) {
        throw new Error("Workspace file exceeds byte limit");
      }
      yield data;
    },
    async cleanup() {
      for (const containerPath of generated) {
        await bridge.remove({ filePath: containerPath, cwd, force: true }).catch(() => undefined);
      }
      generated.clear();
    },
  };
}

/**
 * Resolve the projection for the current placement. The host supplies the
 * decided placement; this helper only adapts it and is not consulted by the
 * Session Resource custody layer.
 */
export function resolveSessionResourceProjection(params: {
  bridge?: SandboxFsBridge;
  cwd?: string;
  workspaceRoot?: string;
  maxBytes: number;
}): SessionResourceProjection | undefined {
  if (params.bridge && params.cwd) {
    return bridgeProjection(params.bridge, params.cwd, params.maxBytes);
  }
  const root = params.workspaceRoot?.trim();
  return root ? localExecutionProjection(root, params.maxBytes) : undefined;
}
