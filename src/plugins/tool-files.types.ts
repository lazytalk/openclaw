/** Opaque managed files shared by plugin tools and the active sandbox. */
export type PluginArtifact = Readonly<{
  artifactRef: string;
  fileName: string;
  contentType?: string;
  size: number;
  sha256: string;
  expiresAt: number;
}>;

/** Host-bound capability. Bytes never belong in tool results or model context. */
export type PluginToolFiles = {
  readonly capabilities?: Readonly<{
    contractVersion: number;
    streaming: boolean;
    maxBytes: number;
    totalBytes: number;
    maxArtifacts: number;
    maxConcurrentTransfers: number;
    materialize?: boolean;
    export?: boolean;
    backend?: "sandbox" | "restricted-host" | "unavailable";
    signature?: string;
    runtimeIdentity?: Readonly<{ version: string; buildId: string | null }>;
  }>;
  importStream(params: {
    stream: AsyncIterable<Uint8Array>;
    fileName: string;
    contentType?: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<PluginArtifact>;
  openStream(params: {
    artifactRef: string;
    signal?: AbortSignal;
  }): Promise<PluginArtifact & { stream: AsyncIterable<Uint8Array> }>;
  materialize(params: {
    artifactRef: string;
    signal?: AbortSignal;
  }): Promise<{ sandboxPath: string; workspacePath?: string; backend?: string; size: number }>;
  export(params: {
    sandboxPath?: string;
    workspacePath?: string;
    fileName?: string;
    contentType?: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<PluginArtifact>;
  /** Owner-scoped release for explicit verification and temporary workflows. */
  remove?(params: { artifactRef: string }): Promise<void>;
  removeMaterialized?(params: { workspacePath: string }): Promise<void>;
  copyMaterialized?(params: {
    workspacePath: string;
    signal?: AbortSignal;
  }): Promise<{ workspacePath: string; sandboxPath: string }>;
};
