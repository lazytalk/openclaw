/** Host-owned, ephemeral artifact references; no caller-selected host paths. */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ToolsConfig } from "../config/types.tools.js";
import { deleteMediaBuffer, openMediaStream, saveMediaStream } from "../media/store.js";
import type { PluginArtifact, PluginToolFiles } from "../plugins/tool-files.types.js";
import { resolveArtifactLimits } from "./artifact-limits.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";
const TTL_MS = 60 * 60 * 1000;
const SUBDIR = "outbound";
type Entry = { owner: string; id: string; metadata: PluginArtifact };
const artifacts = new Map<string, Entry>();
let reservedBytes = 0;
let pendingImports = 0;
let activeTransfers = 0;

function artifactName(value: string): string {
  const hasControlCharacter = [...value].some((character) => character.charCodeAt(0) < 32);
  if (
    !value ||
    value.length > 200 ||
    /[\\/]/u.test(value) ||
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
  artifacts.delete(ref);
  reservedBytes -= entry.metadata.size;
  await deleteMediaBuffer(entry.id, SUBDIR);
}

async function* abortableChunks(stream: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      signal.throwIfAborted();
      let abort = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
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
  registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => void;
  isCurrent?: () => boolean;
}): PluginToolFiles {
  const limits = resolveArtifactLimits(params.limits);
  const lifetime = new AbortController();
  const disposers = new Set<() => Promise<void>>();
  params.registerRunCleanup(async () => {
    lifetime.abort();
    await Promise.all([...disposers].map((dispose) => dispose()));
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
    capabilities: limits,
    async importStream(input) {
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
      assertActive(input.signal);
      const bridge = params.bridge;
      if (!bridge || !params.cwd) {
        throw new Error("Active sandbox required for materialization");
      }
      const create = bridge.createFileExclusiveStream;
      if (!create) {
        throw new Error("Sandbox backend does not support exclusive artifact creation");
      }
      const { entry, stream, dispose } = await snapshot(input.artifactRef, input.signal);
      const filePath = path.posix.join(
        ".openclaw-artifacts",
        randomUUID(),
        entry.metadata.fileName,
      );
      let result: "created" | "exists";
      try {
        result = await create.call(bridge, {
          filePath,
          cwd: params.cwd,
          stream,
          mkdir: true,
          signal: signalFor(input.signal),
        });
      } finally {
        await dispose();
      }
      if (result === "created") {
        try {
          assertActive(input.signal);
        } catch (error) {
          await bridge.remove({ filePath, cwd: params.cwd, force: true });
          throw error;
        }
      }
      if (result !== "created") {
        throw new Error("Artifact destination already exists; retry materialization");
      }
      return {
        sandboxPath: bridge.resolvePath({ filePath, cwd: params.cwd }).containerPath,
        size: entry.metadata.size,
      };
    },
    async export(input) {
      assertActive(input.signal);
      const maxBytes = byteLimit(input.maxBytes);
      const bridge = params.bridge;
      if (!bridge || !params.cwd) {
        throw new Error("Active sandbox required for export");
      }
      const resolved = bridge.resolvePath({ filePath: input.sandboxPath, cwd: params.cwd });
      const relative = path.posix.relative(params.cwd, resolved.containerPath);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith("../") ||
        path.posix.isAbsolute(relative)
      ) {
        throw new Error("Artifact export must stay inside the active sandbox workspace");
      }
      if (!bridge.readFileStream) {
        throw new Error("Sandbox backend does not support streaming artifact reads");
      }
      const read = bridge.readFileStream;
      const cwd = params.cwd;
      const signal = signalFor(input.signal);
      async function* streamSource() {
        const source = await read.call(bridge, {
          filePath: resolved.containerPath,
          cwd,
          maxBytes,
          signal,
        });
        yield* source;
      }
      const stream = streamSource();
      return files.importStream({
        stream,
        fileName: input.fileName ?? path.posix.basename(resolved.containerPath),
        contentType: input.contentType,
        maxBytes,
        signal: input.signal,
      });
    },
  };
  return files;
}
