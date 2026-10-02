import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { ToolsSchema } from "../config/zod-schema.agent-runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveManagedImageOriginalPath } from "./managed-image-attachments.custody.js";
import { cleanupManagedOutgoingMediaRecords } from "./managed-image-attachments.js";
import {
  claimManagedImageRecordCleanupIfCurrent,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import { parseManagedOutgoingArtifactId } from "./managed-outgoing-artifact-id.js";
import { readSessionResourceArtifacts } from "./server-methods/artifacts-session-resources.js";
import {
  importSessionResourceStream,
  listSessionResourcesForScope,
  openSessionResourceStream,
  resolveSessionRetentionState,
} from "./session-resource-store.js";

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function byteStream(bytes: Buffer): AsyncIterable<Uint8Array> {
  return (async function* stream() {
    yield bytes.subarray(0, 7);
    yield bytes.subarray(7);
  })();
}

describe("native session resource store", () => {
  it("accepts a session resource byte ceiling in tools config", () => {
    expect(ToolsSchema.safeParse({ sessionResources: { maxBytes: 1024 } }).success).toBe(true);
    expect(ToolsSchema.safeParse({ sessionResources: {} }).success).toBe(true);
    expect(ToolsSchema.safeParse({ sessionResources: { maxBytes: 0 } }).success).toBe(false);
    expect(ToolsSchema.safeParse({ sessionResources: { maxBytes: 1.5 } }).success).toBe(false);
    expect(ToolsSchema.safeParse({ sessionResources: { maxBytes: 1, root: "/etc" } }).success).toBe(
      false,
    );
  });

  it("streams external bytes into exact native session ownership", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const bytes = Buffer.from("hello-session-resource");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const metadata = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        agentId: "main",
        stream: byteStream(bytes),
        fileName: "hello.txt",
        contentType: "text/plain",
        source: "office365",
        role: "attachment",
        stateDir: state.stateDir,
      });
      expect(metadata.size).toBe(bytes.byteLength);
      expect(metadata.sha256).toBe(sha256);
      expect(metadata.artifactRef.startsWith("artifact_managed_media_")).toBe(true);

      const parsed = parseManagedOutgoingArtifactId(metadata.artifactRef);
      expect(parsed).not.toBeNull();
      const record = await readManagedImageRecord(parsed!.attachmentId, state.stateDir);
      expect(record).toMatchObject({
        retentionClass: "session",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
        sha256,
        source: "office365",
        role: "attachment",
        messageId: null,
      });

      const opened = await openSessionResourceStream({
        artifactRef: metadata.artifactRef,
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect((await drain(opened.stream)).equals(bytes)).toBe(true);

      const listed = await listSessionResourcesForScope({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect(listed.map((entry) => entry.attachmentId)).toContain(parsed!.attachmentId);
    });
  });

  it("rejects a copied reference from another session or generation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const metadata = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        agentId: "main",
        stream: byteStream(Buffer.from("secret")),
        fileName: "secret.txt",
        contentType: "text/plain",
        stateDir: state.stateDir,
      });
      await expect(
        openSessionResourceStream({
          artifactRef: metadata.artifactRef,
          sessionKey: "agent:main:other",
          sessionId: "sess-1",
          stateDir: state.stateDir,
        }),
      ).rejects.toThrow(/not owned/u);
      await expect(
        openSessionResourceStream({
          artifactRef: metadata.artifactRef,
          sessionKey: "agent:main:main",
          sessionId: "sess-2",
          stateDir: state.stateDir,
        }),
      ).rejects.toThrow(/not owned/u);
    });
  });

  it("enforces the byte ceiling while streaming", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await expect(
        importSessionResourceStream({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          stream: byteStream(Buffer.alloc(4096, 1)),
          fileName: "big.txt",
          contentType: "text/plain",
          maxBytes: 16,
          stateDir: state.stateDir,
        }),
      ).rejects.toThrow(/exceeds/u);
    });
  });

  it("keeps live session resources and reclaims only proven-gone ones", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      writeSessionEntry(database, "agent:main:main", {
        sessionId: "sess-live",
        lifecycleRevision: "r1",
        updatedAt: 1,
      });
      const options = {
        sessionKey: "agent:main:main",
        agentId: "main",
        contentType: "text/plain",
        stateDir: state.stateDir,
      };
      const live = await importSessionResourceStream({
        ...options,
        sessionId: "sess-live",
        stream: byteStream(Buffer.from("live")),
        fileName: "live.txt",
      });
      const stale = await importSessionResourceStream({
        ...options,
        sessionId: "sess-gone",
        stream: byteStream(Buffer.from("stale")),
        fileName: "stale.txt",
      });
      expect(
        await resolveSessionRetentionState({
          sessionKey: "agent:main:main",
          sessionId: "sess-live",
          agentId: "main",
          stateDir: state.stateDir,
        }),
      ).toBe("retained");
      expect(
        await resolveSessionRetentionState({
          sessionKey: "agent:main:main",
          sessionId: "sess-gone",
          agentId: "main",
          stateDir: state.stateDir,
        }),
      ).toBe("gone");

      await cleanupManagedOutgoingMediaRecords({ stateDir: state.stateDir });
      const liveId = parseManagedOutgoingArtifactId(live.artifactRef)!.attachmentId;
      const staleId = parseManagedOutgoingArtifactId(stale.artifactRef)!.attachmentId;
      expect(await readManagedImageRecord(liveId, state.stateDir)).not.toBeNull();
      expect(await readManagedImageRecord(staleId, state.stateDir)).toBeNull();
    });
  });

  it("projects session-retained resources into the authorized artifact scope", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const metadata = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        agentId: "main",
        stream: byteStream(Buffer.from("discoverable")),
        fileName: "report.txt",
        contentType: "text/plain",
        stateDir: state.stateDir,
      });
      const artifacts = await readSessionResourceArtifacts({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect(artifacts.find((artifact) => artifact.id === metadata.artifactRef)).toMatchObject({
        source: "session-resource",
        sessionKey: "agent:main:main",
        title: "report.txt",
        download: { mode: "url" },
      });
      const other = await readSessionResourceArtifacts({
        sessionKey: "agent:main:main",
        sessionId: "sess-2",
        stateDir: state.stateDir,
      });
      expect(other.some((artifact) => artifact.id === metadata.artifactRef)).toBe(false);
    });
  });

  it("retains an arbitrary generic binary resource (application/octet-stream)", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x7f, 0x80, 0xff, 0x10, 0x20]);
      const metadata = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        agentId: "main",
        stream: byteStream(bytes),
        fileName: "table.parquet",
        contentType: "application/octet-stream",
        stateDir: state.stateDir,
      });
      expect(metadata.contentType).toBe("application/octet-stream");
      expect(metadata.artifactRef.startsWith("artifact_managed_media_")).toBe(true);
      const artifacts = await readSessionResourceArtifacts({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect(artifacts.find((artifact) => artifact.id === metadata.artifactRef)).toMatchObject({
        mimeType: "application/octet-stream",
        title: "table.parquet",
      });
      const opened = await openSessionResourceStream({
        artifactRef: metadata.artifactRef,
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect((await drain(opened.stream)).equals(bytes)).toBe(true);
    });
  });

  it("fails integrity verification when stored bytes are mutated out-of-band", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const bytes = Buffer.from("tamper-me-please");
      const metadata = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        agentId: "main",
        stream: byteStream(bytes),
        fileName: "tamper.bin",
        contentType: "application/octet-stream",
        stateDir: state.stateDir,
      });
      const attachmentId = parseManagedOutgoingArtifactId(metadata.artifactRef)!.attachmentId;
      const record = await readManagedImageRecord(attachmentId, state.stateDir);
      expect(record).not.toBeNull();
      const storedPath = resolveManagedImageOriginalPath(record!);
      await fs.writeFile(storedPath, Buffer.alloc(bytes.byteLength, 0x41));
      const opened = await openSessionResourceStream({
        artifactRef: metadata.artifactRef,
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      await expect(drain(opened.stream)).rejects.toThrow(/integrity/u);
    });
  });

  it("fails closed when import authority is revoked before publication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      let revoked = false;
      async function* source() {
        yield Buffer.from("part-1");
        yield Buffer.from("part-2");
        revoked = true;
      }
      await expect(
        importSessionResourceStream({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          stream: source(),
          fileName: "revoked.bin",
          contentType: "application/octet-stream",
          stateDir: state.stateDir,
          assertCurrent: () => {
            if (revoked) {
              throw new Error("authority revoked");
            }
          },
        }),
      ).rejects.toThrow(/revoked/u);
      const listed = await listSessionResourcesForScope({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect(listed).toHaveLength(0);
    });
  });

  it("aborts an open stream when authority is revoked mid-consumption", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const metadata = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        agentId: "main",
        stream: byteStream(Buffer.alloc(4096, 3)),
        fileName: "open.bin",
        contentType: "application/octet-stream",
        stateDir: state.stateDir,
      });
      const opened = await openSessionResourceStream({
        artifactRef: metadata.artifactRef,
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
        assertCurrent: () => {
          throw new Error("authority revoked");
        },
      });
      await expect(drain(opened.stream)).rejects.toThrow(/revoked/u);
    });
  });

  it("cleans staging and withholds publication when the import stream is aborted", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const controller = new AbortController();
      async function* source() {
        yield Buffer.from("chunk-1");
        controller.abort();
        yield Buffer.from("chunk-2");
      }
      await expect(
        importSessionResourceStream({
          sessionKey: "agent:main:main",
          sessionId: "sess-1",
          agentId: "main",
          stream: source(),
          fileName: "aborted.bin",
          contentType: "application/octet-stream",
          signal: controller.signal,
          stateDir: state.stateDir,
        }),
      ).rejects.toThrow();
      const listed = await listSessionResourcesForScope({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect(listed).toHaveLength(0);
    });
  });

  it("withholds a resource from a replaced session generation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      writeSessionEntry(database, "agent:main:main", {
        sessionId: "sess-gen-a",
        lifecycleRevision: "r1",
        updatedAt: 1,
      });
      const metadata = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-gen-a",
        agentId: "main",
        stream: byteStream(Buffer.from("generation-a")),
        fileName: "gen.bin",
        contentType: "application/octet-stream",
        stateDir: state.stateDir,
      });
      expect(
        await resolveSessionRetentionState({
          sessionKey: "agent:main:main",
          sessionId: "sess-gen-a",
          agentId: "main",
          stateDir: state.stateDir,
        }),
      ).toBe("retained");

      writeSessionEntry(database, "agent:main:main", {
        sessionId: "sess-gen-b",
        lifecycleRevision: "r2",
        updatedAt: 2,
      });
      expect(
        await resolveSessionRetentionState({
          sessionKey: "agent:main:main",
          sessionId: "sess-gen-a",
          agentId: "main",
          stateDir: state.stateDir,
        }),
      ).toBe("gone");
      const forGenerationB = await readSessionResourceArtifacts({
        sessionKey: "agent:main:main",
        sessionId: "sess-gen-b",
        stateDir: state.stateDir,
      });
      expect(forGenerationB.some((artifact) => artifact.id === metadata.artifactRef)).toBe(false);

      await cleanupManagedOutgoingMediaRecords({ stateDir: state.stateDir });
      const attachmentId = parseManagedOutgoingArtifactId(metadata.artifactRef)!.attachmentId;
      expect(await readManagedImageRecord(attachmentId, state.stateDir)).toBeNull();
    });
  });

  it("rediscovers the same resource across runs in one retained session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const imported = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-retained",
        agentId: "main",
        stream: byteStream(Buffer.from("automation-reuse")),
        fileName: "reuse.txt",
        contentType: "text/plain",
        stateDir: state.stateDir,
      });
      // A later run in the same retained session rediscovers and reopens it.
      const rediscovered = await readSessionResourceArtifacts({
        sessionKey: "agent:main:main",
        sessionId: "sess-retained",
        stateDir: state.stateDir,
      });
      expect(rediscovered.some((artifact) => artifact.id === imported.artifactRef)).toBe(true);
      const opened = await openSessionResourceStream({
        artifactRef: imported.artifactRef,
        sessionKey: "agent:main:main",
        sessionId: "sess-retained",
        stateDir: state.stateDir,
      });
      expect((await drain(opened.stream)).toString()).toBe("automation-reuse");
    });
  });

  it("does not leak a resource across isolated cron sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const runA = await importSessionResourceStream({
        sessionKey: "agent:main:cron-a",
        sessionId: "sess-cron-a",
        agentId: "main",
        stream: byteStream(Buffer.from("cron-a-only")),
        fileName: "cron-a.bin",
        contentType: "application/octet-stream",
        stateDir: state.stateDir,
      });
      const runB = await readSessionResourceArtifacts({
        sessionKey: "agent:main:cron-b",
        sessionId: "sess-cron-b",
        stateDir: state.stateDir,
      });
      expect(runB.some((artifact) => artifact.id === runA.artifactRef)).toBe(false);
      await expect(
        openSessionResourceStream({
          artifactRef: runA.artifactRef,
          sessionKey: "agent:main:cron-b",
          sessionId: "sess-cron-b",
          stateDir: state.stateDir,
        }),
      ).rejects.toThrow(/not owned/u);
    });
  });

  it("hides a cleanup-pending resource from discovery", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const metadata = await importSessionResourceStream({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        agentId: "main",
        stream: byteStream(Buffer.from("claimed")),
        fileName: "claimed.bin",
        contentType: "application/octet-stream",
        stateDir: state.stateDir,
      });
      const attachmentId = parseManagedOutgoingArtifactId(metadata.artifactRef)!.attachmentId;
      const record = await readManagedImageRecord(attachmentId, state.stateDir);
      expect(record).not.toBeNull();
      expect(await claimManagedImageRecordCleanupIfCurrent(record!, state.stateDir)).toBe(true);

      const listed = await listSessionResourcesForScope({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect(listed.map((entry) => entry.attachmentId)).not.toContain(attachmentId);
      const artifacts = await readSessionResourceArtifacts({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        stateDir: state.stateDir,
      });
      expect(artifacts.some((artifact) => artifact.id === metadata.artifactRef)).toBe(false);
    });
  });

  it("treats unresolved ownership as unavailable rather than gone", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const metadata = await importSessionResourceStream({
        sessionKey: "unqualified-session-key",
        sessionId: "sess-1",
        stream: byteStream(Buffer.from("keep")),
        fileName: "keep.txt",
        contentType: "text/plain",
        stateDir: state.stateDir,
      });
      const parsed = parseManagedOutgoingArtifactId(metadata.artifactRef)!;
      expect(
        await resolveSessionRetentionState({
          sessionKey: "unqualified-session-key",
          sessionId: "sess-1",
          stateDir: state.stateDir,
        }),
      ).toBe("unavailable");
      const result = await cleanupManagedOutgoingMediaRecords({ stateDir: state.stateDir });
      expect(result.deletedRecordCount).toBe(0);
      expect(await readManagedImageRecord(parsed.attachmentId, state.stateDir)).not.toBeNull();
    });
  });
});
