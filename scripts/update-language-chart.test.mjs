import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAuthoredLanguageStats,
  collapseEntries,
  discoverAllRepos,
  languageForPath,
  renderChart,
} from "./update-language-chart.mjs";

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

test("maps source filenames to languages and ignores generated dependency paths", () => {
  assert.equal(languageForPath("src/server.ts"), "TypeScript");
  assert.equal(languageForPath("native/widget.cpp"), "C++");
  assert.equal(languageForPath("Dockerfile.dev"), "Dockerfile");
  assert.equal(languageForPath("CMakeLists.txt"), "CMake");
  assert.equal(languageForPath("vendor/copied.js"), null);
  assert.equal(languageForPath("README.md"), null);
});

test("counts only authored non-merge additions and deduplicates commits across forks", async () => {
  const requestedPaths = [];
  const commitsByRepo = {
    "owner/fork": [
      { sha: "authored", parents: [{ sha: "parent" }] },
      { sha: "merge", parents: [{ sha: "one" }, { sha: "two" }] },
    ],
    "upstream/project": [
      { sha: "authored", parents: [{ sha: "parent" }] },
    ],
    "owner/unmodified-fork": [],
  };
  const request = async (path) => {
    requestedPaths.push(path);
    const listMatch = path.match(/^\/repos\/([^?]+)\/commits\?author=/);
    if (listMatch) return commitsByRepo[listMatch[1]] || [];
    if (path.startsWith("/repos/owner/fork/commits/authored?")) {
      return {
        files: [
          { filename: "src/app.js", additions: 12 },
          { filename: "native/main.cpp", additions: 5 },
          { filename: "README.md", additions: 50 },
          { filename: "src/removed.py", additions: 0 },
        ],
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const result = await collectAuthoredLanguageStats(
    [
      { full_name: "owner/fork", fork: true },
      { full_name: "upstream/project", fork: false },
      { full_name: "owner/unmodified-fork", fork: true },
    ],
    "example-user",
    { request },
  );

  assert.deepEqual(result.entries, [
    { name: "JavaScript", lines: 12 },
    { name: "C++", lines: 5 },
  ]);
  assert.equal(result.repoCount, 1);
  assert.equal(result.commitCount, 1);
  assert.equal(
    requestedPaths.filter((path) => path.includes("/commits/authored?")).length,
    1,
  );
  assert.equal(requestedPaths.some((path) => path.includes("/commits/merge?")), false);
});

test("shows the top 14 languages plus Other in a fixed three-by-five legend", () => {
  const entries = Array.from({ length: 18 }, (_, index) => ({
    name: `Language-${index + 1}`,
    lines: 1000 - index,
  }));

  const collapsed = collapseEntries(entries);
  const svg = renderChart(entries, 9, "example-user");

  assert.equal(collapsed.length, 15);
  assert.equal(collapsed.at(-1).name, "Other");
  assert.match(svg, /viewBox="0 0 1000 320"/);
  assert.equal((svg.match(/class="language"/g) || []).length, 15);
  assert.equal((svg.match(/translate\(345 /g) || []).length, 5);
  assert.equal((svg.match(/translate\(565 /g) || []).length, 5);
  assert.equal((svg.match(/translate\(785 /g) || []).length, 5);
  assert.match(svg, />Other</);
  assert.doesNotMatch(svg, />Language-15</);
  assert.match(svg, /Forks contribute only changes authored by this account/);
  assert.match(svg, />9 repositories</);
});
