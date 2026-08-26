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

/** The subset of a campaign issue the publish flow reads back. */
export type ReleaseValidationCampaignIssue = {
  number: number;
  html_url: string;
  state: string;
  title: string;
  body?: string | null;
  labels?: Array<string | { name?: string | null }>;
  pull_request?: unknown;
};

/** Structural slice of the actions/github-script octokit client this flow calls. */
export type ReleaseValidationCampaignGithub = {
  rest: {
    issues: {
      getLabel(params: { owner: string; repo: string; name: string }): Promise<unknown>;
      createLabel(params: {
        owner: string;
        repo: string;
        name: string;
        color: string;
        description: string;
      }): Promise<unknown>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        labels: string[];
      }): Promise<{ data: ReleaseValidationCampaignIssue }>;
      get(params: {
        owner: string;
        repo: string;
        issue_number: number;
      }): Promise<{ data: ReleaseValidationCampaignIssue }>;
      update(params: {
        owner: string;
        repo: string;
        issue_number: number;
        title?: string;
        body?: string;
        state?: string;
        state_reason?: string;
        labels?: string[];
      }): Promise<{ data: ReleaseValidationCampaignIssue }>;
      listForRepo: unknown;
    };
  };
  paginate(
    route: unknown,
    params: Record<string, unknown>,
  ): Promise<ReleaseValidationCampaignIssue[]>;
};

export function runReleaseValidationCampaignPublish(params: {
  github: ReleaseValidationCampaignGithub;
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
