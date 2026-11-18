// Tech Arsenal: detects languages, frameworks, databases and tooling from the
// repositories of a GitHub user and renders them as an SVG card.
//
// Sources are pluggable so the same detection logic runs against the GitHub
// REST API (production, in GitHub Actions) or a local folder of clones (tests).
import fs from 'node:fs';
import path from 'node:path';

const IGNORED_LANGUAGES = new Set([
  'HTML', 'CSS', 'SCSS', 'Less', 'ShaderLab', 'HLSL', 'GLSL', 'Batchfile', 'Makefile',
  'CMake', 'Dockerfile', 'PowerShell', 'Shell', 'Wolfram Language', 'Mathematica', 'Blade',
]);

const LANGUAGE_ALIASES = { PLpgSQL: 'SQL', TSQL: 'SQL', PLSQL: 'SQL' };

const LANGUAGE_COLORS = {
  Dart: '#00B4AB', JavaScript: '#F7DF1E', TypeScript: '#3178C6', 'C#': '#239120',
  'C++': '#00599C', C: '#A8B9CC', Python: '#3572A5', SQL: '#336791', Rust: '#DEA584',
  Go: '#00ADD8', Kotlin: '#A97BFF', Swift: '#F05138', Java: '#B07219', Lua: '#3D5AFE',
  PHP: '#777BB4', MATLAB: '#E16737',
};

const C = {
  react: '#61DAFB', node: '#6DA55F', docker: '#2496ED', mysql: '#00758F', pg: '#336791',
  light: '#E2E8F0', tailwind: '#38BDF8', vite: '#646CFF', ts: '#3178C6', steam: '#66C0F4',
  auth: '#F7768E', purple: '#BB9AF7', orange: '#FF6F00', yellow: '#FFCA28',
};

// dependency name -> [label, domain, color]
const NPM_MAP = {
  react: ['React', 'frontend', C.react],
  'react-native': ['React Native', 'frontend', C.react],
  expo: ['Expo', 'frontend', C.light],
  next: ['Next.js', 'frontend', C.light],
  vue: ['Vue', 'frontend', '#42B883'],
  svelte: ['Svelte', 'frontend', '#FF3E00'],
  '@angular/core': ['Angular', 'frontend', '#DD0031'],
  vite: ['Vite', 'frontend', C.vite],
  tailwindcss: ['Tailwind CSS', 'frontend', C.tailwind],
  zustand: ['Zustand', 'frontend', C.orange],
  redux: ['Redux', 'frontend', '#764ABC'],
  '@reduxjs/toolkit': ['Redux', 'frontend', '#764ABC'],
  'chart.js': ['Chart.js', 'frontend', '#FF6384'],
  electron: ['Electron', 'frontend', '#47848F'],
  express: ['Express', 'backend', C.light],
  fastify: ['Fastify', 'backend', C.light],
  koa: ['Koa', 'backend', C.light],
  '@nestjs/core': ['NestJS', 'backend', '#E0234E'],
  'socket.io': ['Socket.io', 'backend', C.light],
  'node-media-server': ['RTMP Streaming', 'backend', C.purple],
  'passport-steam': ['Steam OpenID', 'backend', C.steam],
  'steam-user': ['Steam API', 'backend', C.steam],
  'discord.js': ['Discord.js', 'backend', '#5865F2'],
  jsonwebtoken: ['JWT & Auth', 'backend', C.auth],
  bcrypt: ['JWT & Auth', 'backend', C.auth],
  bcryptjs: ['JWT & Auth', 'backend', C.auth],
  passport: ['JWT & Auth', 'backend', C.auth],
  mysql: ['MySQL', 'data', C.mysql],
  mysql2: ['MySQL', 'data', C.mysql],
  pg: ['PostgreSQL', 'data', C.pg],
  sqlite3: ['SQLite', 'data', '#0F80CC'],
  'better-sqlite3': ['SQLite', 'data', '#0F80CC'],
  mongoose: ['MongoDB', 'data', '#47A248'],
  mongodb: ['MongoDB', 'data', '#47A248'],
  redis: ['Redis', 'data', '#DC382D'],
  ioredis: ['Redis', 'data', '#DC382D'],
  firebase: ['Firebase', 'data', C.yellow],
  'firebase-admin': ['Firebase', 'data', C.yellow],
  prisma: ['Prisma ORM', 'data', '#5A67D8'],
  '@prisma/client': ['Prisma ORM', 'data', '#5A67D8'],
  sequelize: ['Sequelize', 'data', '#52B0E7'],
  typeorm: ['TypeORM', 'data', '#E83524'],
};

const NODE_SERVER_DEPS = new Set([
  'express', 'fastify', 'koa', '@nestjs/core', 'socket.io', 'node-media-server', 'hapi',
]);

const PYTHON_MAP = {
  flask: ['Flask', 'backend', C.light],
  django: ['Django', 'backend', '#44B78B'],
  fastapi: ['FastAPI', 'backend', '#009688'],
  numpy: ['NumPy', 'backend', '#4DABCF'],
  pandas: ['Pandas', 'backend', '#8B7BFF'],
  tensorflow: ['TensorFlow', 'backend', '#FF6F00'],
  torch: ['PyTorch', 'backend', '#EE4C2C'],
  'opencv-python': ['OpenCV', 'backend', '#5C3EE8'],
  sqlalchemy: ['SQLAlchemy', 'data', '#D71F00'],
  psycopg2: ['PostgreSQL', 'data', C.pg],
  'mysql-connector-python': ['MySQL', 'data', C.mysql],
  pymysql: ['MySQL', 'data', C.mysql],
};

const DOCKER_IMAGE_MAP = {
  mysql: ['MySQL', 'data', C.mysql],
  mariadb: ['MariaDB', 'data', '#C0765A'],
  postgres: ['PostgreSQL', 'data', C.pg],
  redis: ['Redis', 'data', '#DC382D'],
  mongo: ['MongoDB', 'data', '#47A248'],
  nginx: ['Nginx', 'data', '#009639'],
};

const DOCKER = ['Docker', 'data', C.docker];
const GH_ACTIONS = ['GitHub Actions', 'data', '#2088FF'];
const GIT = ['Git & GitHub', 'data', '#F05032'];
const NODE = ['Node.js', 'backend', C.node];
const APACHE = ['Apache', 'data', '#D22128'];

const SKIP_DIR_RE =
  /(^|\/)(node_modules|vendor|dist|build|out|\.git|\.next|\.venv|venv|__pycache__|Pods|Library|obj|bin)\//;
const MANIFEST_RE =
  /(^|\/)(package\.json|composer\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|pom\.xml|build\.gradle(\.kts)?|Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|pubspec\.yaml|[^/]+\.csproj)$/i;
const MAX_MANIFESTS_PER_REPO = 10;
const MAX_REPOS = 40;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pyHas(text, name) {
  const re = new RegExp(`(^|[\\s"'\\[,])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([<>=~!\\s;\\[\\]"',]|$)`, 'im');
  return re.test(text);
}

function detectFromManifest(file, text) {
  const hits = [];
  const base = file.split('/').pop();
  const lower = base.toLowerCase();

  if (lower === 'package.json') {
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      return hits;
    }
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    });
    for (const dep of deps) {
      if (NPM_MAP[dep]) hits.push(NPM_MAP[dep]);
    }
    if (deps.some((d) => NODE_SERVER_DEPS.has(d))) hits.push(NODE);
  } else if (lower === 'composer.json') {
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      return hits;
    }
    const req = Object.keys({ ...pkg.require, ...pkg['require-dev'] });
    if (req.includes('laravel/framework')) hits.push(['Laravel', 'backend', '#FF2D20']);
    if (req.some((r) => r.startsWith('symfony/'))) hits.push(['Symfony', 'backend', C.light]);
  } else if (/^requirements.*\.txt$/.test(lower) || lower === 'pyproject.toml' || lower === 'pipfile') {
    for (const [name, entry] of Object.entries(PYTHON_MAP)) {
      if (pyHas(text, name)) hits.push(entry);
    }
  } else if (/^docker-compose.*\.ya?ml$/.test(lower) || /^compose\.ya?ml$/.test(lower)) {
    hits.push(DOCKER);
    for (const m of text.matchAll(/^\s*image:\s*["']?([\w./-]+)/gim)) {
      const image = m[1].split('/').pop().toLowerCase();
      if (DOCKER_IMAGE_MAP[image]) hits.push(DOCKER_IMAGE_MAP[image]);
    }
  } else if (lower === 'dockerfile') {
    hits.push(DOCKER);
    for (const m of text.matchAll(/^\s*FROM\s+(?:--\S+\s+)?([\w./:-]+)/gim)) {
      const image = m[1].toLowerCase();
      if (image.includes('apache')) hits.push(APACHE);
      if (/(^|\/)nginx(:|$)/.test(image)) hits.push(DOCKER_IMAGE_MAP.nginx);
    }
  } else if (lower === 'pom.xml') {
    if (/spring-boot/.test(text)) hits.push(['Spring Boot', 'backend', '#6DB33F']);
    hits.push(['Maven', 'data', '#C71A36']);
  } else if (/^build\.gradle(\.kts)?$/.test(lower)) {
    if (/com\.android/.test(text)) hits.push(['Android SDK', 'frontend', '#3DDC84']);
    if (/org\.springframework\.boot/.test(text)) hits.push(['Spring Boot', 'backend', '#6DB33F']);
  } else if (lower === 'pubspec.yaml') {
    if (/^\s*flutter:/m.test(text)) hits.push(['Flutter', 'frontend', '#02569B']);
  } else if (lower.endsWith('.csproj')) {
    hits.push(['.NET', 'backend', '#512BD4']);
    if (/Microsoft\.AspNetCore/.test(text)) hits.push(['ASP.NET', 'backend', '#512BD4']);
  }
  return hits;
}

function detectFromPaths(paths) {
  const hits = [];
  if (paths.some((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) hits.push(GH_ACTIONS);
  if (paths.includes('ProjectSettings/ProjectVersion.txt')) hits.push(['Unity', 'backend', C.light]);
  if (paths.some((p) => /(^|\/)AndroidManifest\.xml$/.test(p) && !SKIP_DIR_RE.test(p))) {
    hits.push(['Android SDK', 'frontend', '#3DDC84']);
  }
  hits.push(GIT);
  return hits;
}

export async function collectTechProfile(source, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map((n) => n.toLowerCase()));
  const repos = (await source.listRepos())
    .filter((r) => !r.fork && !r.archived && !r.disabled && !excluded.has(r.name.toLowerCase()))
    .slice(0, MAX_REPOS);

  const domains = { frontend: new Map(), backend: new Map(), data: new Map() };
  const langBytes = new Map();
  const langRepos = new Map();

  const add = (domain, label, color, repoName) => {
    const map = domains[domain];
    if (!map.has(label)) map.set(label, { label, color, repos: new Set() });
    map.get(label).repos.add(repoName);
  };

  for (const repo of repos) {
    const langs = await source.languages(repo);
    for (const [raw, bytes] of Object.entries(langs || {})) {
      if (IGNORED_LANGUAGES.has(raw)) continue;
      const name = LANGUAGE_ALIASES[raw] || raw;
      langBytes.set(name, (langBytes.get(name) || 0) + bytes);
      if (!langRepos.has(name)) langRepos.set(name, new Set());
      langRepos.get(name).add(repo.name);
    }

    const tree = (await source.tree(repo)).filter((p) => !SKIP_DIR_RE.test(`/${p}`));
    for (const [label, domain, color] of detectFromPaths(tree)) add(domain, label, color, repo.name);

    const manifests = tree
      .filter((p) => MANIFEST_RE.test(p) && !SKIP_DIR_RE.test(`/${p}`))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .slice(0, MAX_MANIFESTS_PER_REPO);

    for (const file of manifests) {
      const text = await source.file(repo, file);
      if (!text) continue;
      for (const [label, domain, color] of detectFromManifest(file, text)) {
        add(domain, label, color, repo.name);
      }
    }
  }

  const rank = (a, b) => b.repos - a.repos || a.label.localeCompare(b.label);
  const toItems = (map) =>
    [...map.values()].map((v) => ({ label: v.label, color: v.color, repos: v.repos.size })).sort(rank);

  const languages = [...langBytes.entries()]
    .map(([name, bytes]) => ({
      label: name,
      color: LANGUAGE_COLORS[name] || '#7AA2F7',
      repos: langRepos.get(name).size,
      bytes,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    repoCount: repos.length,
    languages,
    frontend: toItems(domains.frontend),
    backend: toItems(domains.backend),
    data: toItems(domains.data),
  };
}

// ---------------------------------------------------------------- sources

export function githubRestSource({ username, token = '', includePrivate = false, fetchImpl = fetch }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${username}-Profile-Metrics`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function api(url, accept) {
    const res = await fetchImpl(url.startsWith('http') ? url : `https://api.github.com${url}`, {
      headers: accept ? { ...headers, Accept: accept } : headers,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub REST ${res.status} for ${url}`);
    return accept?.includes('raw') ? res.text() : res.json();
  }

  const owner = (repo) => repo.owner?.login || username;

  return {
    async listRepos() {
      const all = [];
      for (let page = 1; page <= 5; page++) {
        const url = includePrivate
          ? `/user/repos?affiliation=owner&sort=pushed&per_page=100&page=${page}`
          : `/users/${username}/repos?type=owner&sort=pushed&per_page=100&page=${page}`;
        const batch = await api(url);
        if (!batch?.length) break;
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all.filter((r) => r.owner?.login?.toLowerCase() === username.toLowerCase());
    },
    async languages(repo) {
      return (await api(`/repos/${owner(repo)}/${repo.name}/languages`)) || {};
    },
    async tree(repo) {
      const branch = repo.default_branch || 'HEAD';
      const data = await api(`/repos/${owner(repo)}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      return (data?.tree || []).filter((n) => n.type === 'blob').map((n) => n.path);
    },
    async file(repo, filePath) {
      const branch = repo.default_branch || 'HEAD';
      const encoded = filePath.split('/').map(encodeURIComponent).join('/');
      return api(
        `/repos/${owner(repo)}/${repo.name}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
        'application/vnd.github.raw+json'
      );
    },
  };
}

const EXT_LANG = {
  '.php': 'PHP', '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.cs': 'C#', '.cpp': 'C++', '.cc': 'C++',
  '.java': 'Java', '.sql': 'SQL', '.dart': 'Dart', '.lua': 'Lua', '.kt': 'Kotlin', '.rs': 'Rust', '.go': 'Go',
  '.c': 'C', '.html': 'HTML', '.css': 'CSS',
};

// Local folder of clones (one sub-folder per repo). Used for tests and seeding.
export function localDirSource(dir) {
  function walk(root, rel = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...walk(root, next));
      else out.push(next);
    }
    return out;
  }

  return {
    async listRepos() {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, fork: false, archived: false }));
    },
    async languages(repo) {
      const bytes = {};
      for (const f of walk(path.join(dir, repo.name))) {
        const lang = EXT_LANG[path.extname(f).toLowerCase()];
        if (lang) bytes[lang] = (bytes[lang] || 0) + fs.statSync(path.join(dir, repo.name, f)).size;
      }
      return bytes;
    },
    async tree(repo) {
      return walk(path.join(dir, repo.name));
    },
    async file(repo, filePath) {
      try {
        return fs.readFileSync(path.join(dir, repo.name, filePath), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------- render

export function renderTechArsenalSvg(profile, { username }) {
  const top = (items) => items.slice(0, 4);
  const domains = [
    {
      x: 20, y: 52, title: '⚡ Core Languages', accent: '#00E5FF',
      items: top(profile.languages),
    },
    {
      x: 458, y: 52, title: '📱 Frontend & Mobile', accent: '#7AA2F7',
      items: top(profile.frontend),
    },
    {
      x: 20, y: 162, title: '🖥️ Backend & APIs', accent: '#BB9AF7',
      items: top(profile.backend),
    },
    {
      x: 458, y: 162, title: '🗄️ Data, Cloud & Developer Workflow', accent: '#9ECE6A',
      items: top(profile.data),
    },
  ];

  const cardsSvg = domains
    .map((d) => {
      const pills = d.items.length
        ? d.items
            .map((it, idx) => {
              const col = idx % 2;
              const row = Math.floor(idx / 2);
              const px = d.x + 14 + col * 198;
              const py = d.y + 34 + row * 30;
              const name = it.label.length > 17 ? `${it.label.slice(0, 16)}…` : it.label;
              const detail = `${it.repos} ${it.repos === 1 ? 'repo' : 'repos'}`;
              return `
      <rect x="${px}" y="${py}" width="190" height="24" rx="5" fill="#0D1117" stroke="#21262D" stroke-width="1" />
      <circle cx="${px + 11}" cy="${py + 12}" r="4" fill="${escapeXml(it.color)}" />
      <text x="${px + 21}" y="${py + 15.5}" class="sans" font-size="11" font-weight="700" fill="#F0F6FC">${escapeXml(name)}</text>
      <text x="${px + 182}" y="${py + 15}" text-anchor="end" class="mono" font-size="9" fill="#8B949E">${detail}</text>`;
            })
            .join('')
        : `
      <text x="${d.x + 14}" y="${d.y + 56}" class="mono" font-size="10.5" fill="#565F89">No data detected yet</text>`;

      return `
    <rect x="${d.x}" y="${d.y}" width="422" height="100" rx="10" fill="#131621" stroke="#242938" stroke-width="1" />
    <text x="${d.x + 14}" y="${d.y + 22}" class="sans" font-size="13" font-weight="700" fill="${d.accent}">${escapeXml(d.title)}</text>
    ${pills}`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="276" viewBox="0 0 900 276" fill="none" role="img" aria-label="${escapeXml(username)} Tech Arsenal">
  <defs>
    <linearGradient id="techBg" x1="0" y1="0" x2="900" y2="276" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0D1117" />
      <stop offset="100%" stop-color="#11141E" />
    </linearGradient>
  </defs>

  <style>
    .sans { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .mono { font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace; }
  </style>

  <rect x="1" y="1" width="898" height="274" rx="14" fill="url(#techBg)" stroke="#242938" stroke-width="1.2" />

  <text x="22" y="32" class="sans" font-size="15.5" font-weight="700" fill="#58A6FF">🛠️ Tech Arsenal &amp; Engineering Domains</text>
  <text x="878" y="32" text-anchor="end" class="mono" font-size="10.5" fill="#8B949E">Auto-detected from ${profile.repoCount} repositories</text>

  ${cardsSvg}
</svg>
`;
}
