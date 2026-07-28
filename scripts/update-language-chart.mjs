// 自动更新 language-stats.svg
// 使用认证用户可访问的全部仓库（owner / collaborator / organization_member），
// 对每个仓库的 GitHub Linguist 语言字节数进行汇总。
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const configuredUsername = process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER;
const token = process.env.LANGUAGE_STATS_TOKEN || process.env.GITHUB_TOKEN;
const requireAuthenticatedRepos = process.env.REQUIRE_AUTHENTICATED_REPOS === "true";
const excludeForks = process.env.EXCLUDE_FORKS === "true";
const apiBaseUrl = process.env.GITHUB_API_URL || "https://api.github.com";
const outputPath = "assets/language-stats.svg";

// 语言配色（贴近 GitHub Linguist）
const colors = {
  "C#": "#178600", "C++": "#f34b7d", C: "#555555", CSS: "#663399",
  Dart: "#00B4AB", Go: "#00ADD8", HTML: "#e34c26", Java: "#b07219",
  JavaScript: "#f1e05a", Kotlin: "#a97bff", Lua: "#000080", PHP: "#4F5D95",
  PowerShell: "#012456", Python: "#3572A5", Ruby: "#701516", Rust: "#dea584",
  Shell: "#89e051", SQL: "#e38c00", Swift: "#F05138", TypeScript: "#3178c6",
  Vue: "#41b883", XAML: "#0C54C2", Dockerfile: "#384d54", CMake: "#DA3434",
};
const fallbackColors = ["#8b5cf6", "#06b6d4", "#f97316", "#ec4899", "#84cc16"];

function pickColor(lang, index) {
  return colors[lang] || fallbackColors[index % fallbackColors.length];
}

async function github(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `${configuredUsername || "github-user"}-profile-language-chart`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${apiBaseUrl}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function githubGraphql(query, variables) {
  const headers = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": `${configuredUsername || "github-user"}-profile-language-chart`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${apiBaseUrl}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub GraphQL ${response.status}: ${JSON.stringify(result)}`);
  }
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

async function fetchAllPages(request, path) {
  const results = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const items = await request(`${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(items)) {
      throw new TypeError(`Expected a paginated array from ${path}`);
    }
    results.push(...items);
    if (items.length < 100) break;
  }
  return results;
}

function yearlyContributionWindows(createdAt, now) {
  const accountCreatedAt = new Date(createdAt);
  const endDate = new Date(now);
  if (Number.isNaN(accountCreatedAt.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new TypeError("GitHub returned an invalid account creation date.");
  }

  const windows = [];
  for (
    let year = accountCreatedAt.getUTCFullYear();
    year <= endDate.getUTCFullYear();
    year += 1
  ) {
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1) - 1);
    const from = yearStart < accountCreatedAt ? accountCreatedAt : yearStart;
    const to = yearEnd > endDate ? endDate : yearEnd;
    if (from <= to) windows.push({ from: from.toISOString(), to: to.toISOString() });
  }
  return windows;
}

async function findContributedRepositories(request, createdAt, now) {
  const query = `
    query ContributionRepositories($from: DateTime!, $to: DateTime!) {
      viewer {
        contributionsCollection(from: $from, to: $to) {
          totalRepositoriesWithContributedCommits
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              id
              nameWithOwner
              isFork
              isPrivate
            }
          }
        }
      }
    }
  `;
  const repositories = [];
  for (const window of yearlyContributionWindows(createdAt, now)) {
    console.log(`→ Fetching contribution repositories for ${window.from.slice(0, 4)}…`);
    const data = await request(query, window);
    const collection = data?.viewer?.contributionsCollection;
    if (!collection || !Array.isArray(collection.commitContributionsByRepository)) {
      throw new TypeError("Expected a GitHub contribution collection.");
    }
    if (
      collection.totalRepositoriesWithContributedCommits
      > collection.commitContributionsByRepository.length
    ) {
      console.warn(
        `⚠ GitHub limited ${window.from.slice(0, 4)} contribution details to 100 repositories.`,
      );
    }
    for (const contribution of collection.commitContributionsByRepository) {
      const repository = contribution.repository;
      if (!repository?.nameWithOwner) continue;
      repositories.push({
        id: repository.id,
        full_name: repository.nameWithOwner,
        fork: repository.isFork,
        private: repository.isPrivate,
      });
    }
  }
  return repositories;
}

function mergeRepositories(...groups) {
  const repositories = new Map();
  for (const group of groups) {
    for (const repository of group) {
      const key = repository.full_name.toLowerCase();
      repositories.set(key, repository);
    }
  }
  return [...repositories.values()];
}

/**
 * 返回认证用户能访问或曾经贡献过的全部仓库。
 *
 * 有 token 时，/user/repos 会覆盖自己拥有、作为协作者加入、以及通过组织成员身份
 * 可访问的 public / private 仓库；commit search 会补上曾经参与、但当前不在仓库
 * 列表中的项目。无 token 时仅保留公开 owner 仓库作为本地降级。
 */
export async function discoverAllRepos({
  request = github,
  hasToken = Boolean(token),
  username = configuredUsername,
  requireAuthenticated = requireAuthenticatedRepos,
  graphqlRequest = githubGraphql,
  now = new Date(),
} = {}) {
  if (!hasToken) {
    if (requireAuthenticated) {
      throw new Error(
        "LANGUAGE_STATS_TOKEN is required. Add a GitHub Actions secret with access to all repositories you want counted.",
      );
    }
    if (!username) {
      throw new Error("Set GITHUB_USERNAME or GITHUB_REPOSITORY_OWNER.");
    }

    console.warn("⚠ No token — only public repositories owned by the configured user will be counted.");
    const repos = await fetchAllPages(
      request,
      `/users/${encodeURIComponent(username)}/repos?type=owner&sort=full_name`,
    );
    return { username, repos };
  }

  const viewer = await request("/user");
  const authenticatedUsername = viewer?.login;
  if (!authenticatedUsername) {
    throw new Error("The configured token did not identify an authenticated GitHub user.");
  }
  if (username && authenticatedUsername.toLowerCase() !== username.toLowerCase()) {
    console.warn(
      `⚠ GITHUB_USERNAME is ${username}, but LANGUAGE_STATS_TOKEN belongs to ${authenticatedUsername}; using the token owner.`,
    );
  }

  console.log(`→ Fetching every repository accessible to ${authenticatedUsername}…`);
  const params = new URLSearchParams({
    visibility: "all",
    affiliation: "owner,collaborator,organization_member",
    sort: "full_name",
    direction: "asc",
  });
  const accessibleRepos = await fetchAllPages(request, `/user/repos?${params}`);
  const contributedRepos = await findContributedRepositories(
    graphqlRequest,
    viewer.created_at,
    now,
  );
  const repos = mergeRepositories(accessibleRepos, contributedRepos);
  console.log(
    `→ ${accessibleRepos.length} accessible + ${contributedRepos.length} contribution matches = ${repos.length} unique repositories`,
  );
  return { username: authenticatedUsername, repos };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function formatBytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${n} B`;
}

export function renderChart(entries, repoCount, username) {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const radius = 95;
  const strokeWidth = 32;
  const circumference = 2 * Math.PI * radius;
  const columnCount = Math.max(1, Math.min(4, Math.ceil(entries.length / 7)));
  const rowsPerColumn = Math.max(1, Math.ceil(entries.length / columnCount));
  const chartWidth = Math.max(780, 345 + (columnCount - 1) * 220 + 215);
  const chartHeight = Math.max(320, 67 + (rowsPerColumn - 1) * 36 + 30);
  const donutCenterY = chartHeight / 2;
  let offset = 0;

  const segments = entries.map((entry, index) => {
    const length = totalBytes ? (entry.bytes / totalBytes) * circumference : 0;
    const color = pickColor(entry.name, index);
    const gap = 2;
    const segmentLength = Math.max(length - gap, 0);
    const segment = `<circle cx="180" cy="${donutCenterY}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${segmentLength.toFixed(3)} ${(circumference - segmentLength).toFixed(3)}" stroke-dashoffset="-${offset.toFixed(3)}" />`;
    offset += length;
    return segment;
  }).join("\n    ");

  const legend = entries.map((entry, index) => {
    const column = Math.floor(index / rowsPerColumn);
    const row = index % rowsPerColumn;
    const x = 345 + column * 220;
    const y = 67 + row * 36;
    const color = pickColor(entry.name, index);
    const percentage = totalBytes ? (entry.bytes / totalBytes) * 100 : 0;
    const percentageText = percentage < 1 ? `${percentage.toFixed(2)}%` : `${percentage.toFixed(1)}%`;
    return `<g transform="translate(${x} ${y})"><circle cx="7" cy="-5" r="6" fill="${color}" /><text x="22" class="language">${escapeXml(entry.name)}</text><text x="22" y="17" class="percentage">${percentageText} · ${formatBytes(entry.bytes)}</text></g>`;
  }).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="title description">
  <title id="title">Languages across repositories owned or contributed to by ${escapeXml(username)}</title>
  <desc id="description">Donut chart of language composition across ${repoCount} owned or contributed ${repoCount === 1 ? "repository" : "repositories"}, including private repositories permitted by the token, measured in bytes of code.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #1f2328; }
    .title { font-size: 18px; font-weight: 600; fill: #1f2328; }
    .percentage { font-size: 12px; fill: #656d76; }
    .language { font-size: 14px; font-weight: 600; fill: #1f2328; }
    .count { font-size: 30px; font-weight: 700; fill: #1f2328; }
    .track { stroke: #d0d7de; }
    @media (prefers-color-scheme: dark) {
      .title, .language, .count { fill: #f0f6fc; }
      .percentage { fill: #8b949e; }
      .track { stroke: #30363d; }
    }
  </style>
  <text x="24" y="32" class="title">Coding Profile · Owned &amp; Contributed Repository Languages</text>
  <g transform="rotate(-90 180 ${donutCenterY})">
    <circle class="track" cx="180" cy="${donutCenterY}" r="${radius}" fill="none" stroke-width="${strokeWidth}" />
    ${segments}
  </g>
  <text x="180" y="${donutCenterY - 6}" text-anchor="middle" class="count">${entries.length}</text>
  <text x="180" y="${donutCenterY + 16}" text-anchor="middle" class="percentage">languages</text>
  <text x="180" y="${donutCenterY + 36}" text-anchor="middle" class="percentage">${repoCount} ${repoCount === 1 ? "repository" : "repositories"}</text>
  ${legend}
</svg>
`;
}

export async function main() {
  const discovery = await discoverAllRepos();
  const repos = excludeForks
    ? discovery.repos.filter((repo) => !repo.fork)
    : discovery.repos;
  const totals = new Map();

  for (const repo of repos) {
    const languages = await github(`/repos/${repo.full_name}/languages`);
    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) || 0) + bytes);
    }
  }

  const entries = [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes);

  await mkdir("assets", { recursive: true });
  await writeFile(outputPath, renderChart(entries, repos.length, discovery.username), "utf8");

  const aggregateBytes = totalBytes(entries);
  console.log(`✓ ${outputPath}  ·  ${repos.length} repos  ·  ${entries.length} languages`);
  for (const entry of entries) {
    const percentage = aggregateBytes ? (entry.bytes / aggregateBytes) * 100 : 0;
    console.log(`  ${entry.name}: ${formatBytes(entry.bytes)} (${percentage.toFixed(1)}%)`);
  }
}

function totalBytes(entries) {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
