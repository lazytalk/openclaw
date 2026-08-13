/**
 * Resolves fast-mode state from agent config and runtime defaults.
 */
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeFastMode } from "../auto-reply/thinking.shared.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_FAST_MODE_AUTO_ON_SECONDS,
  type FastModeSource,
  resolveFastModeModelParams,
} from "../shared/fast-mode.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";

export {
  DEFAULT_FAST_MODE_AUTO_ON_SECONDS,
  formatFastModeAutoProgressText,
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeSourceSuffix,
  formatFastModeStatusValue,
  formatFastModeValue,
  resolveFastModeForElapsed,
} from "../shared/fast-mode.js";
export type { FastModeAutoProgressState } from "../shared/fast-mode.js";

// Resolves effective fast-mode state from session, agent, model config, then
// default. Callers keep the source for diagnostics and prompt explanations.
type FastModeState = {
  mode: FastMode;
  enabled: boolean;
  source: FastModeSource;
  fastAutoOnSeconds: number;
};

function resolveConfiguredFastModeParamSources(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentId?: string;
}): Array<Record<string, unknown> | undefined> {
  const sources = resolveModelExtraParamSources({
    config: params.cfg,
    provider: params.provider,
    modelId: params.model,
    agentId: params.agentId,
  });
  return [
    sources.agentModelParams,
    sources.agentEntryParams,
    resolveFastModeModelParams(params),
    sources.defaultParams,
  ];
}

function resolveConfiguredFastModeValue(
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
  accepts?: (value: unknown) => boolean,
): unknown {
  for (const source of sources) {
    for (const key of keys) {
      const value = source?.[key];
      if (source && Object.hasOwn(source, key) && (!accepts || accepts(value))) {
        return value;
      }
    }
  }
  return undefined;
}

function resolveConfiguredFastModeAutoOnSeconds(
  sources: Array<Record<string, unknown> | undefined>,
): number {
  const value = resolveConfiguredFastModeValue(
    sources,
    ["fastAutoOnSeconds", "fast_auto_on_seconds", "fastSeconds", "fast_seconds"],
    (candidate) => typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0,
  );
  return typeof value === "number" ? value : DEFAULT_FAST_MODE_AUTO_ON_SECONDS;
}

/** Resolve the effective fast-mode setting and its source. */
export function resolveFastModeState(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentId?: string;
  sessionEntry?: Pick<SessionEntry, "fastMode"> | undefined;
}): FastModeState {
  const configuredParamSources = resolveConfiguredFastModeParamSources(params);
  const fastAutoOnSeconds = resolveConfiguredFastModeAutoOnSeconds(configuredParamSources);
  const sessionOverride = normalizeFastMode(params.sessionEntry?.fastMode);
  if (sessionOverride !== undefined) {
    return {
      mode: sessionOverride,
      enabled: sessionOverride === "auto" ? true : sessionOverride,
      source: "session",
      fastAutoOnSeconds,
    };
  }

  const agentDefault =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.fastModeDefault
      : undefined;
  const normalizedAgentDefault = normalizeFastMode(agentDefault);
  if (normalizedAgentDefault !== undefined) {
    return {
      mode: normalizedAgentDefault,
      enabled: normalizedAgentDefault === "auto" ? true : normalizedAgentDefault,
      source: "agent",
      fastAutoOnSeconds,
    };
  }

  const configuredRaw = resolveConfiguredFastModeValue(configuredParamSources, [
    "fastMode",
    "fast_mode",
  ]);
  const configured = normalizeFastMode(configuredRaw as string | boolean | null | undefined);
  if (configured !== undefined) {
    return {
      mode: configured,
      enabled: configured === "auto" ? true : configured,
      source: "config",
      fastAutoOnSeconds,
    };
  }

  return {
    mode: false,
    enabled: false,
    source: "default",
    fastAutoOnSeconds,
  };
}
