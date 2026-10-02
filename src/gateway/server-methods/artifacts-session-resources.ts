// Native discovery projection for session-retained managed resources.
//
// Session-retained resources are owned by an exact native session id, not by a
// transcript message. They surface through the existing artifacts list/get
// handlers once the native session read scope has been authorized.
import { resolveManagedMediaKind } from "../managed-image-attachments.media-kind.js";
import { buildManagedOutgoingArtifactId } from "../managed-outgoing-artifact-id.js";
import { listSessionResourcesForScope } from "../session-resource-store.js";
import type { ArtifactRecord } from "./artifacts-content.js";

function toSessionResourceArtifact(record: {
  attachmentId: string;
  sessionKey: string;
  alt: string;
  original: { contentType: string; sizeBytes: number | null; filename: string | null };
}): ArtifactRecord | undefined {
  const kind = resolveManagedMediaKind(record.original.contentType, { allowGeneric: true });
  if (!kind) {
    return undefined;
  }
  const title = record.original.filename ?? record.alt;
  return {
    id: buildManagedOutgoingArtifactId(record.attachmentId, kind),
    type: kind === "document" ? "file" : kind,
    title,
    ...(record.original.contentType ? { mimeType: record.original.contentType } : {}),
    ...(record.original.sizeBytes != null ? { sizeBytes: record.original.sizeBytes } : {}),
    sessionKey: record.sessionKey,
    source: "session-resource",
    download: { mode: "url" as const },
  };
}

/**
 * List session-retained resources for an already-authorized session scope.
 *
 * The caller must have completed native session read authorization; this helper
 * never enumerates another session's resources.
 */
export async function readSessionResourceArtifacts(params: {
  sessionKey: string;
  sessionId?: string;
  stateDir?: string;
}): Promise<ArtifactRecord[]> {
  const records = await listSessionResourcesForScope({
    sessionKey: params.sessionKey,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
  });
  const artifacts: ArtifactRecord[] = [];
  for (const record of records) {
    const artifact = toSessionResourceArtifact(record);
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}
