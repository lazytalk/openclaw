import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { root as fsRoot } from "../infra/fs-safe.js";
import {
  reapHostExecutionWorkspaces,
  removeWorkspaceTree,
} from "./execution-workspace-lifecycle.js";
import {
  restrictedHostExecutionWorkspace,
  resolveExecutionWorkspace,
} from "./execution-workspace.js";
import { createPluginToolFiles } from "./plugin-tool-files.js";

describe("restricted host execution workspace", () => {
  let state: string;
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  beforeEach(async () => {
    state = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-host-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup("finished");
    }
    vi.unstubAllEnvs();
    await fs.rm(state, { recursive: true, force: true });
  });
  const stream = async function* (value = "probe") {
    yield Buffer.from(value);
  };
  const filesFor = (owner = "agent/session/alice") =>
    createPluginToolFiles({
      owner,
      workspace: resolveExecutionWorkspace({ owner, config: { mode: "restricted-host" } }),
      registerRunCleanup: (cleanup) => cleanups.push(cleanup),
    });
  it("is disabled by default and never falls back from an unsupported sandbox", () => {
    expect(resolveExecutionWorkspace({ owner: "alice" })).toBeUndefined();
    expect(
      resolveExecutionWorkspace({
        owner: "alice",
        sandboxed: true,
        config: { mode: "restricted-host" },
      }),
    ).toBeUndefined();
    expect(
      resolveExecutionWorkspace({ owner: "alice", config: { mode: "restricted-host" } })?.backend,
    ).toBe("restricted-host");
  });
  it("round trips copies, checks integrity, isolates owners and removes generated files", async () => {
    const files = filesFor();
    expect(files.capabilities).toMatchObject({
      backend: "restricted-host",
      contractVersion: 2,
      materialize: true,
      export: true,
    });
    const artifact = await files.importStream({ stream: stream(), fileName: "probe.txt" });
    const local = await files.materialize({ artifactRef: artifact.artifactRef });
    expect(local.workspacePath).toBe(local.sandboxPath);
    expect(local.sandboxPath.startsWith(path.join(state, "runtime-workspaces"))).toBe(true);
    expect(await fs.readFile(local.sandboxPath, "utf8")).toBe("probe");
    const copied = await files.copyMaterialized!({ workspacePath: local.sandboxPath });
    await fs.writeFile(copied.workspacePath, "modified");
    const exported = await files.export({ workspacePath: copied.workspacePath });
    expect(exported.sha256).toBe(createHash("sha256").update("modified").digest("hex"));
    const opened = await files.openStream({ artifactRef: exported.artifactRef });
    const bytes = [];
    for await (const chunk of opened.stream) {
      bytes.push(chunk);
    }
    expect(Buffer.concat(bytes).toString()).toBe("modified");
    const other = filesFor("agent/other-session/alice");
    await expect(other.export({ workspacePath: local.sandboxPath })).rejects.toThrow("workspace");
    await expect(
      filesFor("agent/session/bob").openStream({ artifactRef: artifact.artifactRef }),
    ).rejects.toThrow("unavailable");
    await files.removeMaterialized!({ workspacePath: copied.workspacePath });
    await files.remove!({ artifactRef: exported.artifactRef });
    await files.remove!({ artifactRef: artifact.artifactRef });
    await expect(files.openStream({ artifactRef: artifact.artifactRef })).rejects.toThrow(
      "unavailable",
    );
    await cleanups.shift()!("finished");
    await expect(fs.stat(path.dirname(local.sandboxPath))).rejects.toThrow();
    await expect(files.materialize({ artifactRef: artifact.artifactRef })).rejects.toThrow();
  });
  it("rejects traversal, symlinks, hardlinks and persistent agent workspace access", async () => {
    const workspace = restrictedHostExecutionWorkspace("alice");
    cleanups.push(() => workspace.cleanup());
    const local = await workspace.create("probe.txt", stream());
    const outside = path.join(state, "agents", "persistent", "secret.txt");
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, "secret");
    const read = async (filePath: string) => {
      for await (const _chunk of workspace.read(filePath, 100)) {
        /* consume */
      }
    };
    for (const escaped of [
      outside,
      "/etc/passwd",
      "~/.ssh/key",
      "../secret",
      `${path.dirname(local)}/../secret`,
      "C:\\secret",
      "probe.txt:secret",
    ]) {
      await expect(read(escaped)).rejects.toThrow();
    }
    const symlink = path.join(path.dirname(local), "alias");
    await fs.symlink(
      path.dirname(outside),
      symlink,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(read(path.join(symlink, "secret.txt"))).rejects.toThrow();
    await fs.rm(symlink);
    const hardlink = path.join(path.dirname(local), "hardlink");
    await fs.link(outside, hardlink);
    await expect(read(hardlink)).rejects.toThrow();
    await fs.unlink(hardlink);
    expect(await fs.readFile(outside, "utf8")).toBe("secret");
    await workspace.cleanup();
    cleanups.pop();
  });
  it("cleans partial creation and run-created processing outputs", async () => {
    const workspace = restrictedHostExecutionWorkspace("alice");
    const controller = new AbortController();
    async function* interrupted() {
      yield Buffer.from("first");
      controller.abort();
      yield Buffer.from("last");
    }
    await expect(
      workspace.create("partial.bin", interrupted(), controller.signal),
    ).rejects.toThrow();
    const local = await workspace.create("probe.txt", stream());
    await fs.mkdir(path.join(path.dirname(local), "outputs"));
    await fs.writeFile(path.join(path.dirname(local), "outputs", "result.bin"), "output");
    await workspace.cleanup();
    await expect(fs.stat(path.dirname(local))).rejects.toThrow();
  });
  it("reclaims previous-process roots while preserving active runs and persistent files", async () => {
    const workspace = restrictedHostExecutionWorkspace("alice");
    cleanups.push(() => workspace.cleanup());
    const active = await workspace.create("active.txt", stream());
    const stale = path.join(
      state,
      "runtime-workspaces",
      "a".repeat(64),
      "11111111-1111-1111-1111-111111111111",
    );
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(
      path.join(stale, ".openclaw-owner.json"),
      JSON.stringify({ pid: process.pid, processIdentity: "previous-process" }),
    );
    await fs.writeFile(path.join(stale, "result.bin"), "orphan");
    const persistent = path.join(state, "agents", "persistent.txt");
    await fs.mkdir(path.dirname(persistent), { recursive: true });
    await fs.writeFile(persistent, "keep");
    await reapHostExecutionWorkspaces(state);
    await expect(fs.stat(stale)).rejects.toThrow();
    expect(await fs.readFile(active, "utf8")).toBe("probe");
    expect(await fs.readFile(persistent, "utf8")).toBe("keep");
  });
  it("retains the dead-process lease when reclamation fails and retries the remaining files", async () => {
    const stale = path.join(
      state,
      "runtime-workspaces",
      "b".repeat(64),
      "22222222-2222-2222-2222-222222222222",
    );
    await fs.mkdir(stale, { recursive: true });
    const leasePath = path.join(stale, ".openclaw-owner.json");
    const lease = JSON.stringify({ pid: process.pid, processIdentity: "previous-process" });
    await fs.writeFile(leasePath, lease);
    const outputPath = path.join(stale, "result.bin");
    await fs.writeFile(outputPath, "orphan");
    const storage = await fsRoot(stale, { symlinks: "reject", hardlinks: "reject" });
    const remove = storage.remove.bind(storage);
    const blockedDelete = vi.spyOn(storage, "remove").mockImplementation(async (filePath) => {
      if (filePath === "result.bin") {
        throw Object.assign(new Error("temporary deletion failure"), { code: "EACCES" });
      }
      await remove(filePath);
    });
    try {
      await expect(removeWorkspaceTree(storage)).rejects.toThrow("temporary deletion failure");
      expect(await fs.readFile(leasePath, "utf8")).toBe(lease);
      expect(await fs.readFile(outputPath, "utf8")).toBe("orphan");
    } finally {
      blockedDelete.mockRestore();
    }
    await reapHostExecutionWorkspaces(state);
    await expect(fs.stat(stale)).rejects.toThrow();
  });
});
