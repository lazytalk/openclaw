// Real-Gateway proof for the V11 session-retained provider resource path.
//
// A resource imported through native custody must surface through the public
// artifacts.list/get/download RPCs, serve its exact bytes over HTTP, and remain
// discoverable and readable after a Gateway restart. This exercises the session
// retention class, not a transcript-backed history attachment.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./method-scopes.js";
import { startGatewayServer } from "./server.js";
import { importSessionResourceStream } from "./session-resource-store.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "./test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";

const ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

type Cleanup = () => Promise<void> | void;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway session resource artifacts", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    clearSessionStoreCacheForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("serves a session-retained resource across a Gateway restart", async () => {
    const envSnapshot = captureEnv([...ENV_KEYS]);
    cleanup.push(async () => {
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
    });

    const tempHome = tempDirs.make("gateway-session-resource-");
    const stateDir = path.join(tempHome, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspace = path.join(tempHome, "workspace-main");
    const token = "gateway-session-resource-token";
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: { auth: { mode: "token", token } },
          agents: { entries: { main: { default: true, workspace } } },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
    setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
    setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
    setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
    setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
    setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();

    const port = await getGatewayE2ePortBlock();
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));
    const startServer = () =>
      startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
    const connect = (clientDisplayName: string) =>
      connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientDisplayName,
        scopes: [ADMIN_SCOPE, READ_SCOPE],
        timeoutMs: 30_000,
      });

    let server = await startServer();
    cleanup.push(() => server.close());
    let client = await connect("gateway session resource artifacts");
    cleanup.push(() => disconnectGatewayClient(client));

    const sessionKey = "agent:main:session-resource-api";
    const sessionId = "gateway-session-resource";
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    await upsertSessionEntryCore(
      { agentId: "main", sessionId, sessionKey, storePath },
      { sessionId, updatedAt: Date.now() },
    );
    const body = Buffer.from("session-resource-http-bytes-0123456789");
    const metadata = await importSessionResourceStream({
      sessionKey,
      sessionId,
      agentId: "main",
      stream: (async function* importChunks() {
        yield body.subarray(0, 9);
        yield body.subarray(9);
      })(),
      fileName: "session-resource.bin",
      contentType: "application/octet-stream",
      stateDir,
    });
    expect(metadata.artifactRef.startsWith("artifact_managed_media_")).toBe(true);

    const assertServed = async () => {
      const list = await client.request<{
        artifacts: Array<{
          id: string;
          sessionKey: string;
          type: string;
          title: string;
          mimeType?: string;
          download: { mode: string };
        }>;
      }>("artifacts.list", { sessionKey });
      const artifact = list.artifacts.find((entry) => entry.id === metadata.artifactRef);
      expect(artifact).toMatchObject({
        sessionKey,
        type: "file",
        title: "session-resource.bin",
        mimeType: "application/octet-stream",
        source: "session-resource",
        download: { mode: "url" },
      });
      await expect(
        client.request("artifacts.get", { sessionKey, artifactId: metadata.artifactRef }),
      ).resolves.toMatchObject({
        artifact: { id: metadata.artifactRef, sessionKey, source: "session-resource" },
      });

      const download = await client.request<{
        artifact?: { source?: string };
        url: string;
        expiresAt: string;
      }>("artifacts.download", { sessionKey, artifactId: metadata.artifactRef });
      // The discovery classification stays stable across list/get/download.
      expect(download.artifact?.source).toBe("session-resource");
      expect(download.url).toContain("mediaTicket=");
      expect(download.expiresAt).toBeTruthy();
      const response = await fetch(`http://127.0.0.1:${port}${download.url}`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
    };

    await assertServed();

    await disconnectGatewayClient(client);
    await server.close();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    server = await startServer();
    client = await connect("gateway session resource artifacts after restart");
    await assertServed();

    // A physical session replacement (same session key, new session id) must
    // stop disclosing the previous generation's resource.
    const nextSessionId = `${sessionId}-next`;
    await upsertSessionEntryCore(
      { agentId: "main", sessionId: nextSessionId, sessionKey, storePath },
      { sessionId: nextSessionId, updatedAt: Date.now() },
    );
    const afterReplacement = await client.request<{ artifacts: Array<{ id: string }> }>(
      "artifacts.list",
      { sessionKey },
    );
    expect(afterReplacement.artifacts.some((entry) => entry.id === metadata.artifactRef)).toBe(
      false,
    );
    await expect(
      client.request("artifacts.get", { sessionKey, artifactId: metadata.artifactRef }),
    ).rejects.toThrow(/not found/i);
    await expect(
      client.request("artifacts.download", { sessionKey, artifactId: metadata.artifactRef }),
    ).rejects.toThrow(/not found/i);
  }, 120_000);
});
