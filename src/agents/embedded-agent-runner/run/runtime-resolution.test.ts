import { describe, expect, it } from "vitest";
import { resolveThinkingDefaultWithRuntimeCatalog } from "../../model-thinking-default.js";
import {
  resolveInitialThinkLevel,
  resolveRequestStreamTransportOverrides,
} from "./runtime-resolution.js";

describe("resolveRequestStreamTransportOverrides", () => {
  it("marks non-empty request stream parameters for OpenClaw routing", () => {
    expect(resolveRequestStreamTransportOverrides({ maxTokens: 64 })).toBe("present");
  });

  it("keeps an empty request stream parameter record on the implicit runtime route", () => {
    expect(resolveRequestStreamTransportOverrides({})).toBeUndefined();
  });
});

describe("resolveInitialThinkLevel", () => {
  it("preserves logical Ultra until the provider runtime boundary", () => {
    expect(
      resolveInitialThinkLevel({
        requested: "ultra",
        config: {},
        provider: "openai",
        modelId: "gpt-5.5",
        model: { reasoning: true },
      }),
    ).toBe("ultra");
  });

  it("uses the selected agent model thinking default", () => {
    expect(
      resolveInitialThinkLevel({
        config: {
          agents: {
            defaults: {
              models: { "openai/gpt-5.5": { params: { thinking: "low" } } },
            },
            entries: {
              audit: {
                models: { "openai/gpt-5.5": { params: { thinking: "high" } } },
              },
            },
          },
        },
        provider: "openai",
        modelId: "gpt-5.5",
        model: { reasoning: true },
        agentId: "audit",
      }),
    ).toBe("high");
  });
});

describe("resolveThinkingDefaultWithRuntimeCatalog", () => {
  it("preserves agent scope through the runtime-catalog lookup", async () => {
    await expect(
      resolveThinkingDefaultWithRuntimeCatalog({
        cfg: {
          agents: {
            defaults: {
              models: { "openai/gpt-5.5": { params: { thinking: "low" } } },
            },
            entries: {
              audit: {
                models: { "openai/gpt-5.5": { params: { thinking: "high" } } },
              },
            },
          },
        },
        provider: "openai",
        model: "gpt-5.5",
        agentId: "audit",
        loadRuntimeCatalog: async () => [
          { provider: "openai", id: "gpt-5.5", name: "gpt-5.5", reasoning: true },
        ],
      }),
    ).resolves.toBe("high");
  });
});
