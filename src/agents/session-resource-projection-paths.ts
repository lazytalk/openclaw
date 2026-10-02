/**
 * Session resource execution-projection paths.
 *
 * A session's sandbox projects this host root read-only so `materialize` can
 * copy a canonical session resource into the writable execution workspace with
 * the placement bridge's native copy, avoiding whole-file buffering and
 * command-stdin streaming. The root is scoped to one agent and one exact
 * session key, and is empty until a resource is staged.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";

/** Read-only container path where a sandbox projects the session resource root. */
export const SANDBOX_SESSION_RESOURCES_MOUNT = "/openclaw/session-resources";

/**
 * Scoped by exact native session generation: a `/reset` keeps the logical
 * session key but produces a new `sessionId`. Generation-scoping the staging
 * root guarantees a replacement never mounts the previous generation's bytes.
 */
export function resolveSessionResourceProjectionRootDir(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const sessionKeyRef = createHash("sha256").update(params.sessionKey).digest("hex").slice(0, 32);
  const sessionIdRef = createHash("sha256").update(params.sessionId).digest("hex").slice(0, 32);
  return path.join(
    resolveStateDir(params.env),
    "session-resources",
    normalizeAgentId(params.agentId),
    sessionKeyRef,
    sessionIdRef,
  );
}
