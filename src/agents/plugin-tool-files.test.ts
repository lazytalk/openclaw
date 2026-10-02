import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sandboxExecutionWorkspace } from "./execution-workspace.js";
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

describe("plugin ctx.files adapter", () => {
  it("round-trips bytes through native custody and a sandbox workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-files-"));
      try {
        const workspace = sandboxExecutionWorkspace(bridgeFor(root), CONTAINER_ROOT, 1 << 20);
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          workspace,
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
        const workspace = sandboxExecutionWorkspace(bridgeFor(root), CONTAINER_ROOT, 1 << 20);
        const files = createPluginToolFiles({
          sessionKey: "agent:main:main",
          sessionId: "sess-o365",
          agentId: "main",
          workspace,
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
