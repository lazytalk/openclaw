import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bridgeProjection, localExecutionProjection } from "./execution-workspace.js";
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
          streaming: true,
          maxBytes: 4096,
          materialize: true,
          export: true,
          backend: "sandbox",
        });
        const unavailable = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          maxBytes: 4096,
        });
        expect(unavailable.capabilities).toMatchObject({
          backend: "unavailable",
          materialize: false,
          export: false,
          streaming: true,
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
        expect(files.capabilities.backend).toBe("host");
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
