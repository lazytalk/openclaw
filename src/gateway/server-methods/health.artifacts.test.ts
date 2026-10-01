import { afterEach, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { healthHandlers } from "./health.js";
afterEach(() => resetConfigRuntimeState());
it("advertises the active generic artifact contract and configured limits through health", async () => {
  const config = { tools: { artifacts: { maxBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3 } } };
  setRuntimeConfigSnapshot(config, config);
  const respond = vi.fn();
  await healthHandlers.health!({
    params: { probe: true },
    respond,
    client: null,
    context: {
      getHealthCache: () => null,
      refreshHealthSnapshot: async () => ({ ok: true }),
      logHealth: { error: vi.fn() },
    },
  } as never);
  expect(respond.mock.calls[0]?.[1]).toMatchObject({
    managedArtifacts: { contractVersion: 2, streaming: true, maxBytes: 1024 ** 3 },
  });
});
