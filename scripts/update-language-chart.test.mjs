import assert from "node:assert/strict";
import test from "node:test";

import { discoverAllRepos, renderChart } from "./update-language-chart.mjs";

test("unions accessible and historically contributed repositories", async () => {
  const requestedPaths = [];
  const contributionWindows = [];
  const privateRepo = { id: 1, full_name: "team/private-app", private: true, fork: false };
  const publicRepo = { id: 2, full_name: "user/public-app", private: false, fork: false };
  const historicalRepo = { id: 3, full_name: "archive/old-app", private: false, fork: false };
  const request = async (path) => {
    requestedPaths.push(path);
    if (path === "/user") {
      return { login: "example-user", created_at: "2024-06-15T00:00:00.000Z" };
    }
    if (path.startsWith("/user/repos?")) return [privateRepo, publicRepo];
    throw new Error(`Unexpected request: ${path}`);
  };
  const graphqlRequest = async (_query, variables) => {
    contributionWindows.push(variables);
    const repositories = variables.from.startsWith("2024")
      ? [
          {
            repository: {
              id: "R_public",
              nameWithOwner: publicRepo.full_name,
              isFork: false,
              isPrivate: false,
            },
          },
          {
            repository: {
              id: "R_historical",
              nameWithOwner: historicalRepo.full_name,
              isFork: false,
              isPrivate: false,
            },
          },
        ]
      : [];
    return {
      viewer: {
        contributionsCollection: {
          totalRepositoriesWithContributedCommits: repositories.length,
          commitContributionsByRepository: repositories,
        },
      },
    };
  };

  const result = await discoverAllRepos({
    request,
    hasToken: true,
    username: "example-user",
    graphqlRequest,
    now: new Date("2025-07-01T00:00:00.000Z"),
  });

  assert.equal(result.username, "example-user");
  assert.deepEqual(
    result.repos.map((repo) => repo.full_name),
    [privateRepo.full_name, publicRepo.full_name, historicalRepo.full_name],
  );
  assert.match(requestedPaths[1], /^\/user\/repos\?/);
  assert.match(requestedPaths[1], /visibility=all/);
  assert.match(
    requestedPaths[1],
    /affiliation=owner%2Ccollaborator%2Corganization_member/,
  );
  assert.equal(contributionWindows.length, 2);
  assert.equal(contributionWindows[0].from, "2024-06-15T00:00:00.000Z");
  assert.equal(contributionWindows[1].to, "2025-07-01T00:00:00.000Z");
});

test("refuses a public-only fallback when authenticated statistics are required", async () => {
  await assert.rejects(
    discoverAllRepos({
      request: async () => [],
      hasToken: false,
      username: "example-user",
      requireAuthenticated: true,
    }),
    /LANGUAGE_STATS_TOKEN is required/,
  );
});

test("expands the SVG so every language legend remains inside the view box", () => {
  const entries = Array.from({ length: 15 }, (_, index) => ({
    name: `Language-${index + 1}`,
    bytes: 1000 - index,
  }));

  const svg = renderChart(entries, 9, "example-user");

  assert.match(svg, /viewBox="0 0 1000 320"/);
  assert.equal((svg.match(/class="language"/g) || []).length, 15);
  assert.match(svg, /including private repositories permitted by the token/);
  assert.match(svg, />9 repositories</);
});
