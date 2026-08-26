export type ReleaseValidationCampaignArtifact =
  | {
      schema: "openclaw.release-validation-campaign/v1";
      operation: "upsert";
      tag: string;
      stableTrain: string;
      releaseUrl: string;
      releaseCommit: string;
      guidanceMainSha: string;
      title: string;
      body: string;
    }
  | {
      schema: "openclaw.release-validation-campaign/v1";
      operation: "close";
      tag: string;
      stableTrain: string;
      releaseUrl: string;
    };

export function validateReleaseValidationCampaignArtifact(
  artifact: unknown,
  options?: {
    expectedTag?: string;
    expectedReleaseCommit?: string;
    expectedGuidanceMainSha?: string;
  },
): ReleaseValidationCampaignArtifact;

/** The subset of the actions/github-script Octokit client the publisher touches. */
export type ReleaseValidationCampaignGitHub = {
  paginate(route: unknown, params: Record<string, unknown>): Promise<unknown[]>;
  rest: {
    issues: {
      getLabel(params: Record<string, unknown>): Promise<unknown>;
      createLabel(params: Record<string, unknown>): Promise<unknown>;
      createComment(params: Record<string, unknown>): Promise<unknown>;
      create(params: Record<string, unknown>): Promise<{ data: unknown }>;
      update(params: Record<string, unknown>): Promise<{ data: unknown }>;
      get(params: { issue_number: number }): Promise<{ data: unknown }>;
      listForRepo: unknown;
    };
  };
};

export function runReleaseValidationCampaignPublish(params: {
  github: ReleaseValidationCampaignGitHub;
  context: { repo: { owner: string; repo: string } };
  core: { info(message: string): void; setOutput?(name: string, value: string): void };
  artifact: unknown;
  expectedTag?: string;
  expectedReleaseCommit?: string;
  expectedGuidanceMainSha?: string;
  campaignIssueNumber?: number;
}): Promise<{
  action: "create" | "update" | "close" | "noop";
  issueNumber: number | undefined;
  issueUrl: string | undefined;
}>;
