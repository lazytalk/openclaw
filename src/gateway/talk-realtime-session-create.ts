import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { TalkSessionCreateParams } from "../../packages/gateway-protocol/src/index.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../talk/agent-run-control-shared.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
import { ensureClientVoiceAgentSessionEntry } from "../talk/client-voice-session.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../talk/provider-resolver.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  resolveTalkRealtimeGatewayRelayLaunch,
  resolveTalkRealtimeProviderInstructions,
} from "./server-methods/talk-shared.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { TalkRealtimeRelayEventSink } from "./talk-realtime-relay-state.js";
import { createTalkRealtimeRelaySession } from "./talk-realtime-relay.js";
import { rememberUnifiedTalkSession } from "./talk-session-registry.js";

type RealtimeTalkSessionRequest = Pick<
  TalkSessionCreateParams,
  "language" | "model" | "provider" | "sessionKey" | "voice"
>;

type PluginTalkSessionDispatchContext = {
  clientConnId: string;
  ownerId: string;
  quotaOwnerId: string;
  eventSink: TalkRealtimeRelayEventSink;
};

const PLUGIN_TALK_SESSION_DISPATCH_CONTEXT_KEY: unique symbol = Symbol.for(
  "openclaw.pluginTalkSessionDispatchContext",
);
const pluginTalkSessionDispatchContext = resolveGlobalSingleton<
  AsyncLocalStorage<PluginTalkSessionDispatchContext>
>(
  PLUGIN_TALK_SESSION_DISPATCH_CONTEXT_KEY,
  () => new AsyncLocalStorage<PluginTalkSessionDispatchContext>(),
);

export function withPluginTalkSessionDispatchContext<T>(
  context: PluginTalkSessionDispatchContext,
  run: () => T,
): T {
  return pluginTalkSessionDispatchContext.run(context, run);
}

export function getPluginTalkSessionDispatchContext(
  clientConnId: string,
): Omit<PluginTalkSessionDispatchContext, "clientConnId"> | undefined {
  const context = pluginTalkSessionDispatchContext.getStore();
  if (!context || context.clientConnId !== clientConnId) {
    return undefined;
  }
  return context;
}

export class TalkRealtimeSessionRequestError extends Error {}

export async function createGatewayRealtimeTalkSession(params: {
  context: GatewayRequestContext;
  ownerId: string;
  agentId?: string;
  quotaOwnerId?: string;
  request: RealtimeTalkSessionRequest;
  eventSink?: TalkRealtimeRelayEventSink;
}) {
  const runtimeConfig = params.context.getRuntimeConfig();
  const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.request.provider);
  const launchOptions = buildRealtimeVoiceLaunchOptions({
    requested: params.request,
    defaults: realtimeConfig,
  });
  const agentId =
    params.agentId ?? resolveTalkSessionAgentId(runtimeConfig, params.request.sessionKey);
  const resolution = resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: realtimeConfig.provider,
    providerConfigs: realtimeConfig.providers,
    providerConfigOverrides: launchOptions.model ? { model: launchOptions.model } : {},
    cfg: runtimeConfig,
    agentId,
    defaultModel: realtimeConfig.model,
    surface: "gateway-relay",
  });
  const relayLaunch = resolveTalkRealtimeGatewayRelayLaunch({
    ...resolution,
    cfg: runtimeConfig,
    launchOptions,
    consultRouting: realtimeConfig.consultRouting,
  });
  if (relayLaunch.error) {
    throw new TalkRealtimeSessionRequestError(relayLaunch.error);
  }
  const realtimeContext = await resolveTalkRealtimeProviderInstructions({
    config: runtimeConfig,
    agentId,
    configuredInstructions: realtimeConfig.instructions,
    sessionKey: params.request.sessionKey,
    requireSessionKeyForProfile: true,
    warn: (message) => params.context.logGateway.warn(`talk realtime context: ${message}`),
  });
  const sessionKey =
    realtimeContext.requestedSessionKey ??
    buildAgentMainSessionKey({ agentId: realtimeContext.agentId });
  await ensureClientVoiceAgentSessionEntry({ agentId: realtimeContext.agentId, sessionKey });
  const session = createTalkRealtimeRelaySession({
    context: params.context,
    connId: params.ownerId,
    ...(params.quotaOwnerId ? { quotaOwnerId: params.quotaOwnerId } : {}),
    ...(params.eventSink ? { eventSink: params.eventSink } : {}),
    cfg: runtimeConfig,
    provider: resolution.provider,
    providerConfig: relayLaunch.providerConfig,
    instructions: buildRealtimeInstructions(realtimeContext.instructions),
    tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
    model: launchOptions.model,
    sessionKey,
    voice: launchOptions.voice,
    language: normalizeOptionalLowercaseString(params.request.language),
    forceAgentConsultOnFinalTranscript: relayLaunch.forceAgentConsultOnFinalTranscript,
  });
  rememberUnifiedTalkSession(session.relaySessionId, {
    kind: "realtime-relay",
    connId: params.ownerId,
    relaySessionId: session.relaySessionId,
  });
  return {
    ...session,
    sessionId: session.relaySessionId,
    voiceSessionId: session.relaySessionId,
    mode: "realtime" as const,
    brain: "agent-consult" as const,
  };
}
