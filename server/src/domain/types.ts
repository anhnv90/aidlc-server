export type RuleAction = "add" | "update" | "delete";

export type RuleUpdateStatus = "received" | "running" | "pr_created" | "failed" | "rejected";

export type MattermostMessage = {
  postId: string;
  channelId: string;
  userId: string;
  username?: string;
  message: string;
  rootId?: string;
  createdAt: string;
};

export type AskCommand = {
  type: "ask";
  query: string;
  classifyRuleScope?: boolean;
};

export type RuleUpdateCommand = {
  type: RuleAction;
  ruleId: string;
  targetFiles: string[];
  title?: string;
  content?: string;
  acceptance?: string;
};

export type ParsedCommand =
  | {
      kind: "ignored";
      reason: string;
    }
  | {
      kind: "help";
      reason?: string;
    }
  | {
      kind: "ask";
      command: AskCommand;
    }
  | {
      kind: "rule-update";
      command: RuleUpdateCommand;
    };

export type RuleUpdateHistory = {
  id: number;
  mattermostPostId: string | null;
  mattermostChannelId: string;
  mattermostUserId: string;
  mattermostUsername: string | null;
  commandText: string;
  action: RuleAction;
  ruleId: string;
  title: string | null;
  targetFiles: string[];
  status: RuleUpdateStatus;
  gitBranch: string | null;
  githubPrUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
