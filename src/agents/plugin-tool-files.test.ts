import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveSessionResourceProjection } from "./execution-workspace.js";
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
        const projection = resolveSessionResourceProjection({
          bridge: bridgeFor(root),
          cwd: CONTAINER_ROOT,
          maxBytes: 1 << 20,
        });
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
        expect(materialized.size).toBe(bytes.byteLength);
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
        const projection = resolveSessionResourceProjection({
          bridge: bridgeFor(root),
          cwd: CONTAINER_ROOT,
          maxBytes: 1 << 20,
        });
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
          projection: resolveSessionResourceProjection({
            bridge: bridgeFor(root),
            cwd: CONTAINER_ROOT,
            maxBytes: 4096,
          }),
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
          projection: resolveSessionResourceProjection({ workspaceRoot: root, maxBytes: 1 << 20 }),
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
      const projection = resolveSessionResourceProjection({
        workspaceRoot: root,
        maxBytes: 1 << 24,
      });
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
          projection: resolveSessionResourceProjection({
            bridge: bridge,
            cwd: CONTAINER_ROOT,
            maxBytes: 1 << 20,
          }),
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
          projection: resolveSessionResourceProjection({
            bridge: bridgeFor(root),
            cwd: CONTAINER_ROOT,
            maxBytes: 100 * MIB,
          }),
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

  it("rejects a final-component symlink that escapes the authorized root", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-symlink-"));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-symlink-out-"));
      try {
        await fs.writeFile(path.join(outside, "secret.txt"), "SECRET");
        await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-link",
          agentId: "main",
          projection: resolveSessionResourceProjection({ workspaceRoot: root, maxBytes: 1 << 20 }),
          maxBytes: 1 << 20,
        });
        await expect(
          files.export({ workspacePath: path.join(root, "link.txt"), contentType: "text/plain" }),
        ).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("rejects an intermediate-directory symlink escape", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-mid-"));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-mid-out-"));
      try {
        await fs.writeFile(path.join(outside, "payload.txt"), "SECRET");
        await fs.mkdir(path.join(root, "sub"), { recursive: true });
        await fs.symlink(outside, path.join(root, "sub", "linkdir"));
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-mid",
          agentId: "main",
          projection: resolveSessionResourceProjection({ workspaceRoot: root, maxBytes: 1 << 20 }),
          maxBytes: 1 << 20,
        });
        await expect(
          files.export({
            workspacePath: path.join(root, "sub", "linkdir", "payload.txt"),
            contentType: "text/plain",
          }),
        ).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("rejects a hardlinked file", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-hard-"));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-hard-out-"));
      try {
        await fs.writeFile(path.join(outside, "real.txt"), "SECRET");
        await fs.link(path.join(outside, "real.txt"), path.join(root, "hard.txt"));
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-hard",
          agentId: "main",
          projection: resolveSessionResourceProjection({ workspaceRoot: root, maxBytes: 1 << 20 }),
          maxBytes: 1 << 20,
        });
        await expect(
          files.export({ workspacePath: path.join(root, "hard.txt"), contentType: "text/plain" }),
        ).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("keeps the durable resource after cleanup removes the workspace copy", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-lifecycle-"));
      try {
        const projection = resolveSessionResourceProjection({
          workspaceRoot: root,
          maxBytes: 1 << 20,
        });
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-life",
          agentId: "main",
          projection,
          maxBytes: 1 << 20,
        });
        const bytes = Buffer.from("durable-bytes");
        const artifact = await files.importStream({
          stream: byteStream(bytes),
          fileName: "d.txt",
          contentType: "text/plain",
        });
        const materialized = await files.materialize({ artifactRef: artifact.artifactRef });
        expect((await fs.stat(materialized.workspacePath)).isFile()).toBe(true);
        await projection.cleanup?.();
        await expect(fs.stat(materialized.workspacePath)).rejects.toThrow(/ENOENT/u);
        // The durable Session Resource is untouched by run cleanup.
        const opened = await files.openStream({ artifactRef: artifact.artifactRef });
        expect((await drain(opened.stream)).equals(bytes)).toBe(true);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("removes a partial local materialization when the source stream fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-partial-"));
    try {
      const projection = resolveSessionResourceProjection({
        workspaceRoot: root,
        maxBytes: 1 << 20,
      });
      async function* failing() {
        yield Buffer.from("partial-bytes");
        throw new Error("source failed");
      }
      await expect(projection.createFromStream("p.bin", failing())).rejects.toThrow(
        /source failed/u,
      );
      const leftovers = await fs
        .readdir(path.join(root, ".openclaw-session-resources"))
        .catch(() => [] as string[]);
      expect(leftovers).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a partial local materialization when the write is cancelled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-cancel-"));
    try {
      const controller = new AbortController();
      const projection = resolveSessionResourceProjection({
        workspaceRoot: root,
        maxBytes: 1 << 20,
      });
      async function* chunks() {
        yield Buffer.alloc(64 * 1024, 1);
        controller.abort();
        yield Buffer.alloc(64 * 1024, 2);
      }
      await expect(
        projection.createFromStream("c.bin", chunks(), controller.signal),
      ).rejects.toThrow();
      const leftovers = await fs
        .readdir(path.join(root, ".openclaw-session-resources"))
        .catch(() => [] as string[]);
      expect(leftovers).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a partial bridge materialization when the backend write fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-bridge-partial-"));
    try {
      const base = bridgeFor(root);
      const removed: string[] = [];
      const bridge = {
        ...base,
        remove: async (params: Parameters<typeof base.remove>[0]) => {
          removed.push(params.filePath);
          return base.remove(params);
        },
        writeFileStream: async (params: { stream: AsyncIterable<Uint8Array> }) => {
          // Consume one chunk, then fail mid-write.
          await params.stream[Symbol.asyncIterator]().next();
          throw new Error("backend write failed");
        },
      };
      const projection = resolveSessionResourceProjection({
        bridge: bridge,
        cwd: CONTAINER_ROOT,
        maxBytes: 1 << 20,
      });
      async function* src() {
        yield Buffer.from("a".repeat(1024));
      }
      await expect(projection.createFromStream("b.bin", src())).rejects.toThrow(
        /backend write failed/u,
      );
      expect(removed.some((filePath) => filePath.endsWith("b.bin"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
