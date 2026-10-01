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
  }): Promise<{ sandboxPath: string; size: number }>;
  export(params: {
    sandboxPath: string;
    fileName?: string;
    contentType?: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<PluginArtifact>;
};
