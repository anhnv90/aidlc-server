import { config } from "../config";

export type CreatePullRequestInput = {
  title: string;
  body: string;
  head: string;
  base: string;
};

export async function createPullRequest(input: CreatePullRequestInput) {
  const response = await fetch(`https://api.github.com/repos/${config.github.owner}/${config.github.repo}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.github.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub PR creation failed: HTTP ${response.status} ${body}`);
  }

  const json = (await response.json()) as { html_url?: string };
  if (!json.html_url) {
    throw new Error("GitHub PR creation response did not include html_url");
  }
  return json.html_url;
}

