// 自动更新 language-stats.svg
// 使用认证用户可访问或曾经贡献过的仓库，并按认证用户本人提交的
// 文件新增行数统计语言；不会把协作仓库或 Fork 的全部代码算入结果。
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const configuredUsername = process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER;
const token = process.env.LANGUAGE_STATS_TOKEN || process.env.GITHUB_TOKEN;
const requireAuthenticatedRepos = process.env.REQUIRE_AUTHENTICATED_REPOS === "true";
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

const extensionLanguages = new Map(Object.entries({
  ".asm": "Assembly", ".s": "Assembly",
  ".c": "C", ".h": "C",
  ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hh": "C++", ".hpp": "C++", ".hxx": "C++",
  ".cmake": "CMake",
  ".cs": "C#",
  ".css": "CSS",
  ".dart": "Dart",
  ".ex": "Elixir", ".exs": "Elixir",
  ".erl": "Erlang", ".hrl": "Erlang",
  ".fs": "F#", ".fsi": "F#", ".fsx": "F#",
  ".go": "Go",
  ".groovy": "Groovy",
  ".htm": "HTML", ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript", ".cjs": "JavaScript", ".mjs": "JavaScript", ".jsx": "JavaScript",
  ".kt": "Kotlin", ".kts": "Kotlin",
  ".less": "Less",
  ".lua": "Lua",
  ".m": "Objective-C", ".mm": "Objective-C++",
  ".nim": "Nim",
  ".php": "PHP",
  ".pl": "Perl", ".pm": "Perl",
  ".ps1": "PowerShell", ".psd1": "PowerShell", ".psm1": "PowerShell",
  ".py": "Python", ".pyw": "Python",
  ".r": "R",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".sass": "Sass", ".scss": "SCSS",
  ".scala": "Scala",
  ".sh": "Shell", ".bash": "Shell", ".fish": "Shell", ".zsh": "Shell",
  ".sol": "Solidity",
  ".sql": "SQL",
  ".swift": "Swift",
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".vb": "Visual Basic .NET",
  ".vue": "Vue",
  ".xaml": "XAML",
  ".zig": "Zig",
}));

const ignoredPathParts = new Set([
  "build", "coverage", "dist", "node_modules", "vendor",
]);

function pickColor(lang, index) {
  if (lang === "Other") return "#8b949e";
  return colors[lang] || fallbackColors[index % fallbackColors.length];
}

export function languageForPath(filename) {
  const normalized = String(filename).replaceAll("\\", "/");
  const parts = normalized.toLowerCase().split("/");
  if (parts.some((part) => ignoredPathParts.has(part))) return null;

  const basename = parts.at(-1) || "";
  if (basename === "cmakelists.txt") return "CMake";
  if (basename === "makefile" || basename === "gnumakefile") return "Makefile";
  if (basename === "containerfile" || basename.startsWith("containerfile.")) return "Dockerfile";
  if (basename === "dockerfile" || basename.startsWith("dockerfile.")) return "Dockerfile";

  const dot = basename.lastIndexOf(".");
  if (dot < 0) return null;
  return extensionLanguages.get(basename.slice(dot)) || null;
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
    const error = new Error(`GitHub API ${response.status}: ${await response.text()}`);
    error.status = response.status;
    throw error;
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

function encodedRepositoryPath(fullName) {
  return String(fullName).split("/").map(encodeURIComponent).join("/");
}

async function fetchCommitFiles(request, repositoryPath, sha) {
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const commit = await request(
      `/repos/${repositoryPath}/commits/${encodeURIComponent(sha)}?per_page=100&page=${page}`,
    );
    if (!Array.isArray(commit?.files)) {
      throw new TypeError(`Expected files for commit ${sha}.`);
    }
    files.push(...commit.files);
    if (commit.files.length < 100) break;
  }
  return files;
}

/**
 * 汇总 GitHub 归属于 username 的非合并提交。
 *
 * GitHub 把替换一行表示为删除旧行并新增新行，因此使用 additions 可以表示
 * 用户实际写入的新增/修改代码，同时不会把已经存在于 Fork 中的上游代码算入。
 */
export async function collectAuthoredLanguageStats(
  repos,
  username,
  { request = github } = {},
) {
  const totals = new Map();
  const seenCommitShas = new Set();
  const contributingRepositories = new Set();
  let commitCount = 0;

  for (const repo of repos) {
    const repositoryPath = encodedRepositoryPath(repo.full_name);
    const params = new URLSearchParams({ author: username });
    let commits;
    try {
      commits = await fetchAllPages(
        request,
        `/repos/${repositoryPath}/commits?${params}`,
      );
    } catch (error) {
      if (error?.status === 404 || error?.status === 409) {
        console.warn(`⚠ Skipping unavailable or empty repository ${repo.full_name}.`);
        continue;
      }
      throw error;
    }

    for (const commit of commits) {
      if (!commit?.sha || seenCommitShas.has(commit.sha)) continue;
      seenCommitShas.add(commit.sha);

      // A merge diff can contain code written by every PR author, not just the merger.
      if (Array.isArray(commit.parents) && commit.parents.length > 1) continue;

      let files;
      try {
        files = await fetchCommitFiles(request, repositoryPath, commit.sha);
      } catch (error) {
        if (error?.status === 404 || error?.status === 409) {
          console.warn(`⚠ Skipping unavailable commit ${commit.sha} in ${repo.full_name}.`);
          continue;
        }
        throw error;
      }

      let recognizedAdditions = 0;
      for (const file of files) {
        const language = languageForPath(file.filename);
        const additions = Number(file.additions) || 0;
        if (!language || additions <= 0) continue;
        totals.set(language, (totals.get(language) || 0) + additions);
        recognizedAdditions += additions;
      }
      if (recognizedAdditions > 0) {
        contributingRepositories.add(repo.full_name.toLowerCase());
        commitCount += 1;
      }
    }
  }

  const entries = [...totals.entries()]
    .map(([name, lines]) => ({ name, lines }))
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));

  return {
    entries,
    repoCount: contributingRepositories.size,
    commitCount,
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function formatLines(n) {
  return `${new Intl.NumberFormat("en-US").format(n)} lines`;
}

export function collapseEntries(entries, maximumLanguages = 14) {
  const sorted = [...entries]
    .filter((entry) => entry.lines > 0)
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  if (sorted.length <= maximumLanguages) return sorted;

  const visible = sorted.slice(0, maximumLanguages);
  const otherLines = sorted
    .slice(maximumLanguages)
    .reduce((sum, entry) => sum + entry.lines, 0);
  return [...visible, { name: "Other", lines: otherLines }];
}

export function renderChart(entries, repoCount, username) {
  const displayedEntries = collapseEntries(entries);
  const totalLines = entries.reduce((sum, entry) => sum + entry.lines, 0);
  const radius = 95;
  const strokeWidth = 32;
  const circumference = 2 * Math.PI * radius;
  const rowsPerColumn = 5;
  const chartWidth = 1000;
  const chartHeight = 320;
  const donutCenterY = chartHeight / 2;
  let offset = 0;

  const segments = displayedEntries.map((entry, index) => {
    const length = totalLines ? (entry.lines / totalLines) * circumference : 0;
    const color = pickColor(entry.name, index);
    const gap = 2;
    const segmentLength = Math.max(length - gap, 0);
    const segment = `<circle cx="180" cy="${donutCenterY}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${segmentLength.toFixed(3)} ${(circumference - segmentLength).toFixed(3)}" stroke-dashoffset="-${offset.toFixed(3)}" />`;
    offset += length;
    return segment;
  }).join("\n    ");

  const legend = displayedEntries.map((entry, index) => {
    const column = Math.floor(index / rowsPerColumn);
    const row = index % rowsPerColumn;
    const x = 345 + column * 220;
    const y = 67 + row * 36;
    const color = pickColor(entry.name, index);
    const percentage = totalLines ? (entry.lines / totalLines) * 100 : 0;
    const percentageText = percentage < 1 ? `${percentage.toFixed(2)}%` : `${percentage.toFixed(1)}%`;
    return `<g transform="translate(${x} ${y})"><circle cx="7" cy="-5" r="6" fill="${color}" /><text x="22" class="language">${escapeXml(entry.name)}</text><text x="22" y="17" class="percentage">${percentageText} · ${formatLines(entry.lines)}</text></g>`;
  }).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="title description">
  <title id="title">Languages personally contributed by ${escapeXml(username)}</title>
  <desc id="description">Donut chart of languages in lines added or modified by ${escapeXml(username)} across ${repoCount} ${repoCount === 1 ? "repository" : "repositories"}, including accessible private repositories. Forks contribute only changes authored by this account. The top 14 languages are shown separately and the remainder is grouped as Other.</desc>
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
  <text x="24" y="32" class="title">Coding Profile · Personally Contributed Languages</text>
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
  const stats = await collectAuthoredLanguageStats(
    discovery.repos,
    discovery.username,
  );

  await mkdir("assets", { recursive: true });
  await writeFile(
    outputPath,
    renderChart(stats.entries, stats.repoCount, discovery.username),
    "utf8",
  );

  const aggregateLines = totalLines(stats.entries);
  console.log(
    `✓ ${outputPath}  ·  ${stats.repoCount} repos  ·  ${stats.commitCount} commits  ·  ${stats.entries.length} languages`,
  );
  for (const entry of collapseEntries(stats.entries)) {
    const percentage = aggregateLines ? (entry.lines / aggregateLines) * 100 : 0;
    console.log(`  ${entry.name}: ${formatLines(entry.lines)} (${percentage.toFixed(1)}%)`);
  }
}

function totalLines(entries) {
  return entries.reduce((sum, entry) => sum + entry.lines, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
