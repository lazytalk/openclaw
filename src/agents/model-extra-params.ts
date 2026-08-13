import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelKey } from "../shared/model-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

type ModelExtraParamSources = {
  defaultParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  agentParams?: Record<string, unknown>;
  agentEntryParams?: Record<string, unknown>;
  agentModelParams?: Record<string, unknown>;
};

const FAST_MODE_CUTOFF_MODEL_PARAM_KEYS = new Set([
  "fastAutoOnSeconds",
  "fastSeconds",
  "fast_auto_on_seconds",
  "fast_seconds",
]);

// Native harnesses receive recognized values as typed run controls. Other value
// shapes with the same keys remain authored provider request parameters.
export function isAgentRuntimeModelParam(key: string, value: unknown): boolean {
  if (key === "thinking") {
    return (
      value === false ||
      value === "disabled" ||
      value === "none" ||
      (typeof value === "string" && normalizeThinkLevel(value) !== undefined)
    );
  }
  if (key === "fastMode" || key === "fast_mode") {
    return normalizeFastMode(value) !== undefined;
  }
  return (
    FAST_MODE_CUTOFF_MODEL_PARAM_KEYS.has(key) &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
  );
}

function legacyModelKey(provider: string, modelId: string): string | undefined {
  const rawKey = `${provider.trim()}/${modelId.trim()}`;
  const canonicalKey = modelKey(provider, modelId);
  return rawKey === canonicalKey ? undefined : rawKey;
}

/** Resolves the config records merged into one model request. */
export function resolveModelExtraParamSources(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId?: string;
  agentId?: string;
}): ModelExtraParamSources {
  const defaultParams = params.config?.agents?.defaults?.params;
  const configuredModels = params.config?.agents?.defaults?.models;
  const canonicalKey = params.modelId ? modelKey(params.provider, params.modelId) : undefined;
  const legacyKey = params.modelId ? legacyModelKey(params.provider, params.modelId) : undefined;
  const modelParams = canonicalKey
    ? (configuredModels?.[canonicalKey]?.params ??
      (legacyKey ? configuredModels?.[legacyKey]?.params : undefined))
    : undefined;
  const agentConfig =
    params.agentId && params.config ? resolveAgentConfig(params.config, params.agentId) : undefined;
  const agentEntryParams = agentConfig?.params;
  const agentModelParams = canonicalKey
    ? (agentConfig?.models?.[canonicalKey]?.params ??
      (legacyKey ? agentConfig?.models?.[legacyKey]?.params : undefined))
    : undefined;
  // Keep the merged exact-key projection for classifiers and diagnostics.
  // Request construction uses the separate records so alias precedence survives.
  const agentParams = agentModelParams
    ? { ...agentEntryParams, ...agentModelParams }
    : agentEntryParams;
  return { defaultParams, modelParams, agentParams, agentEntryParams, agentModelParams };
}

/** Resolves one authored parameter across the canonical config precedence. */
export function resolveModelExtraParamValue(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
  key: string,
): unknown {
  const sources = resolveModelExtraParamSources(params);
  for (const source of [
    sources.agentModelParams,
    sources.agentEntryParams,
    sources.modelParams,
    sources.defaultParams,
  ]) {
    if (source && Object.hasOwn(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

/** Returns whether embedded OpenClaw would apply authored provider request parameters. */
export function hasAuthoredProviderRequestParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
): boolean {
  const sources = resolveModelExtraParamSources(params);
  return Object.entries(
    Object.assign({}, sources.defaultParams, sources.modelParams, sources.agentParams),
  ).some(([key, value]) => !isAgentRuntimeModelParam(key, value));
}
