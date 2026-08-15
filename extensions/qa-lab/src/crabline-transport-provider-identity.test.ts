// Qa Lab tests cover provider-authoritative Telegram target correlation.
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

const selection = {
  capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
  channel: "telegram",
  channelDriver: "crabline",
  providerReadinessArtifactPath: "crabline-provider-readiness.json",
} as const satisfies OpenClawCrablineChannelDriverSelection;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function readTelegramInbound(
  transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>,
) {
  const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
  const telegram = config.channels?.telegram as { apiRoot?: string; botToken?: string } | undefined;
  const apiRoot = requireString(telegram?.apiRoot, "Telegram API root");
  const botToken = requireString(telegram?.botToken, "Telegram bot token");
  const response = await fetch(`${apiRoot}/bot${botToken}/getUpdates`);
  const updates = (await response.json()) as {
    result?: Array<{ message?: { chat?: { id?: number }; message_thread_id?: number } }>;
  };
  return { apiRoot, botToken, message: updates.result?.at(-1)?.message };
}

async function postTelegramMessage(params: {
  apiRoot: string;
  body: Record<string, unknown>;
  botToken: string;
}) {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.apiRoot}/bot${params.botToken}/sendMessage`,
    init: {
      body: JSON.stringify(params.body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-crabline-telegram-provider-correlation-test",
  });
  await release();
  expect(response.ok).toBe(true);
}

describe("Crabline Telegram provider identity", () => {
  it("correlates private-topic sends with the canonical direct-thread target", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const state = createQaBusState();
      const addOutboundMessage = vi.spyOn(state, "addOutboundMessage");
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection,
        state,
      });
      try {
        const inbound = await transport.sendInbound({
          conversation: { id: "alice/team", kind: "direct" },
          senderId: "alice/team",
          text: "Private topic baseline marker.",
          threadId: "42",
        });
        expect(inbound).toMatchObject({
          conversation: { id: "alice/team", kind: "direct" },
          threadId: "42",
        });
        const { apiRoot, botToken, message } = await readTelegramInbound(transport);
        expect(message?.message_thread_id).toEqual(expect.any(Number));
        expect(message?.chat?.id).toEqual(expect.any(Number));
        await postTelegramMessage({
          apiRoot,
          botToken,
          body: {
            chat_id: message?.chat?.id,
            message_thread_id: message?.message_thread_id,
            text: "assistant via private topic",
          },
        });

        await expect(
          transport.waitForOutbound({
            conversation: { id: "alice/team", kind: "direct" },
            textIncludes: "assistant via private topic",
            threadId: "42",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "alice/team", kind: "direct" },
          text: "assistant via private topic",
          threadId: "42",
        });
        expect(addOutboundMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "dm:alice/team",
            threadId: "42",
          }),
        );
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("preserves a channel target without outbound delivery registration", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection,
        state: createQaBusState(),
      });
      try {
        await transport.sendInbound({
          conversation: { id: "telegram-announcements", kind: "channel" },
          senderId: "alice",
          text: "Channel identity baseline.",
        });
        const { apiRoot, botToken, message } = await readTelegramInbound(transport);
        expect(message?.chat?.id).toEqual(expect.any(Number));
        await postTelegramMessage({
          apiRoot,
          botToken,
          body: {
            chat_id: message?.chat?.id,
            text: "assistant via channel identity",
          },
        });

        await expect(
          transport.waitForOutbound({
            conversation: { id: "telegram-announcements", kind: "channel" },
            textIncludes: "assistant via channel identity",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "telegram-announcements", kind: "channel" },
          text: "assistant via channel identity",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });
});
