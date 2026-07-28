// 自动更新 language-stats.svg
// 两步查询：1) 通过 commit search 发现所有参与过的公开仓库（含团队协作）
//           2) 对每个仓库取 languages 字节数并汇总渲染
// 适用于 CI 环境（使用自动注入的 GITHUB_TOKEN）
import { mkdir, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER;
const token = process.env.GITHUB_TOKEN;
const outputPath = "assets/language-stats.svg";

if (!username) {
  throw new Error("Set GITHUB_USERNAME or GITHUB_REPOSITORY_OWNER before generating the language chart.");
}

// 语言配色（贴近 GitHub Linguist）
const colors = {
  "C#": "#178600", "C++": "#f34b7d", C: "#555555", "CSS": "#663399",
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
    "User-Agent": `${username}-profile-language-chart`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// 通过 commit search 发现所有用户有提交的公开仓库（含 owner + 协作仓库）
async function discoverAllRepos() {
  const uniqueRepos = new Map();  // full_name → 保留详情

  // 先拉 owner 仓库（不需要 token，但 token 可提 rate limit）
  console.log("→ Fetching owner repos…");
  for (let page = 1; page <= 5; page += 1) {
    const repos = await github(`/users/${username}/repos?per_page=100&page=${page}&type=owner`);
    for (const repo of repos) {
      if (!repo.fork) uniqueRepos.set(repo.full_name, repo);
    }
    if (repos.length < 100) break;
  }

  // 再通过 commit search 发现所有有提交的仓库（包括团队协作项目）
  // commit search 需要 token；没 token 就只退到 owner repos
  if (token) {
    console.log("→ Searching all authored commits to discover collaborative repos…");
    const query = encodeURIComponent(`author:${username}`);
    for (let page = 1; page <= 10; page += 1) {
      const result = await github(`/search/commits?q=${query}&sort=author-date&order=desc&per_page=100&page=${page}`);
      for (const commit of result.items) {
        const name = commit.repository.full_name;
        if (!uniqueRepos.has(name)) {
          uniqueRepos.set(name, commit.repository);
        }
      }
      if (result.items.length < 100) break;
    }
  } else {
    console.warn("⚠ No GITHUB_TOKEN — only owner repos. Team repos won't be included.");
  }

  return [...uniqueRepos.values()];
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

function renderChart(entries, repoCount) {
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
  const radius = 95, strokeWidth = 32;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const segments = entries.map((entry, i) => {
    const length = totalBytes ? (entry.bytes / totalBytes) * circumference : 0;
    const color = pickColor(entry.name, i);
    const gap = 2;
    const segLen = Math.max(length - gap, 0);
    const seg = `<circle cx="180" cy="180" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${segLen.toFixed(3)} ${(circumference - segLen).toFixed(3)}" stroke-dashoffset="-${offset.toFixed(3)}" />`;
    offset += length;
    return seg;
  }).join("\n    ");

  const legend = entries.map((entry, i) => {
    const col = Math.floor(i / 5), row = i % 5;
    const x = 345 + col * 220, y = 75 + row * 44;
    const color = pickColor(entry.name, i);
    const pct = totalBytes ? (entry.bytes / totalBytes) * 100 : 0;
    const pctStr = pct < 1 ? `${pct.toFixed(2)}%` : `${pct.toFixed(1)}%`;
    return `<g transform="translate(${x} ${y})"><circle cx="7" cy="-5" r="6" fill="${color}" /><text x="22" class="language">${escapeXml(entry.name)}</text><text x="22" y="17" class="percentage">${pctStr} · ${formatBytes(entry.bytes)}</text></g>`;
  }).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="320" viewBox="0 0 780 320" role="img" aria-labelledby="title description">
  <title id="title">Languages in ${escapeXml(username)}'s public GitHub projects</title>
  <desc id="description">Donut chart of language composition across ${repoCount} public ${repoCount === 1 ? "repo" : "repos"}, measured in bytes of code.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #1f2328; }
    .title { font-size: 18px; font-weight: 600; fill: #1f2328; }
    .percentage { font-size: 12px; fill: #656d76; }
    .language { font-size: 14px; font-weight: 600; fill: #1f2328; }
    .count { font-size: 30px; font-weight: 700; fill: #1f2328; }
    .empty { font-size: 13px; fill: #656d76; }
    .track { stroke: #d0d7de; }
    @media (prefers-color-scheme: dark) {
      .title, .language, .count { fill: #f0f6fc; }
      .percentage, .empty { fill: #8b949e; }
      .track { stroke: #30363d; }
    }
  </style>
  <text x="24" y="32" class="title">Coding Profile · Public Project Languages</text>
  <g transform="rotate(-90 180 180)">
    <circle class="track" cx="180" cy="180" r="${radius}" fill="none" stroke-width="${strokeWidth}" />
    ${segments}
  </g>
  <text x="180" y="174" text-anchor="middle" class="count">${entries.length}</text>
  <text x="180" y="196" text-anchor="middle" class="percentage">languages</text>
  ${legend}
</svg>
`;
}

// ── main ──
const repos = await discoverAllRepos();
const allRepos = repos.filter((r) => !r.fork);
const totals = new Map();

for (const repo of allRepos) {
  const languages = await github(`/repos/${repo.full_name}/languages`);
  for (const [lang, bytes] of Object.entries(languages)) {
    totals.set(lang, (totals.get(lang) || 0) + bytes);
  }
}

const entries = [...totals.entries()]
  .map(([name, bytes]) => ({ name, bytes }))
  .sort((a, b) => b.bytes - a.bytes);

await mkdir("assets", { recursive: true });
await writeFile(outputPath, renderChart(entries, allRepos.length), "utf8");

console.log(`✓ ${outputPath}  ·  ${allRepos.length} repos  ·  ${entries.length} languages`);
for (const e of entries) {
  console.log(`  ${e.name}: ${formatBytes(e.bytes)} (${((e.bytes / entries.reduce((s, e) => s + e.bytes, 0)) * 100).toFixed(1)}%)`);
}
