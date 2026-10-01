/** Host-owned, ephemeral artifact references; no caller-selected host paths. */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ToolsConfig } from "../config/types.tools.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { deleteMediaBuffer, openMediaStream, saveMediaStream } from "../media/store.js";
import type { PluginArtifact, PluginToolFiles } from "../plugins/tool-files.types.js";
import { artifactCapabilities } from "./artifact-capabilities.js";
import { resolveArtifactLimits } from "./artifact-limits.js";
import { sandboxExecutionWorkspace, type ExecutionWorkspaceBridge } from "./execution-workspace.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";
const TTL_MS = 60 * 60 * 1000;
const SUBDIR = "outbound";
type Entry = { owner: string; id: string; metadata: PluginArtifact };
const artifacts = new Map<string, Entry>();
let reservedBytes = 0;
let pendingImports = 0;
let activeTransfers = 0;

function artifactName(value: string): string {
  const hasControlCharacter = Array.from(value).some((character) => character.charCodeAt(0) < 32);
  if (
    !value ||
    value.length > 200 ||
    /[\\/:]/u.test(value) ||
    hasControlCharacter ||
    value === "." ||
    value === ".."
  ) {
    throw new Error("Artifact fileName must be a plain filename of at most 200 characters");
  }
  return value;
}

async function expireArtifact(ref: string): Promise<void> {
  const entry = artifacts.get(ref);
  if (!entry) {
    return;
  }
  try {
    await deleteMediaBuffer(entry.id, SUBDIR);
  } catch (error) {
    // Concurrent TTL/explicit release can remove the same backing file first.
    if (!(error instanceof FsSafeError && error.code === "not-found")) {
      throw error;
    }
  }
  if (artifacts.get(ref) === entry) {
    artifacts.delete(ref);
    reservedBytes -= entry.metadata.size;
  }
}

/** Await disk reclamation before retiring capacity; also retries failed TTL cleanup. */
export async function cleanupExpiredPluginArtifacts(): Promise<void> {
  await Promise.all(
    [...artifacts]
      .filter(([, entry]) => entry.metadata.expiresAt <= Date.now())
      .map(([ref]) => expireArtifact(ref)),
  );
}

async function* abortableChunks(stream: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      signal.throwIfAborted();
      let abort = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Artifact transfer cancelled"),
          );
        signal.addEventListener("abort", abort, { once: true });
      });
      let next: IteratorResult<Uint8Array>;
      try {
        next = await Promise.race([iterator.next(), cancelled]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      signal.throwIfAborted();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
  }
}

/** Only the agent runtime supplies the owner, sandbox bridge, and run cleanup. */
export function createPluginToolFiles(params: {
  owner: string;
  limits?: ToolsConfig["artifacts"];
  bridge?: SandboxFsBridge;
  cwd?: string;
  workspace?: ExecutionWorkspaceBridge;
  registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => void;
  isCurrent?: () => boolean;
}): PluginToolFiles {
  const limits = resolveArtifactLimits(params.limits);
  const workspace =
    params.workspace ??
    (params.bridge && params.cwd
      ? sandboxExecutionWorkspace(params.bridge, params.cwd)
      : undefined);
  const lifetime = new AbortController();
  const disposers = new Set<() => Promise<void>>();
  const materialized = new Map<string, number>();
  const materializations = new Set<Promise<void>>();
  params.registerRunCleanup(async () => {
    lifetime.abort();
    // Drain the full operation, including quota publication, before deleting its backend.
    await Promise.allSettled(materializations);
    try {
      await Promise.all([...disposers].map((dispose) => dispose()));
    } finally {
      await workspace?.cleanup();
      for (const bytes of materialized.values()) {
        reservedBytes -= bytes;
      }
      materialized.clear();
    }
  });
  const byteLimit = (value = limits.maxBytes) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > limits.maxBytes) {
      throw new Error(`Artifact byte limit must be between 1 and ${limits.maxBytes}`);
    }
    return value;
  };
  const lease = (bytes: number) => {
    if (
      activeTransfers >= limits.maxConcurrentTransfers ||
      reservedBytes + bytes > limits.totalBytes
    ) {
      throw new Error(
        "Managed artifact capacity reached; retry after artifacts expire or transfers finish",
      );
    }
    activeTransfers++;
    reservedBytes += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        activeTransfers--;
        reservedBytes -= bytes;
      }
    };
  };
  const assertActive = (signal?: AbortSignal) => {
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (params.isCurrent && !params.isCurrent()) {
      throw new Error("Artifact capability is no longer active");
    }
  };
  const signalFor = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const lookup = (ref: string, signal?: AbortSignal) => {
    assertActive(signal);
    const entry = artifacts.get(ref);
    if (!entry || entry.owner !== params.owner || entry.metadata.expiresAt <= Date.now()) {
      throw new Error("Artifact unavailable or expired; import the source again");
    }
    return entry;
  };
  const snapshot = async (ref: string, signal?: AbortSignal) => {
    const entry = lookup(ref, signal);
    const release = lease(entry.metadata.size);
    const combined = signalFor(signal);
    let saved: Awaited<ReturnType<typeof saveMediaStream>> | undefined;
    let opened: Awaited<ReturnType<typeof openMediaStream>> | undefined;
    let disposed = false;
    const dispose = async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      disposers.delete(dispose);
      combined.removeEventListener("abort", abort);
      try {
        await opened?.close();
        if (saved) {
          await deleteMediaBuffer(saved.id, SUBDIR);
        }
      } finally {
        release();
      }
    };
    const abort = () => {
      void dispose().catch(() => undefined);
    };
    try {
      const source = await openMediaStream(entry.id, SUBDIR, limits.maxBytes, combined);
      if (source.size !== entry.metadata.size) {
        await source.close();
        throw new Error("Artifact integrity check failed; import the source again");
      }
      const hash = createHash("sha256");
      async function* checked() {
        for await (const chunk of source.stream) {
          lookup(ref, signal);
          hash.update(chunk);
          yield chunk;
        }
      }
      try {
        saved = await saveMediaStream(
          checked(),
          entry.metadata.contentType,
          SUBDIR,
          entry.metadata.size,
          entry.metadata.fileName,
        );
      } finally {
        await source.close();
      }
      lookup(ref, signal);
      if (saved.size !== entry.metadata.size || hash.digest("hex") !== entry.metadata.sha256) {
        throw new Error("Artifact integrity check failed; import the source again");
      }
      opened = await openMediaStream(saved.id, SUBDIR, limits.maxBytes, combined);
      // Retain a descriptor to a verified private snapshot, then unlink it. Reopening
      // the original after verification would allow in-place mutations to escape.
      await deleteMediaBuffer(saved.id, SUBDIR);
      saved = undefined;
      lookup(ref, signal);
      disposers.add(dispose);
      combined.addEventListener("abort", abort, { once: true });
      const verified = opened;
      async function* stream() {
        try {
          for await (const chunk of verified.stream) {
            lookup(ref, signal);
            yield chunk;
          }
          lookup(ref, signal);
        } finally {
          await dispose();
        }
      }
      return { entry, stream: stream(), dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  };
  const files: PluginToolFiles = {
    capabilities: artifactCapabilities(params.limits, workspace),
    async importStream(input) {
      assertActive(input.signal);
      await cleanupExpiredPluginArtifacts();
      assertActive(input.signal);
      const maxBytes = byteLimit(input.maxBytes);
      const fileName = artifactName(input.fileName);
      if (artifacts.size + pendingImports >= limits.maxArtifacts) {
        throw new Error("Managed artifact capacity reached; retry after existing artifacts expire");
      }
      const release = lease(maxBytes);
      pendingImports++;
      const hash = createHash("sha256");
      async function* checkedStream() {
        let size = 0;
        for await (const chunk of abortableChunks(input.stream, signalFor(input.signal))) {
          assertActive(input.signal);
          if (!(chunk instanceof Uint8Array)) {
            throw new Error("Artifact stream requires byte chunks");
          }
          size += chunk.byteLength;
          if (size > maxBytes) {
            throw new Error(`Artifact stream exceeds ${maxBytes} bytes`);
          }
          // Copy before yielding so a producer cannot change bytes after hashing.
          for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
            assertActive(input.signal);
            const bytes = Buffer.from(chunk.subarray(offset, offset + 64 * 1024));
            hash.update(bytes);
            yield bytes;
          }
        }
        assertActive(input.signal);
      }
      let saved: Awaited<ReturnType<typeof saveMediaStream>> | undefined;
      let published = false;
      try {
        saved = await saveMediaStream(
          checkedStream(),
          input.contentType,
          SUBDIR,
          maxBytes,
          fileName,
        );
        assertActive(input.signal);
        const artifactRef = `artifact:${randomUUID()}`;
        const metadata: PluginArtifact = Object.freeze({
          artifactRef,
          fileName,
          contentType: saved.contentType,
          size: saved.size,
          sha256: hash.digest("hex"),
          expiresAt: Date.now() + TTL_MS,
        });
        artifacts.set(artifactRef, { owner: params.owner, id: saved.id, metadata });
        reservedBytes += saved.size;
        published = true;
        const timer = setTimeout(() => {
          void expireArtifact(artifactRef).catch(() => undefined);
        }, TTL_MS);
        timer.unref();
        return metadata;
      } finally {
        pendingImports--;
        release();
        if (saved && !published) {
          await deleteMediaBuffer(saved.id, SUBDIR);
        }
      }
    },
    async openStream(input) {
      const { entry, stream } = await snapshot(input.artifactRef, input.signal);
      return { ...entry.metadata, stream };
    },
    async materialize(input) {
      let finish = () => {};
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      materializations.add(settled);
      try {
        assertActive(input.signal);
        if (!workspace) {
          throw new Error(
            "Active execution workspace required for materialization; sandbox required unless restricted-host is explicitly enabled",
          );
        }
        const { entry, stream, dispose } = await snapshot(input.artifactRef, input.signal);
        let filePath: string;
        if (reservedBytes + entry.metadata.size > limits.totalBytes) {
          await dispose();
          throw new Error("Managed artifact workspace capacity reached");
        }
        reservedBytes += entry.metadata.size;
        try {
          filePath = await workspace.create(
            entry.metadata.fileName,
            stream,
            signalFor(input.signal),
          );
          materialized.set(filePath, entry.metadata.size);
        } catch (error) {
          reservedBytes -= entry.metadata.size;
          throw error;
        } finally {
          await dispose();
        }
        try {
          assertActive(input.signal);
        } catch (error) {
          await workspace.remove(filePath);
          reservedBytes -= materialized.get(filePath) ?? 0;
          materialized.delete(filePath);
          throw error;
        }
        return {
          sandboxPath: filePath,
          workspacePath: filePath,
          backend: workspace.backend,
          size: entry.metadata.size,
        };
      } finally {
        finish();
        materializations.delete(settled);
      }
    },
    async export(input) {
      assertActive(input.signal);
      const maxBytes = byteLimit(input.maxBytes);
      if (!workspace) {
        throw new Error(
          "Active execution workspace required for export; sandbox required unless restricted-host is explicitly enabled",
        );
      }
      const filePath = input.workspacePath ?? input.sandboxPath;
      if (
        !filePath ||
        (input.workspacePath && input.sandboxPath && input.workspacePath !== input.sandboxPath)
      ) {
        throw new Error("Supply one execution workspace path");
      }
      const signal = signalFor(input.signal);
      return files.importStream({
        stream: workspace.read(filePath, maxBytes, signal),
        fileName: input.fileName ?? path.posix.basename(filePath.replace(/\\/gu, "/")),
        contentType: input.contentType,
        maxBytes,
        signal: input.signal,
      });
    },
    async remove(input) {
      lookup(input.artifactRef);
      await expireArtifact(input.artifactRef);
    },
    async removeMaterialized(input) {
      assertActive();
      if (!workspace) {
        throw new Error("Active execution workspace required");
      }
      await workspace.remove(input.workspacePath);
      reservedBytes -= materialized.get(input.workspacePath) ?? 0;
      materialized.delete(input.workspacePath);
    },
    async copyMaterialized(input) {
      assertActive(input.signal);
      if (!workspace) {
        throw new Error("Active execution workspace required");
      }
      // Capture into an immutable artifact first; this also reserves copy capacity.
      const temporary = await files.export({
        workspacePath: input.workspacePath,
        fileName: "artifact-copy.bin",
        signal: input.signal,
      });
      try {
        const copied = await files.materialize({
          artifactRef: temporary.artifactRef,
          signal: input.signal,
        });
        return { workspacePath: copied.workspacePath!, sandboxPath: copied.sandboxPath };
      } finally {
        await expireArtifact(temporary.artifactRef);
      }
    },
  };
  return files;
}
