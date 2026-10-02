import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  bridgeProjection,
  localExecutionProjection,
  mountedResourceCopyProjection,
  resolveProjectedMount,
} from "./execution-workspace.js";
import { createPluginToolFiles } from "./plugin-tool-files.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

const CONTAINER_ROOT = "/workspace";

function bridgeFor(root: string) {
  return createSandboxFsBridgeFromResolver((filePath, cwd = CONTAINER_ROOT) => {
    const containerPath = path.posix.resolve(cwd, filePath);
    const relativePath = path.posix.relative(CONTAINER_ROOT, containerPath);
    return {
      hostPath: path.join(root, relativePath),
      relativePath,
      containerPath,
    };
  });
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function byteStream(bytes: Buffer): AsyncIterable<Uint8Array> {
  return (async function* stream() {
    yield bytes.subarray(0, 5);
    yield bytes.subarray(5);
  })();
}

async function findFirstFileSize(root: string): Promise<number> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const stat = await fs.stat(path.join(entry.parentPath ?? root, entry.name)).catch(() => null);
    if (stat?.isFile() && stat.size > 0) {
      return stat.size;
    }
  }
  return 0;
}

describe("plugin ctx.files adapter", () => {
  it("round-trips bytes through native custody and a sandbox workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-files-"));
      try {
        const projection = bridgeProjection(bridgeFor(root), CONTAINER_ROOT, 1 << 20);
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          projection,
          maxBytes: 1 << 20,
        });
        const bytes = Buffer.from("plugin-round-trip");
        const artifact = await files.importStream({
          stream: byteStream(bytes),
          fileName: "a.txt",
          contentType: "text/plain",
        });
        expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

        const materialized = await files.materialize({ artifactRef: artifact.artifactRef });
        expect(materialized.workspacePath.startsWith(`${CONTAINER_ROOT}/`)).toBe(true);
        expect(materialized.backend).toBe("sandbox");
        const hostFile = path.join(
          root,
          path.posix.relative(CONTAINER_ROOT, materialized.workspacePath),
        );
        expect((await fs.readFile(hostFile)).equals(bytes)).toBe(true);

        const second = await files.materialize({ artifactRef: artifact.artifactRef });
        expect(second.workspacePath).not.toBe(materialized.workspacePath);

        const opened = await files.openStream({ artifactRef: artifact.artifactRef });
        expect((await drain(opened.stream)).equals(bytes)).toBe(true);

        await fs.writeFile(path.join(root, "out.txt"), Buffer.from("exported"));
        const exported = await files.export({
          workspacePath: `${CONTAINER_ROOT}/out.txt`,
          fileName: "out.txt",
        });
        expect(exported.size).toBe(8);
        const openedExport = await files.openStream({ artifactRef: exported.artifactRef });
        expect((await drain(openedExport.stream)).toString()).toBe("exported");

        await expect(files.export({ workspacePath: "/etc/passwd" })).rejects.toThrow(/workspace/u);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
      expect(state.stateDir).toBeTruthy();
    });
  });

  it("round-trips a Graph-shaped download through processing back to an upload", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "office365-roundtrip-"));
      try {
        const projection = bridgeProjection(bridgeFor(root), CONTAINER_ROOT, 1 << 20);
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-o365",
          agentId: "main",
          projection,
          maxBytes: 1 << 20,
        });
        // Microsoft Graph "download response body" -> provider stream.
        const downloaded = Buffer.from("PK\u0003\u0004 office365 document bytes");
        const reviewed = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const imported = await files.importStream({
          stream: byteStream(downloaded),
          fileName: "invoice.docx",
          contentType: reviewed,
        });
        // Processing step: materialize, then write a transformed output into the workspace.
        const materialized = await files.materialize({ artifactRef: imported.artifactRef });
        const materializedHost = path.join(
          root,
          path.posix.relative(CONTAINER_ROOT, materialized.workspacePath),
        );
        const inputBytes = await fs.readFile(materializedHost);
        const processed = Buffer.concat([Buffer.from("PROCESSED:"), inputBytes]);
        await fs.writeFile(path.join(root, "processed.docx"), processed);
        const exported = await files.export({
          workspacePath: `${CONTAINER_ROOT}/processed.docx`,
          fileName: "processed.docx",
          contentType: reviewed,
        });
        // Microsoft Graph upload session consumer drains the provider stream.
        const uploaded: Buffer[] = [];
        const opened = await files.openStream({ artifactRef: exported.artifactRef });
        for await (const chunk of opened.stream) {
          uploaded.push(Buffer.from(chunk));
        }
        expect(Buffer.concat(uploaded).equals(processed)).toBe(true);
        expect(exported.sha256).toBe(createHash("sha256").update(processed).digest("hex"));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
      expect(state.stateDir).toBeTruthy();
    });
  });

  it("reports effective session resource capabilities for the current placement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-caps-"));
      try {
        const sandboxed = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          projection: bridgeProjection(bridgeFor(root), CONTAINER_ROOT, 4096),
          maxBytes: 4096,
        });
        expect(sandboxed.capabilities).toEqual({
          contractVersion: 3,
          resource: { streamingImport: true, streamingOpen: true, maxBytes: 4096 },
          projection: {
            materialize: true,
            materializeMaxBytes: 4096,
            export: true,
            exportMaxBytes: 4096,
          },
        });
        const unavailable = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          maxBytes: 4096,
        });
        expect(unavailable.capabilities).toMatchObject({
          resource: { streamingImport: true, streamingOpen: true, maxBytes: 4096 },
          projection: { materialize: false, export: false },
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("projects through native local execution without a sandbox bridge", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-local-"));
      try {
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-local",
          agentId: "main",
          projection: localExecutionProjection(root, 1 << 20),
          maxBytes: 1 << 20,
        });
        expect(files.capabilities.projection).toEqual({
          materialize: true,
          materializeMaxBytes: 1 << 20,
          export: true,
          exportMaxBytes: 1 << 20,
        });
        const bytes = Buffer.from("local-placement-bytes");
        const artifact = await files.importStream({
          stream: byteStream(bytes),
          fileName: "local.bin",
          contentType: "text/plain",
        });
        const materialized = await files.materialize({ artifactRef: artifact.artifactRef });
        expect(materialized.backend).toBe("host");
        expect(materialized.workspacePath.startsWith(`${root}${path.sep}`)).toBe(true);
        expect((await fs.readFile(materialized.workspacePath)).equals(bytes)).toBe(true);
        await fs.writeFile(path.join(root, "out.txt"), Buffer.from("local-export"));
        const exported = await files.export({
          workspacePath: path.join(root, "out.txt"),
          contentType: "text/plain",
        });
        const opened = await files.openStream({ artifactRef: exported.artifactRef });
        expect((await drain(opened.stream)).toString()).toBe("local-export");
        await expect(files.export({ workspacePath: "/etc/passwd" })).rejects.toThrow(/workspace/u);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("writes the workspace file incrementally while the source stream is still open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-stream-"));
    try {
      const projection = localExecutionProjection(root, 1 << 24);
      const CHUNK = 32 * 1024;
      const CHUNKS = 16;
      const total = CHUNK * CHUNKS;
      let partialSizeDuringStream = -1;
      async function* source() {
        for (let index = 0; index < CHUNKS; index++) {
          yield Buffer.alloc(CHUNK, index % 251);
          if (index === 0) {
            const deadline = Date.now() + 2_000;
            while (Date.now() < deadline && partialSizeDuringStream < 0) {
              await new Promise((resolve) => {
                setTimeout(resolve, 2);
              });
              partialSizeDuringStream = await findFirstFileSize(root);
            }
          }
        }
      }
      const created = await projection.createFromStream("big.bin", source());
      // A whole-file buffer would leave the file empty until the source ends.
      expect(partialSizeDuringStream).toBeGreaterThan(0);
      expect(partialSizeDuringStream).toBeLessThan(total);
      expect(created.size).toBe(total);
      expect((await fs.stat(created.workspacePath)).size).toBe(total);
      const readChunks: number[] = [];
      for await (const chunk of projection.openReadStream(created.workspacePath, 1 << 24)) {
        readChunks.push(chunk.byteLength);
      }
      expect(readChunks.length).toBeGreaterThan(1);
      expect(readChunks.reduce((sum, value) => sum + value, 0)).toBe(total);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("projects a sandbox resource through the read-only mount and native copy", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-mount-ws-"));
    const stagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-mount-staged-"));
    const mountPath = "/openclaw/attachments";
    try {
      const resolvePath = (filePath: string, cwd = CONTAINER_ROOT) => {
        const normalized = filePath.replace(/\\/gu, "/");
        if (normalized === mountPath || normalized.startsWith(`${mountPath}/`)) {
          const relativePath = normalized.slice(mountPath.length).replace(/^\//u, "");
          return {
            hostPath: path.join(stagedRoot, relativePath),
            relativePath,
            containerPath: relativePath ? `${mountPath}/${relativePath}` : mountPath,
          };
        }
        const containerPath = path.posix.resolve(cwd, filePath);
        const relativePath = path.posix.relative(CONTAINER_ROOT, containerPath);
        return {
          hostPath: path.join(workspaceRoot, relativePath),
          relativePath,
          containerPath,
        };
      };
      const base = createSandboxFsBridgeFromResolver(resolvePath, [
        { hostRoot: workspaceRoot, containerRoot: CONTAINER_ROOT },
        { hostRoot: stagedRoot, containerRoot: mountPath },
      ]);
      let copyFileCalls = 0;
      let writeFileCalls = 0;
      const bridge = {
        ...base,
        copyFile: async (params: Parameters<NonNullable<typeof base.copyFile>>[0]) => {
          copyFileCalls += 1;
          return base.copyFile!(params);
        },
        writeFile: async (params: Parameters<typeof base.writeFile>[0]) => {
          writeFileCalls += 1;
          return base.writeFile(params);
        },
      };
      expect(resolveProjectedMount(bridge, stagedRoot)).toBe(mountPath);
      const projection = mountedResourceCopyProjection({
        bridge,
        cwd: CONTAINER_ROOT,
        maxBytes: 1 << 20,
        projectedRoot: stagedRoot,
        projectedMount: mountPath,
      });
      const bytes = Buffer.from("sandbox-native-copy-no-buffer");
      const created = await projection.createFromStream("a.txt", byteStream(bytes));
      expect(copyFileCalls).toBe(1);
      expect(writeFileCalls).toBe(0);
      expect(created.size).toBe(bytes.byteLength);
      const hostFile = path.join(
        workspaceRoot,
        path.posix.relative(CONTAINER_ROOT, created.workspacePath),
      );
      expect((await fs.readFile(hostFile)).equals(bytes)).toBe(true);
      await projection.cleanup?.();
      expect(await fs.readdir(stagedRoot)).toHaveLength(0);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(stagedRoot, { recursive: true, force: true });
    }
  });

  it("streams export from the authorized host backing path without bridge reads", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-export-"));
      try {
        const base = bridgeFor(root);
        let readFileCalls = 0;
        const bridge = {
          ...base,
          readFile: async (params: Parameters<typeof base.readFile>[0]) => {
            readFileCalls += 1;
            return base.readFile(params);
          },
        };
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-export",
          agentId: "main",
          projection: bridgeProjection(bridge, CONTAINER_ROOT, 1 << 20),
          maxBytes: 1 << 20,
        });
        const big = Buffer.alloc(150 * 1024, 7);
        await fs.writeFile(path.join(root, "big.bin"), big);
        const exported = await files.export({
          workspacePath: `${CONTAINER_ROOT}/big.bin`,
          contentType: "application/octet-stream",
        });
        expect(exported.size).toBe(big.byteLength);
        expect(readFileCalls).toBe(0);
        const opened = await files.openStream({ artifactRef: exported.artifactRef });
        expect((await drain(opened.stream)).equals(big)).toBe(true);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("keeps resource capacity independent of a bounded projection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-split-"));
      try {
        const MIB = 1024 * 1024;
        // A buffered bridge (no streaming primitives) cannot declare the full
        // resource ceiling for projection.
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          projection: bridgeProjection(bridgeFor(root), CONTAINER_ROOT, 100 * MIB),
          maxBytes: 100 * MIB,
        });
        expect(files.capabilities.resource.maxBytes).toBe(100 * MIB);
        expect(files.capabilities.projection.materializeMaxBytes).toBe(50 * MIB);
        expect(files.capabilities.projection.exportMaxBytes).toBe(50 * MIB);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("refuses an oversized materialize explicitly and keeps the resource readable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-over-"));
      try {
        let createCalled = false;
        const projection = {
          backend: "sandbox" as const,
          materializeMaxBytes: 4,
          exportMaxBytes: 4,
          async createFromStream() {
            createCalled = true;
            return { workspacePath: "/workspace/should-not-happen", size: 0 };
          },
          async *openReadStream() {
            yield Buffer.alloc(0);
          },
        };
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-over",
          agentId: "main",
          projection,
          maxBytes: 1 << 20,
        });
        const bytes = Buffer.from("sixteen-bytes-ok");
        const artifact = await files.importStream({
          stream: byteStream(bytes),
          fileName: "over.bin",
          contentType: "application/octet-stream",
        });
        await expect(files.materialize({ artifactRef: artifact.artifactRef })).rejects.toThrow(
          /materializes at most 4 bytes/u,
        );
        expect(createCalled).toBe(false);
        // The refusal does not damage the durable resource.
        const opened = await files.openStream({ artifactRef: artifact.artifactRef });
        expect((await drain(opened.stream)).equals(bytes)).toBe(true);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("fails closed for projection without an execution workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const files = createPluginToolFiles({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        agentId: "main",
        maxBytes: 1 << 20,
      });
      const artifact = await files.importStream({
        stream: byteStream(Buffer.from("no-workspace")),
        fileName: "a.txt",
        contentType: "text/plain",
      });
      await expect(files.materialize({ artifactRef: artifact.artifactRef })).rejects.toThrow(
        /workspace/u,
      );
      await expect(
        files.export({ workspacePath: `${CONTAINER_ROOT}/missing.bin` }),
      ).rejects.toThrow(/workspace/u);
    });
  });
});
