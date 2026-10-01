import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredPluginArtifacts, createPluginToolFiles } from "./plugin-tool-files.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

// These boundary tests use the real media store and filesystem. The injected
// bridge is the same host-backed fixture used by existing sandbox tool tests.
describe("managed plugin artifact boundary", () => {
  let root: string;
  let cleanups: Array<(reason: string) => Promise<void>>;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "artifact-bridge-")));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    cleanups = [];
  });
  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup("test complete");
    }
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    await cleanupExpiredPluginArtifacts();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  function capability(
    owner = "agent/session/alice",
    sandbox = true,
    limits?: Parameters<typeof createPluginToolFiles>[0]["limits"],
  ) {
    const bridge = createSandboxFsBridgeFromResolver((filePath) => {
      const containerPath = path.posix.resolve("/workspace", filePath);
      const relativePath = path.posix.relative("/workspace", containerPath);
      return { containerPath, relativePath, hostPath: path.join(root, "sandbox", relativePath) };
    });
    return createPluginToolFiles({
      owner,
      limits,
      bridge: sandbox ? bridge : undefined,
      cwd: sandbox ? "/workspace" : undefined,
      registerRunCleanup: (cleanup) => cleanups.push(cleanup),
    });
  }
  async function* chunks(bytes = Buffer.from([0, 255, 1, 128, 42])) {
    yield bytes;
  }
  async function read(files: ReturnType<typeof capability>, artifactRef: string) {
    const result = await files.openStream({ artifactRef });
    const parts: Uint8Array[] = [];
    for await (const part of result.stream) {
      parts.push(part);
    }
    return Buffer.concat(parts);
  }
  it("round trips binary files through sandbox processing and returns metadata only", async () => {
    const files = capability();
    const original = Buffer.from([0, 255, 1, 128, 42]);
    const artifact = await files.importStream({ stream: chunks(original), fileName: "report.bin" });
    expect(artifact.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(JSON.stringify(artifact)).not.toContain(root);
    const local = await files.materialize({ artifactRef: artifact.artifactRef });
    const localPath = path.join(
      root,
      "sandbox",
      path.posix.relative("/workspace", local.sandboxPath),
    );
    expect(await fs.readFile(localPath)).toEqual(original);
    await fs.writeFile(localPath, Buffer.from("processed"));
    const exported = await files.export({ sandboxPath: local.sandboxPath });
    expect(await read(files, exported.artifactRef)).toEqual(Buffer.from("processed"));
    expect(await read(files, artifact.artifactRef)).toEqual(original);
  });
  it("isolates principals, allows the next owner turn, and fences retained streams on cleanup", async () => {
    const files = capability();
    const artifact = await files.importStream({ stream: chunks(), fileName: "file.bin" });
    await expect(
      capability("agent/session/bob").openStream({ artifactRef: artifact.artifactRef }),
    ).rejects.toThrow("unavailable");
    const retained = await files.openStream({ artifactRef: artifact.artifactRef });
    await cleanups[0]("finished");
    await expect(retained.stream[Symbol.asyncIterator]().next()).rejects.toThrow();
    await expect(files.openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow();
    expect(await read(capability(), artifact.artifactRef)).toEqual(
      Buffer.from([0, 255, 1, 128, 42]),
    );
  });
  it("rejects changed backing bytes before exposing a stream", async () => {
    const files = capability();
    const artifact = await files.importStream({ stream: chunks(), fileName: "file.bin" });
    const directory = path.join(root, "media", "outbound");
    const [stored] = await fs.readdir(directory);
    await fs.writeFile(path.join(directory, stored), Buffer.from("changed"));
    await expect(files.openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow(
      "integrity",
    );
  });
  it("cleans up failed oversized imports and expires references", async () => {
    const files = capability();
    await expect(
      files.importStream({ stream: chunks(), fileName: "large.bin", maxBytes: 2 }),
    ).rejects.toThrow("exceeds");
    expect(await fs.readdir(path.join(root, "media", "outbound"))).toEqual([]);
    const artifact = await files.importStream({ stream: chunks(), fileName: "file.bin" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    await expect(files.openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow(
      "unavailable",
    );
  });
  it("imports without a sandbox but refuses materialization and external workspace exports", async () => {
    const files = capability("agent/session/alice", false);
    const artifact = await files.importStream({ stream: chunks(), fileName: "file.bin" });
    expect(await read(files, artifact.artifactRef)).toHaveLength(5);
    await expect(files.materialize({ artifactRef: artifact.artifactRef })).rejects.toThrow(
      "sandbox required",
    );
    await expect(capability().export({ sandboxPath: "/outside/secret" })).rejects.toThrow(
      "workspace",
    );
    await expect(files.importStream({ stream: chunks(), fileName: "../secret" })).rejects.toThrow(
      "filename",
    );
  });
  it("does not publish an import when its run closes during streaming", async () => {
    const files = capability();
    async function* interrupted() {
      yield Buffer.from("first");
      await cleanups[0]("cancelled");
      yield Buffer.from("last");
    }
    await expect(
      files.importStream({ stream: interrupted(), fileName: "partial.bin" }),
    ).rejects.toThrow();
    expect(await fs.readdir(path.join(root, "media", "outbound"))).toEqual([]);
  });
  it("streams a file above 64 MiB through import, materialize, export, and upload", async () => {
    const files = capability();
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const count = 1041;
    async function* generated() {
      for (let i = 0; i < count; i++) {
        yield chunk;
      }
    }
    const artifact = await files.importStream({
      stream: generated(),
      fileName: "large.bin",
      maxBytes: count * chunk.length,
    });
    const materialized = await files.materialize({ artifactRef: artifact.artifactRef });
    const exported = await files.export({
      sandboxPath: materialized.sandboxPath,
      maxBytes: artifact.size,
    });
    const opened = await files.openStream({ artifactRef: exported.artifactRef });
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const part of opened.stream) {
      expect(part.byteLength).toBeLessThanOrEqual(64 * 1024);
      hash.update(part);
      bytes += part.length;
    }
    expect(bytes).toBe(count * chunk.length);
    expect(hash.digest("hex")).toBe(artifact.sha256);
    expect(exported.sha256).toBe(artifact.sha256);
  });
  it("keeps verified upload bytes immutable when the original backing file changes", async () => {
    const files = capability();
    const artifact = await files.importStream({
      stream: chunks(Buffer.from("original")),
      fileName: "immutable.bin",
    });
    const opened = await files.openStream({ artifactRef: artifact.artifactRef });
    const directory = path.join(root, "media", "outbound");
    for (const name of await fs.readdir(directory)) {
      await fs.writeFile(path.join(directory, name), "tampered");
    }
    const parts: Uint8Array[] = [];
    for await (const part of opened.stream) {
      parts.push(part);
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from("original"));
    await expect(files.openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow(
      "integrity",
    );
  });
  it("cancels suspended producers, removes partial data, and releases transfer capacity", async () => {
    const files = capability("agent/session/alice", true, {
      maxBytes: 16,
      totalBytes: 32,
      maxConcurrentTransfers: 1,
    });
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    async function* suspended() {
      yield Buffer.from("partial");
      started();
      await new Promise(() => {});
    }
    const pending = files.importStream({
      stream: suspended(),
      fileName: "cancel.bin",
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await ready;
    await expect(
      files.importStream({ stream: chunks(), fileName: "concurrent.bin" }),
    ).rejects.toThrow("capacity");
    controller.abort(new Error("cancel transfer"));
    await rejected;
    expect(await fs.readdir(path.join(root, "media", "outbound"))).toEqual([]);
    expect((await files.importStream({ stream: chunks(), fileName: "recovered.bin" })).size).toBe(
      5,
    );
  });
  it("enforces configurable reservation, per-file, and artifact-count quotas", async () => {
    const files = capability("agent/session/alice", true, {
      maxBytes: 8,
      totalBytes: 12,
      maxArtifacts: 2,
    });
    await expect(
      files.importStream({ stream: chunks(), fileName: "overlimit.bin", maxBytes: 9 }),
    ).rejects.toThrow("byte limit");
    await files.importStream({ stream: chunks(), fileName: "first.bin" });
    await expect(
      files.importStream({ stream: chunks(), fileName: "reserved.bin" }),
    ).rejects.toThrow("capacity");
    await files.importStream({ stream: chunks(), fileName: "second.bin", maxBytes: 5 });
    await expect(
      files.importStream({ stream: chunks(), fileName: "third.bin", maxBytes: 1 }),
    ).rejects.toThrow("capacity");
  });
  it("refuses exports without a sandbox and rejects traversal paths", async () => {
    await expect(
      capability("agent/session/alice", false).export({ sandboxPath: "/workspace/file.bin" }),
    ).rejects.toThrow("sandbox required");
    await expect(capability().export({ sandboxPath: "../../secret" })).rejects.toThrow("workspace");
  });
  it("round trips an empty artifact without reserving a full file in memory", async () => {
    const files = capability();
    const artifact = await files.importStream({
      stream: chunks(Buffer.alloc(0)),
      fileName: "empty.bin",
    });
    expect(artifact.size).toBe(0);
    const local = await files.materialize({ artifactRef: artifact.artifactRef });
    const exported = await files.export({ sandboxPath: local.sandboxPath });
    expect(await read(files, exported.artifactRef)).toHaveLength(0);
  });
  it("removes partial materializations when cancellation interrupts sandbox writing", async () => {
    const controller = new AbortController();
    const bridge = createSandboxFsBridgeFromResolver((filePath) => {
      const containerPath = path.posix.resolve("/workspace", filePath);
      const relativePath = path.posix.relative("/workspace", containerPath);
      return { containerPath, relativePath, hostPath: path.join(root, "sandbox", relativePath) };
    });
    const create = bridge.createFileExclusiveStream!;
    bridge.createFileExclusiveStream = async (input) => {
      async function* interrupted() {
        for await (const chunk of input.stream) {
          yield chunk;
          controller.abort(new Error("cancel sandbox write"));
        }
      }
      return create({ ...input, stream: interrupted() });
    };
    const files = createPluginToolFiles({
      owner: "alice",
      bridge,
      cwd: "/workspace",
      registerRunCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const artifact = await files.importStream({
      stream: chunks(Buffer.alloc(128 * 1024)),
      fileName: "cancel.bin",
    });
    await expect(
      files.materialize({ artifactRef: artifact.artifactRef, signal: controller.signal }),
    ).rejects.toThrow();
    const walk = async (directory: string): Promise<string[]> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return (
        await Promise.all(
          entries.map((entry) =>
            entry.isDirectory() ? walk(path.join(directory, entry.name)) : [entry.name],
          ),
        )
      ).flat();
    };
    expect(await walk(path.join(root, "sandbox"))).toEqual([]);
    expect(await read(files, artifact.artifactRef)).toHaveLength(128 * 1024);
  });
  it("drains materialization before workspace cleanup and releases its reserved capacity", async () => {
    let runCleanup!: (reason: string) => Promise<void>;
    let cleaning: Promise<void> | undefined;
    let created = false;
    const events: string[] = [];
    const files = createPluginToolFiles({
      owner: "race-owner",
      limits: { maxBytes: 4, totalBytes: 12 },
      workspace: {
        backend: "restricted-host",
        async create(_fileName, stream) {
          for await (const _chunk of stream) {
            /* consume the verified snapshot before closing the run */
          }
          cleaning = runCleanup("run closed during materialization");
          created = true;
          return "/generated/materialization.bin";
        },
        async *read() {
          yield Buffer.alloc(0);
        },
        async remove() {
          if (!created) {
            throw new Error("workspace already reclaimed");
          }
          events.push("remove materialization");
          created = false;
        },
        async cleanup() {
          events.push("cleanup workspace");
          created = false;
        },
      },
      registerRunCleanup(cleanup) {
        runCleanup = cleanup;
        cleanups.push(cleanup);
      },
    });
    const artifact = await files.importStream({
      stream: chunks(Buffer.alloc(4)),
      fileName: "source.bin",
    });
    await expect(files.materialize({ artifactRef: artifact.artifactRef })).rejects.toThrow();
    expect(cleaning).toBeDefined();
    await cleaning;
    expect(events).toEqual(["remove materialization", "cleanup workspace"]);
    const next = capability("race-owner", false, { maxBytes: 12, totalBytes: 12 });
    await next.remove!({ artifactRef: artifact.artifactRef });
    expect(
      (await next.importStream({ stream: chunks(Buffer.alloc(12)), fileName: "capacity.bin" }))
        .size,
    ).toBe(12);
  });
});
