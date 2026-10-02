import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { registerSandboxBackend } from "./sandbox/backend.js";
import { resolveSandboxContext } from "./sandbox/context.js";
import {
  resolveSessionResourceProjectionRootDir,
  SANDBOX_SESSION_RESOURCES_MOUNT,
} from "./session-resource-projection-paths.js";
import { resolveSubagentSessionAttachmentRootDir } from "./subagents/subagent-attachment-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("isolates a session attachment projection from sibling agent-scoped sessions", async () => {
  const stateDir = tempDirs.make("openclaw-attachment-state-");
  const workspaceDir = path.join(stateDir, "workspace");
  const attachedSessionKey = "agent:main:subagent:attached";
  const siblingSessionKey = "agent:main:subagent:sibling";
  const attachedSessionId = "sess-attached";
  const siblingSessionId = "sess-sibling";
  const attachmentRoot = resolveSubagentSessionAttachmentRootDir({
    agentId: "main",
    childSessionKey: attachedSessionKey,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const backendFactory = vi.fn(async (params) => ({
    id: "attachment-scope-backend",
    runtimeId: `runtime-${params.scopeKey}`,
    runtimeLabel: "Attachment Scope Runtime",
    workdir: "/workspace",
    buildExecSpec: async () => ({
      argv: ["attachment-scope-backend", "exec"],
      env: {},
      stdinMode: "pipe-closed" as const,
    }),
    runShellCommand: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }),
  }));
  const restore = registerSandboxBackend("attachment-scope-backend", {
    capabilities: { readOnlyResourceMounts: true },
    factory: backendFactory,
  });
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "attachment-scope-backend",
          scope: "agent",
          workspaceAccess: "none",
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
  };

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const beforeAttachment = await resolveSandboxContext({
        config: cfg,
        sessionKey: attachedSessionKey,
        sessionId: attachedSessionId,
        workspaceDir,
      });
      const resourceRootFor = (sessionKey: string, sessionId: string) =>
        fs.realpath(
          resolveSessionResourceProjectionRootDir({
            agentId: "main",
            sessionKey,
            sessionId,
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
        );
      // The session resource projection root is always mounted so materialize can
      // copy a canonical resource into the workspace natively.
      expect(beforeAttachment?.readOnlyResourceMounts).toEqual([
        {
          hostPath: await resourceRootFor(attachedSessionKey, attachedSessionId),
          containerPath: SANDBOX_SESSION_RESOURCES_MOUNT,
        },
      ]);
      await fs.mkdir(attachmentRoot, { recursive: true });
      await fs.writeFile(path.join(attachmentRoot, "proof.txt"), "authorized");
      const attached = await resolveSandboxContext({
        config: cfg,
        sessionKey: attachedSessionKey,
        sessionId: attachedSessionId,
        workspaceDir,
      });
      const sibling = await resolveSandboxContext({
        config: cfg,
        sessionKey: siblingSessionKey,
        sessionId: siblingSessionId,
        workspaceDir,
      });

      expect(attached?.readOnlyResourceMounts).toEqual([
        {
          hostPath: await fs.realpath(attachmentRoot),
          containerPath: "/openclaw/attachments",
        },
        {
          hostPath: await resourceRootFor(attachedSessionKey, attachedSessionId),
          containerPath: SANDBOX_SESSION_RESOURCES_MOUNT,
        },
      ]);
      expect(sibling?.readOnlyResourceMounts).toEqual([
        {
          hostPath: await resourceRootFor(siblingSessionKey, siblingSessionId),
          containerPath: SANDBOX_SESSION_RESOURCES_MOUNT,
        },
      ]);
      const [beforeCall, attachedCall, siblingCall] = backendFactory.mock.calls.map(
        ([call]) => call,
      );
      expect(beforeCall?.scopeKey).toBe(siblingCall?.scopeKey);
      expect(attachedCall?.scopeKey).not.toBe(siblingCall?.scopeKey);
      expect(attachedCall?.readOnlyResourceMounts).toHaveLength(2);
      expect(siblingCall?.readOnlyResourceMounts).toHaveLength(1);
    });
  } finally {
    restore();
  }
});
