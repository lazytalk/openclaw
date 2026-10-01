/** Host-owned, ephemeral artifact references; no caller-selected host paths. */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { deleteMediaBuffer, readMediaBuffer, saveMediaStream } from "../media/store.js";
import type { PluginArtifact, PluginToolFiles } from "../plugins/tool-files.types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACTS = 128;
const TTL_MS = 60 * 60 * 1000;
const SUBDIR = "outbound";
type Entry = { owner: string; id: string; metadata: PluginArtifact };
const artifacts = new Map<string, Entry>();
let reservedBytes = 0;
let pendingImports = 0;

function byteLimit(value = MAX_BYTES): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BYTES) {
    throw new Error("Artifact byte limit must be between 1 and 67108864");
  }
  return value;
}

function artifactName(value: string): string {
  const hasControlCharacter = [...value].some((character) => character.charCodeAt(0) < 32);
  if (!value || value.length > 200 || /[\\/]/u.test(value) || hasControlCharacter || value === "." || value === "..") {
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

/** Only the agent runtime supplies the owner, sandbox bridge, and run cleanup. */
export function createPluginToolFiles(params: {
  owner: string;
  bridge?: SandboxFsBridge;
  cwd?: string;
  registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => void;
  isCurrent?: () => boolean;
}): PluginToolFiles {
  const lifetime = new AbortController();
  params.registerRunCleanup(async () => { lifetime.abort(); });
  const assertActive = (signal?: AbortSignal) => {
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (params.isCurrent && !params.isCurrent()) {
      throw new Error("Artifact capability is no longer active");
    }
  };
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
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
    const { buffer } = await readMediaBuffer(entry.id, SUBDIR, MAX_BYTES);
    lookup(ref, signal);
    if (buffer.length !== entry.metadata.size || createHash("sha256").update(buffer).digest("hex") !== entry.metadata.sha256) {
      throw new Error("Artifact integrity check failed; import the source again");
    }
    return { entry, buffer };
  };
  const files: PluginToolFiles = {
    async importStream(input) {
      assertActive(input.signal);
      const maxBytes = byteLimit(input.maxBytes);
      const fileName = artifactName(input.fileName);
      if (artifacts.size + pendingImports >= MAX_ARTIFACTS || reservedBytes + maxBytes > MAX_TOTAL_BYTES) {
        throw new Error("Managed artifact capacity reached; retry after existing artifacts expire");
      }
      reservedBytes += maxBytes;
      pendingImports++;
      const hash = createHash("sha256");
      async function* checkedStream() {
        for await (const chunk of input.stream) {
          assertActive(input.signal);
          if (!(chunk instanceof Uint8Array)) {
            throw new Error("Artifact stream requires byte chunks");
          }
          // Copy before yielding so a producer cannot change bytes after hashing.
          const bytes = Buffer.from(chunk);
          hash.update(bytes);
          yield bytes;
        }
        assertActive(input.signal);
      }
      let saved: Awaited<ReturnType<typeof saveMediaStream>> | undefined;
      let published = false;
      try {
        saved = await saveMediaStream(checkedStream(), input.contentType, SUBDIR, maxBytes, fileName);
        assertActive(input.signal);
        const artifactRef = `artifact:${randomUUID()}`;
        const metadata: PluginArtifact = Object.freeze({ artifactRef, fileName, contentType: saved.contentType,
          size: saved.size, sha256: hash.digest("hex"), expiresAt: Date.now() + TTL_MS });
        artifacts.set(artifactRef, { owner: params.owner, id: saved.id, metadata });
        reservedBytes += saved.size;
        published = true;
        const timer = setTimeout(() => { void expireArtifact(artifactRef).catch(() => undefined); }, TTL_MS);
        timer.unref();
        return metadata;
      } finally {
        pendingImports--;
        reservedBytes -= maxBytes;
        if (saved && !published) {
          await deleteMediaBuffer(saved.id, SUBDIR);
        }
      }
    },
    async openStream(input) {
      const { entry, buffer } = await snapshot(input.artifactRef, input.signal);
      // Verify before exposing any bytes: a trailing digest would be too late for uploads.
      async function* stream() {
        for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
          lookup(input.artifactRef, input.signal);
          yield Buffer.from(buffer.subarray(offset, offset + 64 * 1024));
        }
        lookup(input.artifactRef, input.signal);
      }
      return { ...entry.metadata, stream: stream() };
    },
    async materialize(input) {
      const { entry, buffer } = await snapshot(input.artifactRef, input.signal);
      const bridge = params.bridge;
      if (!bridge || !params.cwd) {
        throw new Error("Active sandbox required for materialization");
      }
      const create = bridge.createFileExclusive;
      if (!create) {
        throw new Error("Sandbox backend does not support exclusive artifact creation");
      }
      const filePath = path.posix.join(".openclaw-artifacts", randomUUID(), entry.metadata.fileName);
      const result = await create.call(bridge, { filePath, cwd: params.cwd, data: buffer,
        mkdir: true, signal: signalFor(input.signal) });
      assertActive(input.signal);
      if (result !== "created") {
        throw new Error("Artifact destination already exists; retry materialization");
      }
      return { sandboxPath: bridge.resolvePath({ filePath, cwd: params.cwd }).containerPath, size: buffer.length };
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
      if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
        throw new Error("Artifact export must stay inside the active sandbox workspace");
      }
      const buffer = await bridge.readFile({ filePath: resolved.containerPath, cwd: params.cwd,
        maxBytes, signal: signalFor(input.signal) });
      assertActive(input.signal);
      return files.importStream({ stream: (async function* () { yield buffer; })(),
        fileName: input.fileName ?? path.posix.basename(resolved.containerPath),
        contentType: input.contentType, maxBytes, signal: input.signal });
    },
  };
  return files;
}
