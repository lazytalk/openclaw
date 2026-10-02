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
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PluginToolFilesBackend } from "../plugins/tool-files.types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

const WORKSPACE_SUBDIR = ".openclaw-session-resources";

/** Placement-neutral projection for session-retained resources and exports. */
export type SessionResourceProjection = {
  /** Execution placement label reported as negotiation metadata (never authority). */
  readonly backend: PluginToolFilesBackend;
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

/** Counts bytes and fails past the ceiling without materializing the whole resource. */
function countingLimit(maxBytes: number, onBytes: (total: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        callback(new Error(`Execution workspace write exceeds ${maxBytes} bytes`));
        return;
      }
      onBytes(total);
      callback(null, chunk);
    },
  });
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

/** Resolves a generated destination and proves it stays inside the workspace root. */
async function resolveInsideRoot(root: string, candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Execution workspace path must stay inside the workspace root");
  }
  // Re-check containment after resolving symlinks in the destination parent so a
  // swapped directory cannot redirect a confined write outside the workspace.
  const parentReal = await fs.realpath(path.dirname(resolved));
  const rootedReal = await fs.realpath(root);
  const parentRelative = path.relative(rootedReal, parentReal);
  if (
    parentRelative === ".." ||
    parentRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(parentRelative)
  ) {
    throw new Error("Execution workspace path must stay inside the workspace root");
  }
  return resolved;
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
    async createFromStream(fileName, stream, signal) {
      assertPlainFileName(fileName);
      const dir = path.join(resolvedRoot, WORKSPACE_SUBDIR, randomUUID());
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const destination = await resolveInsideRoot(resolvedRoot, path.join(dir, fileName));
      signal?.throwIfAborted();
      let size = 0;
      try {
        await pipeline(
          Readable.from(stream),
          countingLimit(maxBytes, (total) => {
            size = total;
          }),
          createWriteStream(destination, { mode: 0o600 }),
          { signal },
        );
      } catch (error) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      generated.add(dir);
      return { workspacePath: destination, size };
    },
    async *openReadStream(filePath, limit, signal) {
      const resolved = confineAgainstRoot(resolvedRoot, filePath);
      signal?.throwIfAborted();
      const opened = createReadStream(resolved);
      let total = 0;
      try {
        for await (const chunk of opened) {
          signal?.throwIfAborted();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > limit) {
            throw new Error("Workspace file exceeds byte limit");
          }
          yield bytes;
        }
      } finally {
        opened.destroy();
      }
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
  return {
    backend: "sandbox",
    async createFromStream(fileName, stream, signal) {
      assertPlainFileName(fileName);
      const relativePath = path.posix.join(WORKSPACE_SUBDIR, randomUUID(), fileName);
      signal?.throwIfAborted();
      const resolved = confine(relativePath);
      let size: number;
      if (bridge.writeFileStream) {
        size = await bridge.writeFileStream({
          filePath: relativePath,
          cwd,
          stream,
          mkdir: true,
          maxBytes,
          signal,
        });
      } else {
        const bytes = await collectBounded(stream, maxBytes, signal);
        signal?.throwIfAborted();
        await bridge.writeFile({ filePath: relativePath, cwd, data: bytes, mkdir: true, signal });
        size = bytes.byteLength;
      }
      generated.add(resolved);
      return { workspacePath: resolved, size };
    },
    async *openReadStream(filePath, limit, signal) {
      const resolved = confine(filePath);
      signal?.throwIfAborted();
      if (bridge.readFileStream) {
        yield* bridge.readFileStream({ filePath: resolved, cwd, maxBytes: limit, signal });
        return;
      }
      const data = await bridge.readFile({ filePath: resolved, cwd, maxBytes: limit, signal });
      signal?.throwIfAborted();
      if (data.byteLength > limit) {
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

/** Container path where the placement projected `hostRoot` read-only, if any. */
export function resolveProjectedMount(
  bridge: SandboxFsBridge,
  hostRoot: string,
): string | undefined {
  const target = path.resolve(hostRoot);
  return bridge.pathMappings?.find((mapping) => path.resolve(mapping.hostRoot) === target)
    ?.containerRoot;
}

/**
 * Sandbox projection over a placement-owned read-only resource mount.
 *
 * The canonical bytes are staged host-side with a streaming copy, then the
 * placement bridge copies them into the writable execution workspace with its
 * native copy. This avoids both whole-file Buffering and command-stdin
 * streaming. The caller must only use this when `resolveProjectedMount` proves
 * the staging root is projected into the sandbox.
 */
export function mountedResourceCopyProjection(params: {
  bridge: SandboxFsBridge;
  cwd: string;
  maxBytes: number;
  projectedRoot: string;
  projectedMount: string;
}): SessionResourceProjection {
  const { bridge, cwd, maxBytes, projectedRoot, projectedMount } = params;
  const copyFile = bridge.copyFile?.bind(bridge);
  if (!copyFile) {
    throw new Error("Placement mount projection requires a native copy primitive");
  }
  const base = bridgeProjection(bridge, cwd, maxBytes);
  const stagedHostDirs = new Set<string>();
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
  return {
    backend: base.backend,
    async createFromStream(fileName, stream, signal) {
      assertPlainFileName(fileName);
      const id = randomUUID();
      const hostDir = path.join(projectedRoot, id);
      const hostFile = path.join(hostDir, fileName);
      await fs.mkdir(hostDir, { recursive: true, mode: 0o700 });
      stagedHostDirs.add(hostDir);
      let size = 0;
      const relativePath = path.posix.join(WORKSPACE_SUBDIR, randomUUID(), fileName);
      try {
        signal?.throwIfAborted();
        await pipeline(
          Readable.from(stream),
          countingLimit(maxBytes, (total) => {
            size = total;
          }),
          createWriteStream(hostFile, { mode: 0o600 }),
          { signal },
        );
        signal?.throwIfAborted();
        await copyFile({
          sourcePath: path.posix.join(projectedMount, id, fileName),
          destinationPath: relativePath,
          cwd,
          mkdir: true,
          signal,
        });
      } catch (error) {
        await fs.rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
        stagedHostDirs.delete(hostDir);
        throw error;
      }
      return { workspacePath: confine(relativePath), size };
    },
    openReadStream: (filePath, limit, signal) => base.openReadStream(filePath, limit, signal),
    async cleanup() {
      await base.cleanup?.();
      for (const hostDir of stagedHostDirs) {
        await fs.rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
      }
      stagedHostDirs.clear();
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
  /** Placement-owned host root projected read-only into the sandbox, when present. */
  projectedRoot?: string;
  maxBytes: number;
}): SessionResourceProjection | undefined {
  if (params.bridge && params.cwd) {
    const projectedRoot = params.projectedRoot?.trim();
    if (projectedRoot) {
      const mount = resolveProjectedMount(params.bridge, projectedRoot);
      if (mount) {
        return mountedResourceCopyProjection({
          bridge: params.bridge,
          cwd: params.cwd,
          maxBytes: params.maxBytes,
          projectedRoot,
          projectedMount: mount,
        });
      }
    }
    return bridgeProjection(params.bridge, params.cwd, params.maxBytes);
  }
  const root = params.workspaceRoot?.trim();
  return root ? localExecutionProjection(root, params.maxBytes) : undefined;
}
