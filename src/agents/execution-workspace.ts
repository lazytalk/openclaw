import "../infra/fs-safe-defaults.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { ToolsConfig } from "../config/types.tools.js";
import { root } from "../infra/fs-safe.js";
import {
  reapHostExecutionWorkspaces,
  registerHostWorkspace,
  reserveHostWorkspace,
  removeWorkspaceTree,
} from "./execution-workspace-lifecycle.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

/** Run-owned byte IO boundary. Paths are generated; callers cannot select its root. */
export type ExecutionWorkspaceBridge = {
  backend: "sandbox" | "restricted-host";
  create(
    fileName: string,
    stream: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<string>;
  read(filePath: string, maxBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  remove(filePath: string): Promise<void>;
  cleanup(): Promise<void>;
};

export function sandboxExecutionWorkspace(
  bridge: SandboxFsBridge,
  cwd: string,
): ExecutionWorkspaceBridge | undefined {
  if (!bridge.createFileExclusiveStream || !bridge.readFileStream) {
    return undefined;
  }
  const generated = new Set<string>();
  const confined = (filePath: string) => {
    if (filePath.split(/[\\/]/u).includes("..")) {
      throw new Error("Artifact path traversal outside the execution workspace is forbidden");
    }
    const resolved = bridge.resolvePath({ filePath, cwd }).containerPath;
    const relative = path.posix.relative(cwd, resolved);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.posix.isAbsolute(relative)
    ) {
      throw new Error("Artifact export must stay inside the active execution workspace");
    }
    return resolved;
  };
  return {
    backend: "sandbox",
    async create(fileName, stream, signal) {
      const filePath = path.posix.join(".openclaw-artifacts", randomUUID(), fileName);
      const result = await bridge.createFileExclusiveStream!({
        filePath,
        cwd,
        stream,
        mkdir: true,
        signal,
      });
      if (result !== "created") {
        throw new Error("Artifact destination already exists; retry materialization");
      }
      const resolved = confined(filePath);
      generated.add(resolved);
      return resolved;
    },
    async *read(filePath, maxBytes, signal) {
      yield* await bridge.readFileStream!({ filePath: confined(filePath), cwd, maxBytes, signal });
    },
    async remove(filePath) {
      const resolved = confined(filePath);
      if (!generated.has(resolved)) {
        throw new Error("Only generated materialization paths may be removed");
      }
      await bridge.remove({ filePath: resolved, cwd, force: true });
      generated.delete(resolved);
    },
    async cleanup() {
      for (const filePath of generated) {
        await this.remove(filePath);
      }
    },
  };
}

/** Lazy provisioning keeps synchronous tool discovery free of host IO. */
export function restrictedHostExecutionWorkspace(owner: string): ExecutionWorkspaceBridge {
  const ownerId = createHash("sha256").update(owner).digest("hex");
  const relativeRoot = path.join("runtime-workspaces", ownerId, randomUUID());
  const stateDir = resolveStateDir();
  const rootDir = path.join(stateDir, relativeRoot);
  const lifetime = new AbortController();
  const writes = new Set<Promise<string>>();
  let unregister = () => {};
  let pending: Promise<Awaited<ReturnType<typeof root>>> | undefined;
  const store = () =>
    (pending ??= (async () => {
      lifetime.signal.throwIfAborted();
      await reapHostExecutionWorkspaces(stateDir);
      const state = await root(stateDir, { symlinks: "reject", hardlinks: "reject", mode: 0o700 });
      unregister = reserveHostWorkspace(path.join(state.rootReal, relativeRoot));
      await state.mkdir(relativeRoot);
      const storage = await root(rootDir, { symlinks: "reject", hardlinks: "reject", mode: 0o600 });
      if (storage.rootReal !== path.join(state.rootReal, relativeRoot)) {
        throw new Error("Execution workspace root changed during provisioning");
      }
      await registerHostWorkspace(storage);
      return storage;
    })());
  const confined = (filePath: string) => {
    if (
      !filePath ||
      filePath.includes("\0") ||
      filePath.split(/[\\/]/u).includes("..") ||
      /[~]/u.test(filePath) ||
      (process.platform !== "win32" && (filePath.includes("\\") || filePath.includes(":")))
    ) {
      throw new Error("Artifact path must stay inside the active execution workspace");
    }
    const relative = path.relative(rootDir, path.resolve(rootDir, filePath));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.includes(":")
    ) {
      throw new Error("Artifact path must stay inside the active execution workspace");
    }
    return relative;
  };
  const generated = new Set<string>();
  return {
    backend: "restricted-host",
    async create(fileName, stream, signal) {
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const operation = (async () => {
        combined.throwIfAborted();
        const storage = await store();
        combined.throwIfAborted();
        const relative = path.join(randomUUID(), fileName);
        // Guarded atomic create followed by descriptor update; never replace a caller path.
        await storage.create(relative, Buffer.alloc(0), { mkdir: true });
        generated.add(relative);
        let completed = false;
        try {
          const opened = await storage.openWritable(relative, { writeMode: "update" });
          try {
            for await (const chunk of stream) {
              combined.throwIfAborted();
              await opened.handle.writeFile(chunk);
            }
            combined.throwIfAborted();
            completed = true;
            return path.join(rootDir, relative);
          } finally {
            await opened.handle.close();
          }
        } finally {
          if (!completed) {
            await storage.remove(relative);
            generated.delete(relative);
          }
        }
      })();
      writes.add(operation);
      try {
        return await operation;
      } finally {
        writes.delete(operation);
      }
    },
    async *read(filePath, maxBytes, signal) {
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const relative = confined(filePath);
      combined.throwIfAborted();
      const opened = await (await store()).open(relative);
      try {
        combined.throwIfAborted();
        if (!opened.stat.isFile() || opened.stat.size > maxBytes) {
          throw new Error("Workspace file exceeds byte limit or is not a regular file");
        }
        let size = 0;
        while (true) {
          combined.throwIfAborted();
          const bytes = Buffer.allocUnsafe(64 * 1024);
          const { bytesRead } = await opened.handle.read(bytes);
          if (!bytesRead) {
            break;
          }
          size += bytesRead;
          if (size > maxBytes) {
            throw new Error("Workspace file exceeds byte limit");
          }
          yield bytes.subarray(0, bytesRead);
        }
        combined.throwIfAborted();
      } finally {
        await opened.handle.close();
      }
    },
    async remove(filePath) {
      const relative = confined(filePath);
      await (await store()).remove(relative);
      generated.delete(relative);
    },
    async cleanup() {
      lifetime.abort();
      await Promise.allSettled(writes);
      try {
        if (pending) {
          const storage = await pending;
          await removeWorkspaceTree(storage);
          const state = await root(stateDir, { symlinks: "reject", hardlinks: "reject" });
          await state.remove(relativeRoot);
        }
      } finally {
        unregister();
      }
    },
  };
}

export function resolveExecutionWorkspace(params: {
  owner: string;
  sandboxed?: boolean;
  bridge?: SandboxFsBridge;
  cwd?: string;
  config?: ToolsConfig["executionWorkspace"];
}): ExecutionWorkspaceBridge | undefined {
  if (params.sandboxed) {
    return params.bridge && params.cwd
      ? sandboxExecutionWorkspace(params.bridge, params.cwd)
      : undefined;
  }
  return params.config?.mode === "restricted-host"
    ? restrictedHostExecutionWorkspace(params.owner)
    : undefined;
}
