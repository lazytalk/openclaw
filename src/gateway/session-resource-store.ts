/**
 * Native session-retained resource custody.
 *
 * Streams external provider bytes into the existing managed media record store
 * with retention class "session", an exact owning session id, SHA-256, and
 * minimal non-secret provenance. Authorization, lifecycle, and discovery stay
 * in the native managed-media/artifact subsystems; this module only adds the
 * stream seam that a trusted plugin/provider needs to hand bytes to the current
 * admitted session without base64 context transport or host paths.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { loadExactSessionEntryReadOnlyResult } from "../config/sessions/session-accessor.sqlite-entry-availability.js";
import { resolveSessionEntry } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
  type SessionStoreTargetsReadResult,
} from "../config/sessions/targets-read-availability.js";
import { openMediaStream, saveMediaStream } from "../media/store.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  captureChannelReadScope,
  withChannelReadAuthority,
} from "../shared/channel-read-authority.js";
import {
  deleteManagedImageRecordArtifacts,
  insertManagedImageRecordWithFile,
  resolveManagedImageOriginalPath,
} from "./managed-image-attachments.custody.js";
import type { ManagedOutgoingMediaArtifactDownload } from "./managed-image-attachments.js";
import {
  resolveManagedMediaKind,
  type ManagedMediaKind,
} from "./managed-image-attachments.media-kind.js";
import {
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  captureManagedImageContext,
  listManagedSessionResourceRecords,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import type { ManagedImageRecord } from "./managed-image-record-store.types.js";
import { createManagedOutgoingImageTicket } from "./managed-image-tickets.js";
import {
  buildManagedOutgoingArtifactId,
  buildOutgoingVariantUrl,
  parseManagedOutgoingArtifactId,
} from "./managed-outgoing-artifact-id.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

export const DEFAULT_SESSION_RESOURCE_MAX_BYTES = 512 * 1024 * 1024;

export type SessionResourceMetadata = {
  artifactRef: string;
  attachmentId: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  sessionKey: string;
  sessionId: string;
};

export type SessionResourceStream = {
  metadata: SessionResourceMetadata;
  stream: AsyncIterable<Uint8Array>;
};

export type SessionRetentionState = "retained" | "gone" | "unavailable";

/** Per-cleanup-pass session store availability cache, shared with the native cleanup loop. */
export type SessionAvailabilityCache = Map<string, SessionStoreTargetsReadResult>;

/**
 * Reclaim a session resource only when the native session store proves the exact
 * owning session id is gone or replaced. A missing id, an unreadable store, or
 * any ambiguity keeps the resource.
 */
export async function shouldReclaimSessionResource(params: {
  record: ManagedImageRecord;
  stateDir?: string;
  storeTargetsReadCache?: SessionStoreTargetsReadCache;
  storeAvailabilityCache?: SessionAvailabilityCache;
}): Promise<boolean> {
  const sessionId = params.record.sessionId;
  if (!sessionId) {
    return false;
  }
  const state = await resolveSessionRetentionState({
    sessionKey: params.record.sessionKey,
    sessionId,
    ...(params.record.agentId ? { agentId: params.record.agentId } : {}),
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.storeTargetsReadCache
      ? { storeTargetsReadCache: params.storeTargetsReadCache }
      : {}),
    ...(params.storeAvailabilityCache
      ? { storeAvailabilityCache: params.storeAvailabilityCache }
      : {}),
  });
  return state === "gone";
}

/**
 * Build a short-lived native media capability for a managed record without
 * transcript membership. Authorization is the caller's responsibility.
 */
export async function buildManagedMediaArtifactDownload(
  record: ManagedImageRecord,
  assertCurrent?: () => void,
): Promise<ManagedOutgoingMediaArtifactDownload | null> {
  const kind = resolveManagedMediaKind(record.original.contentType);
  if (!kind) {
    return null;
  }
  try {
    const stat = await fs.stat(resolveManagedImageOriginalPath(record));
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  assertCurrent?.();
  const ticket = createManagedOutgoingImageTicket({
    sessionKey: record.sessionKey,
    attachmentId: record.attachmentId,
  });
  if (!ticket) {
    return null;
  }
  const canonicalUrl = buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "full");
  const params = new URLSearchParams({ mediaTicket: ticket.ticket });
  return {
    artifactId: buildManagedOutgoingArtifactId(record.attachmentId, kind),
    sessionKey: record.sessionKey,
    type: kind === "document" ? "file" : kind,
    title: kind === "image" ? record.alt : (record.original.filename ?? record.alt),
    ...(record.original.contentType ? { mimeType: record.original.contentType } : {}),
    ...(record.original.sizeBytes != null ? { sizeBytes: record.original.sizeBytes } : {}),
    url: `${canonicalUrl}?${params.toString()}`,
    expiresAt: ticket.expiresAt,
  };
}

/**
 * Resolve a session-retained resource to a short-lived native media capability.
 *
 * Authorization is native session currentness: the exact owning session id must
 * still be the retained one, otherwise the resource is undisclosed.
 */
export async function resolveSessionResourceArtifactDownload(
  record: ManagedImageRecord,
  stateDir?: string,
): Promise<ManagedOutgoingMediaArtifactDownload | null> {
  const resolvedStateDir = stateDir ?? resolveStateDir();
  const assertCurrent = captureChannelReadScope()?.assertCurrent ?? (() => {});
  assertCurrent();
  const state = await resolveSessionRetentionState({
    sessionKey: record.sessionKey,
    sessionId: record.sessionId ?? "",
    ...(record.agentId ? { agentId: record.agentId } : {}),
    stateDir: resolvedStateDir,
  });
  assertCurrent();
  return state === "retained"
    ? await buildManagedMediaArtifactDownload(record, assertCurrent)
    : null;
}

export function resolveSessionResourceMaxBytes(configured: number | undefined): number {
  return Number.isSafeInteger(configured) && (configured as number) > 0
    ? (configured as number)
    : DEFAULT_SESSION_RESOURCE_MAX_BYTES;
}

/** Reject host-path or separator-bearing names before a resource becomes durable. */
export function assertSessionResourceFileName(value: string): string {
  const hasControlCharacter = Array.from(value).some((character) => character.charCodeAt(0) < 32);
  if (
    !value ||
    value.length > 200 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    hasControlCharacter ||
    value === "." ||
    value === ".."
  ) {
    throw new Error("Session resource fileName must be a plain filename of at most 200 characters");
  }
  return value;
}

function toMetadata(
  record: ManagedImageRecord,
  kind: ManagedMediaKind,
  fileName: string,
): SessionResourceMetadata {
  return {
    artifactRef: buildManagedOutgoingArtifactId(record.attachmentId, kind),
    attachmentId: record.attachmentId,
    fileName,
    contentType: record.original.contentType,
    size: record.original.sizeBytes ?? 0,
    sha256: record.sha256 ?? "",
    sessionKey: record.sessionKey,
    sessionId: record.sessionId ?? "",
  };
}

/**
 * Stream external bytes into the current native session as a durable resource.
 *
 * The owning session key/id come from the caller's admitted execution context;
 * plugins cannot select another session or a host path.
 */
export async function importSessionResourceStream(params: {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  stream: AsyncIterable<Uint8Array>;
  fileName: string;
  contentType?: string;
  role?: string;
  source?: string;
  derivedFromAttachmentId?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  stateDir?: string;
}): Promise<SessionResourceMetadata> {
  const sessionKey = params.sessionKey.trim();
  const sessionId = params.sessionId.trim();
  if (!sessionKey || !sessionId) {
    throw new Error("Session resource import requires an owning session key and id");
  }
  const fileName = assertSessionResourceFileName(params.fileName);
  const configuredMaxBytes = getRuntimeConfig().tools?.sessionResources?.maxBytes;
  const maxBytes = resolveSessionResourceMaxBytes(params.maxBytes ?? configuredMaxBytes);
  const stateDir = params.stateDir ?? resolveStateDir();
  const context = captureManagedImageContext(stateDir);
  return await withChannelReadAuthority(params.assertCurrent, async () => {
    params.signal?.throwIfAborted();
    const hash = createHash("sha256");
    let size = 0;
    async function* checked() {
      for await (const chunk of params.stream) {
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("Session resource stream requires byte chunks");
        }
        size += chunk.byteLength;
        if (size > maxBytes) {
          throw new Error(`Session resource exceeds ${maxBytes} bytes`);
        }
        const bytes = Buffer.from(chunk);
        hash.update(bytes);
        yield bytes;
      }
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
    }
    let saved: Awaited<ReturnType<typeof saveMediaStream>> | undefined;
    let inserted: ManagedImageRecord | undefined;
    try {
      saved = await saveMediaStream(
        checked(),
        params.contentType,
        MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        maxBytes,
        fileName,
        undefined,
        { assertCommitAllowed: params.assertCurrent },
      );
      const contentType = saved.contentType;
      if (!contentType) {
        throw new Error("Session resource has no detectable content type");
      }
      const kind = resolveManagedMediaKind(contentType);
      if (!kind) {
        throw new Error("Session resource has an unsupported content type");
      }
      const record: ManagedImageRecord = {
        attachmentId: randomUUID(),
        sessionKey,
        ...(params.agentId?.trim() ? { agentId: normalizeAgentId(params.agentId) } : {}),
        messageId: null,
        createdAt: new Date().toISOString(),
        retentionClass: "session",
        alt: fileName,
        sessionId,
        sha256: hash.digest("hex"),
        ...(params.source ? { source: params.source } : {}),
        ...(params.role ? { role: params.role } : {}),
        ...(params.derivedFromAttachmentId
          ? { derivedFromAttachmentId: params.derivedFromAttachmentId }
          : {}),
        original: {
          mediaRoot: path.dirname(path.dirname(path.dirname(path.resolve(saved.path)))),
          mediaId: saved.id,
          mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
          contentType,
          width: null,
          height: null,
          sizeBytes: saved.size,
          filename: fileName,
        },
      };
      await insertManagedImageRecordWithFile(record, saved.path, stateDir, context);
      inserted = record;
      context.admission.assertCurrent();
      return toMetadata(record, kind, fileName);
    } catch (error) {
      // A changed/uncertain commit keeps whatever the state DB may own; otherwise reclaim.
      if (inserted) {
        await deleteManagedImageRecordArtifacts(inserted, stateDir, false, context);
      } else if (saved && !captureChannelReadScope()) {
        const { unlinkIfExists } = await import("../media/temp-files.js");
        await unlinkIfExists(saved.path);
      }
      throw error;
    }
  });
}

/** Open a session-retained resource as a bounded, integrity-checked stream. */
export async function openSessionResourceStream(params: {
  artifactRef: string;
  sessionKey: string;
  sessionId: string;
  maxBytes?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  stateDir?: string;
}): Promise<SessionResourceStream> {
  const parsed = parseManagedOutgoingArtifactId(params.artifactRef);
  if (!parsed) {
    throw new Error("Unknown artifact reference");
  }
  const stateDir = params.stateDir ?? resolveStateDir();
  const record = await readManagedImageRecord(parsed.attachmentId, stateDir);
  if (!record || record.retentionClass !== "session") {
    throw new Error("Session resource unavailable; import the source again");
  }
  if (
    record.sessionKey !== params.sessionKey.trim() ||
    record.sessionId !== params.sessionId.trim()
  ) {
    throw new Error("Session resource is not owned by the current session");
  }
  const kind = resolveManagedMediaKind(record.original.contentType);
  if (!kind || (parsed.family === "image") !== (kind === "image")) {
    throw new Error("Session resource kind mismatch");
  }
  const configuredMaxBytes = getRuntimeConfig().tools?.sessionResources?.maxBytes;
  const maxBytes = resolveSessionResourceMaxBytes(
    params.maxBytes ?? configuredMaxBytes ?? record.original.sizeBytes ?? undefined,
  );
  const opened = await openMediaStream(
    record.original.mediaId,
    record.original.mediaSubdir,
    maxBytes,
    params.signal,
  );
  const metadata = toMetadata(record, kind, record.original.filename ?? record.alt);
  const expectedSha256 = record.sha256;
  const hash = createHash("sha256");
  async function* verified() {
    try {
      for await (const chunk of opened.stream) {
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
        hash.update(chunk);
        yield chunk;
      }
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
      if (expectedSha256 && hash.digest("hex") !== expectedSha256) {
        throw new Error("Session resource integrity check failed; import the source again");
      }
    } finally {
      await opened.close();
    }
  }
  return { metadata, stream: verified() };
}

/** Index one retained record without exposing bytes or host paths. */
export function toSessionResourceMetadata(
  record: ManagedImageRecord,
): SessionResourceMetadata | null {
  if (record.retentionClass !== "session") {
    return null;
  }
  const kind = resolveManagedMediaKind(record.original.contentType);
  if (!kind) {
    return null;
  }
  return toMetadata(record, kind, record.original.filename ?? record.alt);
}

export async function listSessionResourcesForScope(params: {
  sessionKey: string;
  sessionId?: string;
  stateDir?: string;
}): Promise<ManagedImageRecord[]> {
  const entries = await listManagedSessionResourceRecords(params);
  return entries.map((entry) => entry.record);
}

export function resolveSessionResourceOwnerAgentId(
  sessionKey: string,
  explicitAgentId?: string,
  compatibilityAgentId?: string,
): string | undefined {
  const ownerAgentId =
    explicitAgentId?.trim() ||
    parseAgentSessionKey(sessionKey)?.agentId ||
    compatibilityAgentId?.trim();
  return ownerAgentId ? normalizeAgentId(ownerAgentId) : undefined;
}

/**
 * Prove whether the exact owning session id is still retained.
 *
 * "gone" means the native session store is readable and no longer carries this
 * exact session id, so the resource may be reclaimed. Any read failure or
 * ambiguity returns "unavailable", which callers must treat as keep.
 */
export async function resolveSessionRetentionState(params: {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  stateDir?: string;
  storeTargetsReadCache?: SessionStoreTargetsReadCache;
  storeAvailabilityCache?: SessionAvailabilityCache;
}): Promise<SessionRetentionState> {
  const sessionKey = params.sessionKey;
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return "unavailable";
  }
  const cfg = getRuntimeConfig();
  const ownerAgentId =
    resolveSessionResourceOwnerAgentId(sessionKey, params.agentId) ??
    tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
  if (!ownerAgentId) {
    return "unavailable";
  }
  const stateDir = params.stateDir;
  const env = stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env;
  const discovery =
    params.storeAvailabilityCache?.get(ownerAgentId) ??
    resolveExistingAgentSessionStoreTargetsReadOnlyResult(cfg, ownerAgentId, {
      ...(params.storeTargetsReadCache ? { cache: params.storeTargetsReadCache } : {}),
      ...(stateDir ? { env } : {}),
    });
  params.storeAvailabilityCache?.set(ownerAgentId, discovery);
  if (!discovery.available) {
    return "unavailable";
  }
  let sawEntry = false;
  for (const target of discovery.targets) {
    const exact = loadExactSessionEntryReadOnlyResult({
      agentId: ownerAgentId,
      clone: false,
      env,
      sessionKey,
      storePath: target.storePath,
    });
    if (!exact.found) {
      return "unavailable";
    }
    let entry = exact.value?.entry;
    if (!entry) {
      try {
        entry = resolveSessionEntry(
          { agentId: ownerAgentId, clone: false, env, sessionKey, storePath: target.storePath },
          { readOnly: true },
        ).existing;
      } catch {
        return "unavailable";
      }
    }
    if (entry?.sessionId) {
      sawEntry = true;
      if (entry.sessionId === sessionId) {
        return "retained";
      }
    }
  }
  if (!sawEntry) {
    try {
      const loaded = loadGatewaySessionEntryReadOnly(sessionKey, { agentId: ownerAgentId });
      if (loaded.entry?.sessionId) {
        return loaded.entry.sessionId === sessionId ? "retained" : "gone";
      }
    } catch {
      return "unavailable";
    }
  }
  return "gone";
}
