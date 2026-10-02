/**
 * Run-owned execution workspace projection.
 *
 * A durable session resource is not a filesystem path. When execution needs it,
 * the resource is copied into the active execution workspace through the native
 * sandbox filesystem bridge, and generated output is read back through the same
 * confined bridge. Paths are generated; callers cannot select the workspace root.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

const WORKSPACE_SUBDIR = ".openclaw-session-resources";

export type ExecutionWorkspaceBridge = {
  backend: "sandbox";
  create(
    fileName: string,
    stream: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<string>;
  read(filePath: string, maxBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  remove(filePath: string): Promise<void>;
  cleanup(): Promise<void>;
};

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

/** Confined copy-in/read-out over the active sandbox workspace. */
export function sandboxExecutionWorkspace(
  bridge: SandboxFsBridge,
  cwd: string,
  maxBytes: number,
): ExecutionWorkspaceBridge {
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
    async create(fileName, stream, signal) {
      const relativePath = path.posix.join(WORKSPACE_SUBDIR, randomUUID(), fileName);
      const bytes = await collectBounded(stream, maxBytes, signal);
      signal?.throwIfAborted();
      await bridge.writeFile({ filePath: relativePath, cwd, data: bytes, mkdir: true, signal });
      const resolved = confine(relativePath);
      generated.add(resolved);
      return resolved;
    },
    async *read(filePath, limit, signal) {
      const resolved = confine(filePath);
      signal?.throwIfAborted();
      const data = await bridge.readFile({ filePath: resolved, cwd, maxBytes: limit, signal });
      signal?.throwIfAborted();
      if (data.byteLength > limit) {
        throw new Error("Workspace file exceeds byte limit");
      }
      yield data;
    },
    async remove(filePath) {
      const resolved = confine(filePath);
      if (!generated.has(resolved)) {
        throw new Error("Only generated materialization paths may be removed");
      }
      await bridge.remove({ filePath: resolved, cwd, force: true });
      generated.delete(resolved);
    },
    async cleanup() {
      const paths = [...generated];
      for (const filePath of paths) {
        await this.remove(filePath);
      }
    },
  };
}

export function resolveExecutionWorkspace(params: {
  sandboxed?: boolean;
  bridge?: SandboxFsBridge;
  cwd?: string;
  maxBytes: number;
}): ExecutionWorkspaceBridge | undefined {
  return params.sandboxed && params.bridge && params.cwd
    ? sandboxExecutionWorkspace(params.bridge, params.cwd, params.maxBytes)
    : undefined;
}
