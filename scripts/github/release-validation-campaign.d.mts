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

type CampaignRepoRequest = {
  owner: string;
  repo: string;
};

type CampaignIssue = {
  number: number;
  state: string;
  title: string;
  body?: string | null;
  html_url: string;
  labels: Array<string | { name?: string }>;
  pull_request?: { url: string | null };
};

type CampaignListIssuesRequest = CampaignRepoRequest & {
  state: "open";
  labels: string;
  per_page: number;
};

type CampaignIssueNumberRequest = CampaignRepoRequest & {
  issue_number: number;
};

type CampaignGetLabelRequest = CampaignRepoRequest & {
  name: string;
};

type CampaignCreateLabelRequest = CampaignRepoRequest & {
  name: string;
  color: string;
  description: string;
};

type CampaignCreateCommentRequest = CampaignIssueNumberRequest & {
  body: string;
};

type CampaignCreateIssueRequest = CampaignRepoRequest & {
  title: string;
  body: string;
  labels: string[];
};

type CampaignUpdateIssueRequest =
  | (CampaignIssueNumberRequest & {
      title: string;
      body: string;
      state: "open";
      labels: string[];
    })
  | (CampaignIssueNumberRequest & {
      state: "closed";
      state_reason: "completed";
      labels: string[];
    });

type CampaignIssueResponse = Promise<{ data: CampaignIssue }>;

type CampaignListIssuesMethod = (
  parameters: CampaignListIssuesRequest,
) => Promise<{ data: CampaignIssue[] }>;

type CampaignGitHub = {
  paginate(
    method: CampaignListIssuesMethod,
    parameters: CampaignListIssuesRequest,
  ): Promise<CampaignIssue[]>;
  rest: {
    issues: {
      listForRepo: CampaignListIssuesMethod;
      getLabel(parameters: CampaignGetLabelRequest): Promise<unknown>;
      createLabel(parameters: CampaignCreateLabelRequest): Promise<unknown>;
      createComment(parameters: CampaignCreateCommentRequest): Promise<unknown>;
      create(parameters: CampaignCreateIssueRequest): CampaignIssueResponse;
      update(parameters: CampaignUpdateIssueRequest): CampaignIssueResponse;
      get(parameters: CampaignIssueNumberRequest): CampaignIssueResponse;
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
