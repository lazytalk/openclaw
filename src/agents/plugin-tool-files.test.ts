import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";
import { createPluginToolFiles } from "./plugin-tool-files.js";

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
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  function capability(owner = "agent/session/alice", sandbox = true) {
    const bridge = createSandboxFsBridgeFromResolver((filePath) => {
      const containerPath = path.posix.resolve("/workspace", filePath);
      const relativePath = path.posix.relative("/workspace", containerPath);
      return { containerPath, relativePath, hostPath: path.join(root, "sandbox", relativePath) };
    });
    return createPluginToolFiles({ owner, bridge: sandbox ? bridge : undefined,
      cwd: sandbox ? "/workspace" : undefined,
      registerRunCleanup: (cleanup) => cleanups.push(cleanup) });
  }
  async function* chunks(bytes = Buffer.from([0, 255, 1, 128, 42])) { yield bytes; }
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
    const localPath = path.join(root, "sandbox", path.posix.relative("/workspace", local.sandboxPath));
    expect(await fs.readFile(localPath)).toEqual(original);
    await fs.writeFile(localPath, Buffer.from("processed"));
    const exported = await files.export({ sandboxPath: local.sandboxPath });
    expect(await read(files, exported.artifactRef)).toEqual(Buffer.from("processed"));
    expect(await read(files, artifact.artifactRef)).toEqual(original);
  });
  it("isolates principals, allows the next owner turn, and fences retained streams on cleanup", async () => {
    const files = capability();
    const artifact = await files.importStream({ stream: chunks(), fileName: "file.bin" });
    await expect(capability("agent/session/bob").openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow("unavailable");
    const retained = await files.openStream({ artifactRef: artifact.artifactRef });
    await cleanups[0]("finished");
    await expect(retained.stream[Symbol.asyncIterator]().next()).rejects.toThrow();
    await expect(files.openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow();
    expect(await read(capability(), artifact.artifactRef)).toEqual(Buffer.from([0, 255, 1, 128, 42]));
  });
  it("rejects changed backing bytes before exposing a stream", async () => {
    const files = capability();
    const artifact = await files.importStream({ stream: chunks(), fileName: "file.bin" });
    const directory = path.join(root, "media", "outbound");
    const [stored] = await fs.readdir(directory);
    await fs.writeFile(path.join(directory, stored), Buffer.from("changed"));
    await expect(files.openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow("integrity");
  });
  it("cleans up failed oversized imports and expires references", async () => {
    const files = capability();
    await expect(files.importStream({ stream: chunks(), fileName: "large.bin", maxBytes: 2 })).rejects.toThrow("exceeds");
    expect(await fs.readdir(path.join(root, "media", "outbound"))).toEqual([]);
    const artifact = await files.importStream({ stream: chunks(), fileName: "file.bin" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    await expect(files.openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow("unavailable");
  });
  it("imports without a sandbox but refuses materialization and external workspace exports", async () => {
    const files = capability("agent/session/alice", false);
    const artifact = await files.importStream({ stream: chunks(), fileName: "file.bin" });
    expect(await read(files, artifact.artifactRef)).toHaveLength(5);
    await expect(files.materialize({ artifactRef: artifact.artifactRef })).rejects.toThrow("sandbox required");
    await expect(capability().export({ sandboxPath: "/outside/secret" })).rejects.toThrow("workspace");
    await expect(files.importStream({ stream: chunks(), fileName: "../secret" })).rejects.toThrow("filename");
  });
  it("does not publish an import when its run closes during streaming", async () => {
    const files = capability();
    async function* interrupted() {
      yield Buffer.from("first");
      await cleanups[0]("cancelled");
      yield Buffer.from("last");
    }
    await expect(files.importStream({ stream: interrupted(), fileName: "partial.bin" })).rejects.toThrow();
    expect(await fs.readdir(path.join(root, "media", "outbound"))).toEqual([]);
  });
});
