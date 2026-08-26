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

type CampaignIssue = {
  number: number;
  state: string;
  title: string;
  body: string | null;
  html_url: string;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
};

type CampaignIssueResponse = Promise<{ data: CampaignIssue }>;

type CampaignGitHub = {
  paginate(method: unknown, parameters: Record<string, unknown>): Promise<CampaignIssue[]>;
  rest: {
    issues: {
      listForRepo: unknown;
      getLabel(parameters: Record<string, unknown>): Promise<unknown>;
      createLabel(parameters: Record<string, unknown>): Promise<unknown>;
      createComment(parameters: Record<string, unknown>): Promise<unknown>;
      create(parameters: Record<string, unknown>): CampaignIssueResponse;
      update(parameters: Record<string, unknown>): CampaignIssueResponse;
      get(parameters: { owner: string; repo: string; issue_number: number }): CampaignIssueResponse;
    };
  };
};

export function validateReleaseValidationCampaignArtifact(
  artifact: unknown,
  options?: {
    expectedTag?: string;
    expectedReleaseCommit?: string;
    expectedGuidanceMainSha?: string;
  },
): ReleaseValidationCampaignArtifact;

export function runReleaseValidationCampaignPublish(params: {
  github: CampaignGitHub;
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
