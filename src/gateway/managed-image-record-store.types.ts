import type { Insertable, Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

type ManagedImageRecordVariant = {
  mediaRoot: string;
  mediaId: string;
  mediaSubdir: string;
  contentType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  filename: string | null;
};

type ManagedImageRetentionClass = "transient" | "history" | "session";

export type ManagedImageRecord = {
  attachmentId: string;
  sessionKey: string;
  agentId?: string;
  messageId: string | null;
  createdAt: string;
  updatedAt?: string;
  retentionClass?: ManagedImageRetentionClass;
  alt: string;
  /** Exact native physical session id that owns a session-retained resource. */
  sessionId?: string;
  /** Lowercase hex SHA-256 of the retained bytes. */
  sha256?: string;
  /** Minimal non-secret provenance label for a session-retained resource. */
  source?: string;
  /** Optional workflow role (for example "attachment" or "derived"). */
  role?: string;
  /** Attachment id this resource was derived from, when applicable. */
  derivedFromAttachmentId?: string;
  original: ManagedImageRecordVariant;
};

export type ManagedImageRecordDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "managed_outgoing_image_records"
>;
export type ManagedImageRecordRow = Omit<
  Selectable<ManagedImageRecordDatabase["managed_outgoing_image_records"]>,
  "record_json"
>;
export type ManagedImageRecordInsert = Insertable<
  ManagedImageRecordDatabase["managed_outgoing_image_records"]
>;
export type ManagedImageRecordEntry = {
  record: ManagedImageRecord;
  cleanupPending: boolean;
};

export type ManagedImageRecordAttachment = {
  attachmentId: string;
  sessionKey: string;
  messageId: string;
  updatedAt: string;
};
