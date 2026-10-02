/**
 * Provider-neutral handle for native session-retained resources.
 *
 * Bytes never belong in tool results or model context; plugins only exchange
 * opaque artifact references and metadata. Ownership, authorization, and
 * lifecycle come from the ambient admitted session, not from these values.
 */
export type PluginArtifact = Readonly<{
  artifactRef: string;
  fileName: string;
  contentType?: string;
  size: number;
  sha256: string;
}>;

/** Host-bound session resource capability exposed to plugin agent tools. */
export type PluginToolFiles = {
  /**
   * Stream external bytes into the current admitted session as a durable
   * session-retained resource. The caller cannot select a session or host path.
   */
  importStream(params: {
    stream: AsyncIterable<Uint8Array>;
    fileName: string;
    contentType?: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<PluginArtifact>;
  /** Open a session-retained resource as a bounded, integrity-checked stream. */
  openStream(params: {
    artifactRef: string;
    signal?: AbortSignal;
  }): Promise<PluginArtifact & { stream: AsyncIterable<Uint8Array> }>;
  /**
   * Project a session resource into the active execution workspace when one is
   * available. Fails closed without a supported execution workspace.
   */
  materialize(params: {
    artifactRef: string;
    signal?: AbortSignal;
  }): Promise<{ workspacePath: string; sandboxPath?: string; backend?: string; size: number }>;
  /** Publish a file confined to the active execution workspace as a new resource. */
  export(params: {
    workspacePath?: string;
    sandboxPath?: string;
    fileName?: string;
    contentType?: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<PluginArtifact>;
};
