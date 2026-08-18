import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type GatewayModelCatalogLoadParams = {
  agentId?: string;
  agentDir?: string;
  providerDiscoveryProviderIds?: readonly string[];
  readOnly?: boolean;
  refreshFullCatalog?: boolean;
  scopedLiveProviderDiscovery?: boolean;
  workspaceDir?: string;
};

export type GatewayModelCatalogSnapshot = ModelCatalogSnapshot & {
  agentId: string;
  agentDir: string;
  catalogComplete: boolean;
  workspaceDir: string;
  config: OpenClawConfig;
};
