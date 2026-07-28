import assert from "node:assert/strict";
import test from "node:test";

import { discoverAllRepos, renderChart } from "./update-language-chart.mjs";

test("discovers every repository affiliation and includes private repositories", async () => {
  const requestedPaths = [];
  const privateRepo = { full_name: "team/private-app", private: true, fork: false };
  const publicRepo = { full_name: "user/public-app", private: false, fork: false };
  const request = async (path) => {
    requestedPaths.push(path);
    if (path === "/user") return { login: "example-user" };
    return [privateRepo, publicRepo];
  };

  const result = await discoverAllRepos({
    request,
    hasToken: true,
    username: "example-user",
  });

  assert.equal(result.username, "example-user");
  assert.deepEqual(result.repos, [privateRepo, publicRepo]);
  assert.match(requestedPaths[1], /^\/user\/repos\?/);
  assert.match(requestedPaths[1], /visibility=all/);
  assert.match(
    requestedPaths[1],
    /affiliation=owner%2Ccollaborator%2Corganization_member/,
  );
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
});
