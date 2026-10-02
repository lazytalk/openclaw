/**
 * Leaf contract for a resolved managed outgoing media artifact download.
 *
 * Kept in its own module so session-resource custody can reference the shape
 * without importing the managed-media owner (which itself references session
 * resources), avoiding an import cycle.
 */
import type { ManagedMediaKind } from "./managed-image-attachments.media-kind.js";

export type ManagedOutgoingMediaArtifactDownload = {
  artifactId: string;
  sessionKey: string;
  type: Exclude<ManagedMediaKind, "document"> | "file";
  title: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Discovery classification, kept stable across list/get/download. */
  source: "session-resource" | "session-transcript";
  url: string;
  expiresAt: string;
};
