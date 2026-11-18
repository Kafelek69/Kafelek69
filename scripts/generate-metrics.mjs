// Telemetry & metrics generator for a GitHub profile (settings: ../profile.config.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTechProfile, githubRestSource, localDirSource, renderTechArsenalSvg } from './tech-arsenal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');

const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'profile.config.json'), 'utf8'));
const USERNAME = process.env.GITHUB_USERNAME || CONFIG.username;
const STEAM_ID = process.env.STEAM_ID || CONFIG.steamId;
// METRICS_TOKEN = optional classic PAT (adds private repos); GITHUB_TOKEN = default Actions token (public data)
const PAT = process.env.METRICS_TOKEN || '';
const TOKEN = PAT || process.env.GITHUB_TOKEN || '';
const TIMEZONE = CONFIG.timezone || 'UTC';
const IS_SEED = process.argv.includes('--seed');

// Forks that should be counted even without own commits
const INCLUDED_FORKS = new Set(CONFIG.includedForks || []);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

// Non-programming / noisy markup or legacy school languages excluded from language breakdown
const IGNORED_LANGUAGES = new Set([
  'HTML',
  'CSS',
  'SCSS',
  'Less',
  'ShaderLab',
  'HLSL',
  'GLSL',
  'Batchfile',
  'Makefile',
  'CMake',
  'Dockerfile',
  'PowerShell',
  'Shell',
  'Wolfram Language',
  'Mathematica',
  'MATLAB',
  'Blade',
]);

const LANGUAGE_ALIASES = {
  PLpgSQL: 'SQL',
  TSQL: 'SQL',
  PLSQL: 'SQL',
  'ASP.NET': 'C#',
};

const LANGUAGE_COLORS = {
  Dart: '#00B4AB',
  JavaScript: '#F7DF1E',
  TypeScript: '#3178C6',
  'C#': '#239120',
  'C++': '#00599C',
  C: '#A8B9CC',
  Python: '#3572A5',
  SQL: '#336791',
  Rust: '#DEA584',
  Go: '#00ADD8',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  Java: '#B07219',
  Lua: '#000080',
  PHP: '#777BB4',
};

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatCompact(num) {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}m`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
}

async function graphql(query, variables = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': `${USERNAME}-Profile-Metrics`,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!res.ok) {
        const text = await res.text();
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          console.warn(`GitHub GraphQL HTTP ${res.status}. Retrying (attempt ${attempt}/${retries})...`);
          await new Promise((r) => setTimeout(r, attempt * 2000));
          continue;
        }
        throw new Error(`GitHub GraphQL HTTP ${res.status}: ${text}`);
      }

      const json = await res.json();
      if (json.errors?.length) {
        throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
      }
      return json.data;
    } catch (err) {
      if (attempt < retries && !err.message.startsWith('GitHub GraphQL error:')) {
        console.warn(`Network/GraphQL error: ${err.message}. Retrying (attempt ${attempt}/${retries})...`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      throw err;
    }
  }
}

async function fetchSteamStats() {
  const defaults = {
    handle: STEAM_ID,
    level: null,
    badges: null,
    awards: null,
    showcaseItems: null,
  };

  try {
    const steamUrl = /^\d{17}$/.test(String(STEAM_ID))
      ? `https://steamcommunity.com/profiles/${STEAM_ID}`
      : `https://steamcommunity.com/id/${STEAM_ID}`;
    const res = await fetch(steamUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProfileMetrics/1.0)' },
    });
    if (!res.ok) return defaults;
    const html = await res.text();

    const levelMatch = html.match(/friendPlayerLevelNum[^>]*>(\d+)</);
    const badgesMatch = html.match(/Badges<\/span>[\s\S]{0,180}?profile_count_link_total[^>]*>\s*(\d+)/i);
    const awardsMatch = html.match(/Profile Awards<\/span>[\s\S]{0,180}?profile_count_link_total[^>]*>\s*(\d+)/i);
    const itemsMatch = html.match(/([\d,]+)\s*Items Owned/i);

    return {
      ...defaults,
      level: levelMatch ? Number.parseInt(levelMatch[1], 10) : defaults.level,
      badges: badgesMatch ? Number.parseInt(badgesMatch[1], 10) : defaults.badges,
      awards: awardsMatch ? Number.parseInt(awardsMatch[1], 10) : defaults.awards,
      showcaseItems: itemsMatch
        ? Number.parseInt(itemsMatch[1].replace(/,/g, ''), 10)
        : defaults.showcaseItems,
    };
  } catch {
    return defaults;
  }
}

function computeStreaks(days) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let longest = 0;
  let running = 0;

  for (const day of sorted) {
    if (day.contributionCount > 0) {
      running += 1;
      if (running > longest) longest = running;
    } else {
      running = 0;
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const upToToday = sorted.filter((d) => d.date <= todayStr);
  let current = 0;
  for (let i = upToToday.length - 1; i >= 0; i--) {
    const d = upToToday[i];
    if (d.contributionCount > 0) {
      current += 1;
    } else if (i === upToToday.length - 1) {
      continue;
    } else {
      break;
    }
  }

  return { currentStreak: current, longestStreak: longest };
}

async function fetchLiveMetrics() {
  const steam = await fetchSteamStats();

  const baseData = await graphql(
    `
      query BaseProfile($login: String!) {
        user(login: $login) {
          id
          login
          name
          createdAt
          followers {
            totalCount
          }
          issuesOpen: issues(states: OPEN) {
            totalCount
          }
          issuesClosed: issues(states: CLOSED) {
            totalCount
          }
          prsOpen: pullRequests(states: OPEN) {
            totalCount
          }
          prsMerged: pullRequests(states: MERGED) {
            totalCount
          }
          prsClosed: pullRequests(states: CLOSED) {
            totalCount
          }
          contributionsCollection {
            contributionCalendar {
              totalContributions
              weeks {
                contributionDays {
                  date
                  contributionCount
                  weekday
                }
              }
            }
          }
        }
      }
    `,
    { login: USERNAME }
  );

  const user = baseData.user;
  const startYear = new Date(user.createdAt).getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();
  const yearsJoined = Math.max(1, currentYear - startYear);

  const yearFields = [];
  for (let y = startYear; y <= currentYear; y++) {
    const from = `${y}-01-01T00:00:00Z`;
    const to = `${y}-12-31T23:59:59Z`;
    yearFields.push(`
      y${y}: contributionsCollection(from: "${from}", to: "${to}") {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
              weekday
            }
          }
        }
      }
    `);
  }

  const yearsData = await graphql(
    `
      query AllYears($login: String!) {
        user(login: $login) {
          ${yearFields.join('\n')}
        }
      }
    `,
    { login: USERNAME }
  );

  let totalAllTime = 0;
  const allDaysMap = new Map();
  for (let y = startYear; y <= currentYear; y++) {
    const cal = yearsData.user[`y${y}`]?.contributionCalendar;
    if (!cal) continue;
    totalAllTime += cal.totalContributions;
    for (const w of cal.weeks) {
      for (const d of w.contributionDays) {
        allDaysMap.set(d.date, d);
      }
    }
  }

  const allDays = [...allDaysMap.values()];
  const { currentStreak, longestStreak } = computeStreaks(allDays);

  const lastYearCal = user.contributionsCollection.contributionCalendar;
  const recentWeeks = lastYearCal.weeks.slice(-28);

  const commitsByDay = [0, 0, 0, 0, 0, 0, 0];
  for (const w of lastYearCal.weeks) {
    for (const d of w.contributionDays) {
      const wd = typeof d.weekday === 'number' ? d.weekday : new Date(d.date).getUTCDay();
      commitsByDay[wd] += d.contributionCount;
    }
  }

  const commitsByHour = new Array(24).fill(0);
  const langBytes = new Map();
  const langColors = new Map();
  let activeReposCount = 0;
  let totalDiskKb = 0;
  let totalReleases = 0;
  let totalStars = 0;
  let totalForks = 0;
  let linesAdded = 0;
  let linesDeleted = 0;
  let cursor = null;

  while (true) {
    const repoData = await graphql(
      `
        query UserRepos($cursor: String, $userId: ID!, $login: String!) {
          user(login: $login) {
            repositories(
              first: 50
              after: $cursor
              ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
              orderBy: { field: PUSHED_AT, direction: DESC }
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                name
                isFork
                diskUsage
                stargazerCount
                forkCount
                releases {
                  totalCount
                }
                defaultBranchRef {
                  target {
                    ... on Commit {
                      userCommits: history(first: 60, author: { id: $userId }) {
                        totalCount
                        nodes {
                          committedDate
                          additions
                          deletions
                        }
                      }
                    }
                  }
                }
                languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                  edges {
                    size
                    node {
                      name
                      color
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { cursor, userId: user.id, login: USERNAME }
    );

    const conn = repoData.user.repositories;
    for (const repo of conn.nodes) {
      const userCommitsObj = repo.defaultBranchRef?.target?.userCommits;
      const userCommitCount = userCommitsObj?.totalCount || 0;
      const includeRepo =
        !repo.isFork || INCLUDED_FORKS.has(repo.name) || userCommitCount > 0;

      if (!includeRepo) continue;

      activeReposCount += 1;
      totalDiskKb += repo.diskUsage || 0;
      totalReleases += repo.releases?.totalCount || 0;
      totalStars += repo.stargazerCount || 0;
      totalForks += repo.forkCount || 0;

      for (const c of userCommitsObj?.nodes || []) {
        linesAdded += c.additions || 0;
        linesDeleted += c.deletions || 0;
        if (c.committedDate) {
          const dt = new Date(c.committedDate);
          const plHour = Number.parseInt(
            new Intl.DateTimeFormat('en-US', {
              hour: '2-digit',
              hour12: false,
              timeZone: TIMEZONE,
            }).format(dt),
            10
          );
          if (!Number.isNaN(plHour)) {
            commitsByHour[plHour % 24] += 1;
          }
        }
      }

      for (const edge of repo.languages?.edges || []) {
        const rawName = edge.node.name;
        if (IGNORED_LANGUAGES.has(rawName)) continue;
        const name = LANGUAGE_ALIASES[rawName] || rawName;
        langBytes.set(name, (langBytes.get(name) || 0) + edge.size);
        if (!langColors.has(name)) {
          langColors.set(name, LANGUAGE_COLORS[name] || edge.node.color || '#7AA2F7');
        }
      }
    }

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  const totalBytes = [...langBytes.values()].reduce((acc, v) => acc + v, 0) || 1;
  const languages = [...langBytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, bytes]) => ({
      name,
      bytes,
      percent: (bytes / totalBytes) * 100,
      color: LANGUAGE_COLORS[name] || langColors.get(name) || '#7AA2F7',
    }));

  const issuesOpen = user.issuesOpen?.totalCount || 0;
  const issuesClosed = user.issuesClosed?.totalCount || 0;
  const prsOpen = user.prsOpen?.totalCount || 0;
  const prsMerged = user.prsMerged?.totalCount || 0;
  const prsClosed = user.prsClosed?.totalCount || 0;

  return {
    displayName: user.name || USERNAME,
    scopeLabel: PAT ? 'PRIVATE + PUBLIC' : 'PUBLIC',
    yearsJoined,
    followers: user.followers?.totalCount || 0,
    totalContributions: totalAllTime,
    lastYearContributions: lastYearCal.totalContributions,
    currentStreak,
    longestStreak,
    activeRepos: activeReposCount,
    totalReleases,
    diskMb: Math.round(totalDiskKb / 1024),
    linesAdded,
    linesDeleted,
    prsAndIssues: issuesOpen + issuesClosed + prsOpen + prsMerged + prsClosed,
    issuesOpen,
    issuesClosed,
    prsOpen,
    prsMerged,
    prsClosed,
    totalStars,
    totalForks,
    commitsByHour,
    commitsByDay,
    recentWeeks,
    languages,
    steam,
  };
}

async function getSeedMetrics() {
  // Neutral placeholder: all zeros. The scheduled workflow replaces it with live data.
  const steam = await fetchSteamStats();
  const weeks = Array.from({ length: 28 }, (_, w) => ({
    contributionDays: Array.from({ length: 7 }, (_, d) => ({
      date: `seed-${w}-${d}`,
      contributionCount: 0,
      weekday: d,
    })),
  }));

  return {
    displayName: USERNAME,
    scopeLabel: 'PUBLIC',
    yearsJoined: 0,
    followers: 0,
    totalContributions: 0,
    lastYearContributions: 0,
    currentStreak: 0,
    longestStreak: 0,
    activeRepos: 0,
    totalReleases: 0,
    diskMb: 0,
    linesAdded: 0,
    linesDeleted: 0,
    prsAndIssues: 0,
    issuesOpen: 0,
    issuesClosed: 0,
    prsOpen: 0,
    prsMerged: 0,
    prsClosed: 0,
    totalStars: 0,
    totalForks: 0,
    commitsByHour: new Array(24).fill(0),
    commitsByDay: new Array(7).fill(0),
    recentWeeks: weeks,
    languages: [{ name: 'No data yet', bytes: 0, percent: 100, color: '#30363D' }],
    steam,
  };
}

function getCubeColors(count) {
  if (count <= 0) {
    return { top: '#212636', left: '#191D2B', right: '#131722' };
  }
  if (count <= 2) {
    return { top: '#196127', left: '#12471D', right: '#0C3214' };
  }
  if (count <= 5) {
    return { top: '#239A3B', left: '#1B772E', right: '#135420' };
  }
  if (count <= 8) {
    return { top: '#39D353', left: '#2CA642', right: '#1F7C31' };
  }
  return { top: '#56F573', left: '#3EC458', right: '#2BA042' };
}

function renderIsometricCalendar(weeks, originX, originY) {
  const slice = weeks.slice(-28);
  const tw = 6.0;
  const th = 3.4;

  // Flatten all contribution days so we can sort them from back to front (Painter's algorithm)
  const items = [];
  for (let w = 0; w < slice.length; w++) {
    const days = slice[w].contributionDays || [];
    for (let d = 0; d < 7; d++) {
      items.push({
        w,
        d,
        count: days[d]?.contributionCount || 0,
      });
    }
  }

  // Back to front: depth is determined by (w + d)
  items.sort((a, b) => (a.w + a.d) - (b.w + b.d) || a.w - b.w);

  const cubes = [];

  for (const { w, d, count } of items) {
    const cx = originX + (w - d) * tw;
    const cy = originY + (w + d) * th;
    // Balanced height scaling: slim base tile when 0, capped at 16px so foreground pillars never swallow background rows
    const h = count === 0 ? 1.6 : Math.min(16, 4.0 + count * 1.2);
    const { top, left, right } = getCubeColors(count);

    const topPts = [
      `${cx.toFixed(1)},${(cy - th - h).toFixed(1)}`,
      `${(cx + tw).toFixed(1)},${(cy - h).toFixed(1)}`,
      `${cx.toFixed(1)},${(cy + th - h).toFixed(1)}`,
      `${(cx - tw).toFixed(1)},${(cy - h).toFixed(1)}`,
    ].join(' ');

    const leftPts = [
      `${(cx - tw).toFixed(1)},${(cy - h).toFixed(1)}`,
      `${cx.toFixed(1)},${(cy + th - h).toFixed(1)}`,
      `${cx.toFixed(1)},${(cy + th).toFixed(1)}`,
      `${(cx - tw).toFixed(1)},${cy.toFixed(1)}`,
    ].join(' ');

    const rightPts = [
      `${cx.toFixed(1)},${(cy + th - h).toFixed(1)}`,
      `${(cx + tw).toFixed(1)},${(cy - h).toFixed(1)}`,
      `${(cx + tw).toFixed(1)},${cy.toFixed(1)}`,
      `${cx.toFixed(1)},${(cy + th).toFixed(1)}`,
    ].join(' ');

    // 0.5px dark border to cleanly separate touching blocks and prevent solid green blobs
    cubes.push(
      `<polygon points="${leftPts}" fill="${left}" stroke="#0D1117" stroke-width="0.5" stroke-linejoin="round" /><polygon points="${rightPts}" fill="${right}" stroke="#0D1117" stroke-width="0.5" stroke-linejoin="round" /><polygon points="${topPts}" fill="${top}" stroke="#0D1117" stroke-width="0.5" stroke-linejoin="round" />`
    );
  }

  return cubes.join('\n    ');
}

function renderSegmentedBar(x, y, width, height, segments, clipId) {
  const total = segments.reduce((acc, s) => acc + s.value, 0) || 1;
  let offset = x;
  const rects = [];
  const nonZero = segments.filter((s) => s.value > 0);

  if (nonZero.length === 0) {
    rects.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#21262D" />`);
  } else {
    nonZero.forEach((seg, idx) => {
      const segW =
        idx === nonZero.length - 1
          ? Math.max(2, x + width - offset)
          : Math.max(4, (seg.value / total) * width);
      rects.push(
        `<rect x="${offset.toFixed(1)}" y="${y}" width="${segW.toFixed(1)}" height="${height}" fill="${seg.color}" />`
      );
      offset += segW;
    });
  }

  return `
  <clipPath id="${clipId}">
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" />
  </clipPath>
  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="#161B22" />
  <g clip-path="url(#${clipId})">
    ${rects.join('\n    ')}
  </g>`;
}

function renderInfographicSvg(m) {
  // 14 mini blocks in top-left header
  const miniBlocks = Array.from({ length: 14 }, (_, i) => {
    const fills = ['#39D353', '#26A641', '#39D353', '#006D32', '#26A641', '#39D353', '#0E4429'];
    const fill = i < 11 ? fills[i % fills.length] : '#212636';
    return `<rect x="${298 + i * 10}" y="22" width="7.5" height="7.5" rx="1.8" fill="${fill}" />`;
  }).join('');

  // Plugin: habits -> Hourly bar chart (00..23)
  const maxHour = Math.max(1, ...m.commitsByHour);
  const hourBaseY = 322;
  const hourMaxH = 58;
  const hourBars = m.commitsByHour
    .map((val, hr) => {
      const bx = 26 + hr * 17.2;
      const ratio = val / maxHour;
      const bh = val === 0 ? 2 : Math.max(4, ratio * hourMaxH);
      const by = hourBaseY - bh;
      const fill =
        ratio > 0.75
          ? '#39D353'
          : ratio > 0.4
            ? '#26A641'
            : ratio > 0.15
              ? '#006D32'
              : val > 0
                ? '#0E4429'
                : '#1F2335';
      const countText =
        val > 0
          ? `<text x="${(bx + 4.2).toFixed(1)}" y="${(by - 4).toFixed(1)}" text-anchor="middle" class="mono" font-size="7.5" fill="#7D8590">${val}</text>`
          : '';
      const hrLabel = String(hr).padStart(2, '0');
      return `
      <rect x="${bx.toFixed(1)}" y="${(hourBaseY - hourMaxH).toFixed(1)}" width="8.4" height="${hourMaxH}" rx="2.5" fill="#131622" />
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="8.4" height="${bh.toFixed(1)}" rx="2.5" fill="${fill}" />
      ${countText}
      <text x="${(bx + 4.2).toFixed(1)}" y="${hourBaseY + 13}" text-anchor="middle" class="mono" font-size="8" fill="#565F89">${hrLabel}</text>`;
    })
    .join('');

  // Plugin: habits -> Day-of-week bar chart (Sun..Sat)
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const maxDay = Math.max(1, ...m.commitsByDay);
  const dayBaseY = 448;
  const dayMaxH = 50;
  const dayBars = m.commitsByDay
    .map((val, d) => {
      const bx = 28 + d * 27;
      const ratio = val / maxDay;
      const bh = val === 0 ? 2 : Math.max(5, ratio * dayMaxH);
      const by = dayBaseY - bh;
      const fill = ratio > 0.75 ? '#39D353' : ratio > 0.45 ? '#26A641' : '#006D32';
      return `
      <rect x="${bx}" y="${dayBaseY - dayMaxH}" width="11" height="${dayMaxH}" rx="3" fill="#131622" />
      <rect x="${bx}" y="${by.toFixed(1)}" width="11" height="${bh.toFixed(1)}" rx="3" fill="${fill}" />
      <text x="${bx + 5.5}" y="${(by - 4).toFixed(1)}" text-anchor="middle" class="mono" font-size="8" fill="#7D8590">${val}</text>
      <text x="${bx + 5.5}" y="${dayBaseY + 13}" text-anchor="middle" class="sans" font-size="8.5" fill="#565F89">${dayNames[d]}</text>`;
    })
    .join('');

  // Plugin: habits -> Language activity mini-bars (bottom-left beside day chart)
  const top3Langs = m.languages.slice(0, 3);
  const langMiniBars = top3Langs
    .map((l, idx) => {
      const ly = 398 + idx * 23;
      const barW = 124;
      const fillW = Math.max(4, (l.percent / 100) * barW);
      return `
      <text x="234" y="${ly}" class="sans" font-size="10.5" fill="#A9B1D6">${escapeXml(l.name)}</text>
      <rect x="298" y="${ly - 8}" width="${barW}" height="6.5" rx="3" fill="#131622" />
      <rect x="298" y="${ly - 8}" width="${fillW.toFixed(1)}" height="6.5" rx="3" fill="${escapeXml(l.color)}" />
      <text x="436" y="${ly}" text-anchor="end" class="mono" font-size="9.5" fill="#7D8590">${Math.round(l.percent)}%</text>`;
    })
    .join('');

  // Plugin: isocalendar -> 3D Isometric calendar
  const isoCubes = renderIsometricCalendar(m.recentWeeks, 524, 90);

  // Plugin: languages -> Full language stacked bar on right column
  const rBarX = 476;
  const rBarY = 286;
  const rBarW = 398;
  const rBarH = 10;
  const langBarSvg = renderSegmentedBar(
    rBarX,
    rBarY,
    rBarW,
    rBarH,
    m.languages.map((l) => ({ value: l.percent, color: l.color })),
    'rLangClip'
  );

  const rLangItems = m.languages
    .slice(0, 6)
    .map((l, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const lx = col === 0 ? 476 : 680;
      const ly = 320 + row * 36;
      const trackW = 192;
      const fillW = Math.max(4, (l.percent / 100) * trackW);
      const sizeStr = l.bytes ? `${formatBytes(l.bytes)} · ` : '';
      return `
    <g transform="translate(${lx}, ${ly})">
      <circle cx="5" cy="-4" r="4.5" fill="${escapeXml(l.color)}" />
      <text x="15" y="0" class="sans" font-size="12" font-weight="600" fill="#E2E8F0">${escapeXml(l.name)}</text>
      <text x="${trackW}" y="0" text-anchor="end" class="mono" font-size="10.5" font-weight="600" fill="#A9B1D6">${sizeStr}${l.percent.toFixed(1)}%</text>
      <rect x="0" y="7" width="${trackW}" height="4.5" rx="2.2" fill="#131622" />
      <rect x="0" y="7" width="${fillW.toFixed(1)}" height="4.5" rx="2.2" fill="${escapeXml(l.color)}" />
    </g>`;
    })
    .join('');

  // Plugin: followup -> Issues & Pull Requests bars
  const issuesBarSvg = renderSegmentedBar(
    476,
    514,
    398,
    10,
    [
      { value: m.issuesOpen, color: '#238636' },
      { value: m.issuesClosed, color: '#8957E5' },
    ],
    'issuesClip'
  );

  const prsBarSvg = renderSegmentedBar(
    476,
    592,
    398,
    10,
    [
      { value: m.prsOpen, color: '#238636' },
      { value: m.prsMerged, color: '#8957E5' },
      { value: m.prsClosed, color: '#DA3633' },
    ],
    'prsClip'
  );

  const avgPerDay = (m.lastYearContributions / 365).toFixed(2);
  const st = m.steam;
  const sv = (v) => (v === null || v === undefined ? '–' : v);
  const steamGamesSvg = (CONFIG.steamShowcase || [])
    .slice(0, 3)
    .map((g, i) => {
      const y = 532 + i * 44;
      const col = /^#[0-9A-Fa-f]{6}$/.test(g.color || '') ? g.color : '#66C0F4';
      const abbr = escapeXml(g.abbr || String(g.name || '?').slice(0, 2).toUpperCase());
      return `
  <rect x="26" y="${y}" width="412" height="38" rx="7" fill="#131824" stroke="#232C3D" stroke-width="1" />
  <rect x="34" y="${y + 8}" width="22" height="22" rx="5" fill="${col}" fill-opacity="0.18" stroke="${col}" stroke-width="1" />
  <text x="45" y="${y + 23}" text-anchor="middle" class="mono" font-size="${abbr.length > 2 ? 9.5 : 10}" font-weight="700" fill="${col}">${abbr}</text>
  <text x="66" y="${y + 16}" class="sans" font-size="12" font-weight="700" fill="#F0F6FC">${escapeXml(g.name || '')}</text>
  <text x="66" y="${y + 30}" class="sans" font-size="10" fill="#8B949E">${escapeXml(g.note || '')}</text>
  <text x="428" y="${y + 16}" text-anchor="end" class="mono" font-size="10" font-weight="600" fill="${col}">${escapeXml(g.tag || '')}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="692" viewBox="0 0 900 692" fill="none" role="img" aria-label="${escapeXml(USERNAME)} GitHub Metrics Infographic">
  <defs>
    <linearGradient id="infoBg" x1="0" y1="0" x2="900" y2="692" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0D1117" />
      <stop offset="50%" stop-color="#131621" />
      <stop offset="100%" stop-color="#0D1117" />
    </linearGradient>
  </defs>

  <style>
    .sans { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .mono { font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace; }
  </style>

  <!-- Main Card Frame -->
  <rect x="1" y="1" width="898" height="690" rx="14" fill="url(#infoBg)" stroke="#242938" stroke-width="1.2" />

  <!-- ================= LEFT COLUMN ================= -->
  <!-- Base Header -->
  <circle cx="34" cy="26" r="6" fill="#58A6FF" />
  <text x="48" y="31" class="sans" font-size="16" font-weight="700" fill="#58A6FF">${escapeXml(m.displayName)} <tspan fill="#8B949E" font-weight="400" font-size="13">(@${escapeXml(USERNAME)})</tspan></text>
  ${miniBlocks}

  <!-- Account Overview Left Sub-column -->
  <g class="sans" font-size="12" fill="#C9D1D9">
    <text x="26" y="58">🕒 <tspan dx="4">Joined GitHub ${m.yearsJoined} years ago</tspan></text>
    <text x="26" y="80">👥 <tspan dx="4">Followed by ${m.followers} users</tspan></text>
    <text x="26" y="104" fill="#58A6FF" font-weight="600">📦 <tspan dx="4">${m.activeRepos} Repositories (${m.scopeLabel === 'PUBLIC' ? 'Public' : 'Public &amp; Private'})</tspan></text>
    <text x="26" y="126">🏷️ <tspan dx="4">${m.totalReleases} Releases · ${m.diskMb} MB Storage</tspan></text>
    <text x="26" y="148">± <tspan dx="6" fill="#3FB950" font-weight="600">+${formatCompact(m.linesAdded)} added</tspan>, <tspan fill="#F85149" font-weight="600">-${formatCompact(m.linesDeleted)} removed</tspan></text>
  </g>

  <!-- Account Overview Right Sub-column -->
  <g class="sans" font-size="12" fill="#C9D1D9">
    <text x="248" y="58">⚡ <tspan dx="4">${m.totalContributions} Total Contributions</tspan></text>
    <text x="248" y="80">📈 <tspan dx="4">${m.lastYearContributions} in Last 12 Months</tspan></text>
    <text x="248" y="104">🔀 <tspan dx="4">${m.prsAndIssues} Issues &amp; Pull Requests</tspan></text>
    <text x="248" y="126">⭐ <tspan dx="4">${m.totalStars} Stargazers · 🍴 ${m.totalForks} Forks</tspan></text>
    <text x="248" y="148">🌍 <tspan dx="4">${escapeXml(CONFIG.location || TIMEZONE)}</tspan></text>
  </g>

  <line x1="24" y1="168" x2="438" y2="168" stroke="#21262D" stroke-width="1" />

  <!-- PLUGIN: Coding habits and recent activity (habits) -->
  <text x="26" y="192" class="sans" font-size="14" font-weight="700" fill="#58A6FF">💡 Coding habits and recent activity</text>
  <text x="230" y="218" text-anchor="middle" class="sans" font-size="11.5" font-weight="600" fill="#58A6FF">Commit activity per time of the day</text>

  ${hourBars}

  <text x="115" y="366" text-anchor="middle" class="sans" font-size="11.5" font-weight="600" fill="#58A6FF">Commit activity per day</text>
  <text x="334" y="366" text-anchor="middle" class="sans" font-size="11.5" font-weight="600" fill="#58A6FF">Language activity</text>

  ${dayBars}
  ${langMiniBars}

  <line x1="24" y1="474" x2="438" y2="474" stroke="#21262D" stroke-width="1" />

  <!-- PLUGIN: Steam (steam) -->
  <text x="26" y="498" class="sans" font-size="14" font-weight="700" fill="#58A6FF">🕹️ Steam — ${escapeXml(st.handle)}</text>
  <rect x="350" y="482" width="88" height="22" rx="11" fill="#1B2838" stroke="#66C0F4" stroke-width="1" />
  <text x="394" y="497" text-anchor="middle" class="mono" font-size="10.5" font-weight="700" fill="#66C0F4">LEVEL ${sv(st.level)}</text>

  <text x="26" y="520" class="sans" font-size="11" fill="#8B949E">
    🏆 <tspan fill="#C9D1D9" font-weight="600">${sv(st.badges)}</tspan> Badges   ·   🎖️ <tspan fill="#C9D1D9" font-weight="600">${sv(st.awards)}</tspan> Awards   ·   🎒 <tspan fill="#66C0F4" font-weight="600">${sv(st.showcaseItems)}</tspan> Items Owned
  </text>

  <!-- Steam showcase (from profile.config.json) -->
  ${steamGamesSvg}

  <!-- Vertical Center Divider -->
  <line x1="454" y1="20" x2="454" y2="672" stroke="#21262D" stroke-width="1" />

  <!-- ================= RIGHT COLUMN ================= -->
  <!-- PLUGIN: Isometric commit calendar (isocalendar) -->
  <text x="476" y="31" class="sans" font-size="14" font-weight="700" fill="#58A6FF">📅 Contributions calendar</text>

  <g class="sans" font-size="12" fill="#C9D1D9">
    <text x="698" y="60">🔥 <tspan dx="4">Current streak: <tspan font-weight="700" fill="#39D353">${m.currentStreak} day${m.currentStreak === 1 ? '' : 's'}</tspan></tspan></text>
    <text x="698" y="82">🏆 <tspan dx="4">Best streak: <tspan font-weight="700" fill="#58A6FF">${m.longestStreak} days</tspan></tspan></text>
    <text x="698" y="104">📈 <tspan dx="4">~${avgPerDay} commits / day</tspan></text>
  </g>

  <g>
    ${isoCubes}
  </g>

  <g transform="translate(478, 224)">
    <text x="0" y="9" class="mono" font-size="9.5" fill="#8B949E">Less</text>
    <rect x="28" y="0" width="9" height="9" rx="2" fill="#212636" />
    <rect x="40" y="0" width="9" height="9" rx="2" fill="#0E4429" />
    <rect x="52" y="0" width="9" height="9" rx="2" fill="#006D32" />
    <rect x="64" y="0" width="9" height="9" rx="2" fill="#26A641" />
    <rect x="76" y="0" width="9" height="9" rx="2" fill="#39D353" />
    <text x="90" y="9" class="mono" font-size="9.5" fill="#8B949E">More</text>
    <text x="394" y="9" text-anchor="end" class="mono" font-size="9.5" fill="#8B949E">3D Isometric Calendar (isocalendar)</text>
  </g>

  <line x1="476" y1="248" x2="874" y2="248" stroke="#21262D" stroke-width="1" />

  <!-- PLUGIN: Languages activity (languages) -->
  <text x="476" y="272" class="sans" font-size="14" font-weight="700" fill="#58A6FF">🈷️ Languages activity</text>
  <rect x="726" y="257" width="148" height="20" rx="5" fill="#161B22" stroke="#30363D" stroke-width="1" />
  <text x="800" y="271" text-anchor="middle" class="mono" font-size="9.5" font-weight="600" fill="#7EE787">${escapeXml(m.scopeLabel)}</text>

  ${langBarSvg}
  ${rLangItems}

  <line x1="476" y1="442" x2="874" y2="442" stroke="#21262D" stroke-width="1" />

  <!-- PLUGIN: Follow-up of issues and pull requests (followup) -->
  <text x="476" y="466" class="sans" font-size="14" font-weight="700" fill="#58A6FF">🎟️ Follow-up of issues and pull requests</text>

  <!-- Issues Follow-up -->
  <text x="476" y="498" class="sans" font-size="12" font-weight="600" fill="#C9D1D9">Issues <tspan fill="#8B949E" font-weight="400" font-size="11">(${m.issuesOpen + m.issuesClosed} total)</tspan></text>
  <text x="874" y="498" text-anchor="end" class="mono" font-size="10.5" fill="#8B949E">${Math.round((m.issuesClosed / Math.max(1, m.issuesOpen + m.issuesClosed)) * 100)}% resolved</text>
  ${issuesBarSvg}
  <g transform="translate(476, 540)" class="sans" font-size="11" fill="#8B949E">
    <circle cx="5" cy="-4" r="4" fill="#238636" />
    <text x="14" y="0"><tspan fill="#C9D1D9" font-weight="600">${m.issuesOpen}</tspan> Open</text>
    <circle cx="95" cy="-4" r="4" fill="#8957E5" />
    <text x="104" y="0"><tspan fill="#C9D1D9" font-weight="600">${m.issuesClosed}</tspan> Closed / Completed</text>
    <circle cx="245" cy="-4" r="4" fill="#30363D" />
    <text x="254" y="0"><tspan fill="#C9D1D9" font-weight="600">0</tspan> Skipped</text>
  </g>

  <!-- Pull Requests Follow-up -->
  <text x="476" y="576" class="sans" font-size="12" font-weight="600" fill="#C9D1D9">Pull requests <tspan fill="#8B949E" font-weight="400" font-size="11">(${m.prsOpen + m.prsMerged + m.prsClosed} total)</tspan></text>
  <text x="874" y="576" text-anchor="end" class="mono" font-size="10.5" fill="#8B949E">${Math.round((m.prsMerged / Math.max(1, m.prsOpen + m.prsMerged + m.prsClosed)) * 100)}% merged</text>
  ${prsBarSvg}
  <g transform="translate(476, 618)" class="sans" font-size="11" fill="#8B949E">
    <circle cx="5" cy="-4" r="4" fill="#238636" />
    <text x="14" y="0"><tspan fill="#C9D1D9" font-weight="600">${m.prsOpen}</tspan> Open</text>
    <circle cx="95" cy="-4" r="4" fill="#8957E5" />
    <text x="104" y="0"><tspan fill="#C9D1D9" font-weight="600">${m.prsMerged}</tspan> Merged</text>
    <circle cx="195" cy="-4" r="4" fill="#DA3633" />
    <text x="204" y="0"><tspan fill="#C9D1D9" font-weight="600">${m.prsClosed}</tspan> Closed</text>
    <circle cx="285" cy="-4" r="4" fill="#30363D" />
    <text x="294" y="0"><tspan fill="#C9D1D9" font-weight="600">0</tspan> Drafts</text>
  </g>

  <!-- Bottom Timestamp / Sync Note -->
  <text x="476" y="670" class="mono" font-size="9.5" fill="#565F89">⚡ Layout inspired by lowlighter/metrics · Synced via GitHub GraphQL &amp; Steam</text>
</svg>
`;
}

async function generateTechArsenal() {
  try {
    const dir = argValue('--tech-from-dir');
    const source = dir
      ? localDirSource(dir)
      : githubRestSource({ username: USERNAME, token: TOKEN, includePrivate: Boolean(PAT) });
    const profile = await collectTechProfile(source, {
      exclude: [USERNAME, ...(CONFIG.excludeRepos || [])],
    });
    fs.writeFileSync(
      path.join(ASSETS_DIR, 'tech-arsenal.svg'),
      renderTechArsenalSvg(profile, { username: USERNAME }),
      'utf8'
    );
    console.log(`Tech arsenal generated from ${profile.repoCount} repositories.`);
  } catch (err) {
    // Keep the previous SVG if the API is unreachable or rate limited.
    console.warn(`Tech arsenal not updated: ${err.message}`);
  }
}

async function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  await generateTechArsenal();
  if (process.argv.includes('--tech-only')) return;

  if (!IS_SEED && !TOKEN) {
    console.log('No GITHUB_TOKEN / METRICS_TOKEN available - keeping existing metrics.svg untouched.');
    return;
  }

  const metrics = IS_SEED ? await getSeedMetrics() : await fetchLiveMetrics();
  fs.writeFileSync(path.join(ASSETS_DIR, 'metrics.svg'), renderInfographicSvg(metrics), 'utf8');
  console.log('Successfully generated assets/metrics.svg');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
