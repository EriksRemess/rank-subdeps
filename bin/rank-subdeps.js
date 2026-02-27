#!/usr/bin/env node
// ESM CLI: rank-subdeps
// Ranks top-level deps by unique transitive subdependencies and approximate aggregate file size.
//
// Usage:
//   rank-subdeps
//   rank-subdeps --json
//   rank-subdeps --top 20
//   rank-subdeps --omit=dev
//   rank-subdeps --omit=dev,optional --include=optional
//
// Notes:
// - Counts unique subdeps by (name@version) excluding the package itself.
// - Supports npm-style omit/include filtering for dependency types.
// - Requires an installed tree (node_modules). Run `npm i` first.

import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function readJSON(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadPkgJson(root) {
  const pkg = readJSON(join(root, 'package.json'));
  if (!pkg) {
    console.error('No package.json found in current directory.');
    process.exit(1);
  }
  return pkg;
}

function runNpmLs(root, args, execRunner = execFileSync) {
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // `--long` is required to include `path` in npm's JSON output, which we
  // use for approximate on-disk size calculations.
  const npmArgs = ['ls', '--all', '--json', '--long'];
  const omitted = Array.from(args.omit).sort();
  const included = Array.from(args.include).sort();
  for (const t of omitted) npmArgs.push(`--omit=${t}`);
  for (const t of included) npmArgs.push(`--include=${t}`);
  const captureDir = mkdtempSync(join(tmpdir(), 'rank-subdeps-'));
  const stdoutPath = join(captureDir, 'npm-ls.json');
  let stdoutFd = null;
  try {
    stdoutFd = openSync(stdoutPath, 'w');
    execRunner(bin, npmArgs, {
      cwd: root,
      stdio: ['ignore', stdoutFd, 'pipe'],
    });
    closeSync(stdoutFd);
    stdoutFd = null;
    const out = readFileSync(stdoutPath, 'utf8');
    return JSON.parse(out.toString('utf8'));
  } catch (err) {
    if (stdoutFd !== null) {
      try {
        closeSync(stdoutFd);
      } catch {}
      stdoutFd = null;
    }
    let stdout = '';
    try {
      stdout = readFileSync(stdoutPath, 'utf8');
    } catch {}
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {}
    }
    console.error('Failed to run "npm ls --all --json".');
    if (err?.stderr) console.error(String(err.stderr));
    process.exit(1);
  } finally {
    if (stdoutFd !== null) {
      try {
        closeSync(stdoutFd);
      } catch {}
    }
    rmSync(captureDir, { recursive: true, force: true });
  }
}

function runNpmOutdated(root, args, execRunner = execFileSync) {
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmArgs = ['outdated', '--all', '--json'];
  const omitted = Array.from(args.omit).sort();
  const included = Array.from(args.include).sort();
  for (const t of omitted) npmArgs.push(`--omit=${t}`);
  for (const t of included) npmArgs.push(`--include=${t}`);

  try {
    const out = execRunner(bin, npmArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = String(out || '').trim();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    const stdout = String(err?.stdout || '').trim();
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {}
    }

    // `npm outdated` may fail for registry/auth/network reasons; keep the main
    // report usable and mark outdated counts as unavailable.
    return null;
  }
}

function parseLastUpdatedValue(packageName, raw) {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return null;

  const latestVersion =
    typeof raw['dist-tags.latest'] === 'string'
      ? raw['dist-tags.latest']
      : typeof raw['dist-tags']?.latest === 'string'
        ? raw['dist-tags'].latest
        : null;
  if (latestVersion && raw.time && typeof raw.time === 'object' && typeof raw.time[latestVersion] === 'string') {
    return raw.time[latestVersion];
  }

  if (typeof raw[packageName] === 'string') return raw[packageName];
  if (typeof raw.modified === 'string') return raw.modified;
  if (raw.time && typeof raw.time.modified === 'string') return raw.time.modified;
  if (
    raw[packageName] &&
    typeof raw[packageName] === 'object' &&
    typeof raw[packageName].modified === 'string'
  ) {
    return raw[packageName].modified;
  }
  return null;
}

function runNpmViewLastUpdated(root, packageName, execRunner = execFileSync) {
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmArgs = ['view', packageName, 'dist-tags.latest', 'time', '--json'];

  const parseOutput = text => {
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return parseLastUpdatedValue(packageName, parsed);
    } catch {
      return null;
    }
  };

  try {
    const out = execRunner(bin, npmArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseOutput(String(out || '').trim());
  } catch (err) {
    return parseOutput(String(err?.stdout || '').trim());
  }
}

function collectLastUpdatedByPackage(root, packageNames, execRunner = execFileSync) {
  const byPackage = new Map();
  for (const packageName of packageNames) {
    byPackage.set(packageName, runNpmViewLastUpdated(root, packageName, execRunner));
  }
  return byPackage;
}

const makeId = (name, version) => `${name}@${version || 'UNKNOWN'}`;

function getApproxPathSize(path, pathSizeCache) {
  if (!path) return 0;
  const cached = pathSizeCache.get(path);
  if (cached !== undefined) return cached;

  let total = 0;
  const stack = [path];

  while (stack.length) {
    const curPath = stack.pop();
    let stat;
    try {
      stat = lstatSync(curPath);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      total += stat.size;
      continue;
    }
    if (!stat.isDirectory()) continue;

    let entries;
    try {
      entries = readdirSync(curPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(curPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        try {
          total += statSync(entryPath).size;
        } catch {}
      } else if (!entry.isSymbolicLink()) {
        try {
          const entryStat = statSync(entryPath);
          if (entryStat.isFile()) total += entryStat.size;
        } catch {}
      }
    }
  }

  pathSizeCache.set(path, total);
  return total;
}

function collectSubtreeStats(name, node, pathSizeCache, outdatedMarkers = null) {
  // Collect unique (name@version) for this dependency subtree.
  // `subdeps` excludes the top-level dependency itself.
  if (!node) return { subdeps: 0, outdatedSubdeps: 0, approxBytes: 0 };

  const seen = new Set();
  let outdatedSubdeps = 0;
  let approxBytes = 0;
  const stack = [[name, node, 0]];

  while (stack.length) {
    const [curName, cur, depth] = stack.pop();
    const id = makeId(curName, cur?.version);
    if (seen.has(id)) continue;
    seen.add(id);
    approxBytes += getApproxPathSize(cur?.path, pathSizeCache);
    if (depth > 0 && isOutdatedNode(curName, cur, outdatedMarkers)) outdatedSubdeps++;

    if (cur && cur.dependencies) {
      for (const [n2, c2] of Object.entries(cur.dependencies)) {
        stack.push([n2, c2, depth + 1]);
      }
    }
  }

  return { subdeps: Math.max(0, seen.size - 1), outdatedSubdeps, approxBytes };
}

function collectOutdatedMarkers(root, outdatedJson) {
  const paths = new Set();
  const ids = new Set();
  if (!outdatedJson || typeof outdatedJson !== 'object') return { paths, ids };

  const visit = (value, keyHint = null) => {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, null);
      return;
    }

    const isEntry =
      typeof value.current === 'string' &&
      (typeof value.latest === 'string' || typeof value.wanted === 'string' || value.latest === null);

    if (isEntry) {
      const name = typeof value.name === 'string' ? value.name : keyHint;
      if (name) ids.add(makeId(name, value.current));
      if (typeof value.location === 'string' && value.location) {
        paths.add(resolve(root, value.location));
      }
    }

    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') visit(v, k);
    }
  };

  visit(outdatedJson);
  return { paths, ids };
}

function isOutdatedNode(name, node, outdatedMarkers) {
  if (!outdatedMarkers) return false;
  if (node?.path && outdatedMarkers.paths.has(resolve(node.path))) return true;
  return outdatedMarkers.ids.has(makeId(name, node?.version));
}

function collectAggregateApproxBytes(tree, topDepNames, pathSizeCache) {
  const seen = new Set();
  let total = 0;
  const stack = [];

  for (const name of topDepNames) {
    const node = tree.dependencies?.[name];
    if (node) stack.push([name, node]);
  }

  while (stack.length) {
    const [name, cur] = stack.pop();
    const id = makeId(name, cur?.version);
    if (seen.has(id)) continue;
    seen.add(id);
    total += getApproxPathSize(cur?.path, pathSizeCache);

    if (cur && cur.dependencies) {
      for (const [n2, c2] of Object.entries(cur.dependencies)) {
        stack.push([n2, c2]);
      }
    }
  }

  return total;
}

function formatApproxBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '~0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIdx = 0;

  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }

  const text = value >= 10 || unitIdx === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `~${text} ${units[unitIdx]}`;
}

function formatLastUpdated(value) {
  if (typeof value !== 'string' || !value) return '?';
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return value;
  return date.toISOString().slice(0, 10);
}

function getPublishTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function getEffectiveSortDirection(sortMode, direction) {
  if (direction === 'asc' || direction === 'desc') return direction;
  if (sortMode === 'name') return 'asc';
  return 'desc';
}

const pad = (str, len) => {
  str = String(str);
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
};

function parseArgs(argv) {
  const args = {
    json: false,
    top: 10,
    sort: 'subdeps',
    direction: null,
    // npm-like default: omit dev when NODE_ENV=production
    omit: new Set(process.env.NODE_ENV === 'production' ? ['dev'] : []),
    include: new Set(),
  };
  const allowedTypes = new Set(['dev', 'optional', 'peer']);
  const allowedSorts = new Set(['subdeps', 'size', 'name', 'publish']);
  const allowedDirections = new Set(['asc', 'desc']);
  const addTypes = (raw, flag) => {
    if (!raw || raw.startsWith('-')) {
      console.error(`Missing value for ${flag}. Supported values: dev, optional, peer`);
      printHelpAndExit(1);
    }
    const values = raw.split(',').map(x => x.trim()).filter(Boolean);
    if (values.length === 0) {
      console.error(`Missing value for ${flag}. Supported values: dev, optional, peer`);
      printHelpAndExit(1);
    }
    const unsupported = values.filter(x => !allowedTypes.has(x));
    if (unsupported.length > 0) {
      console.error(`Unsupported ${flag} value(s): ${unsupported.join(', ')}`);
      printHelpAndExit(1);
    }
    return values;
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.json = true;
    } else if (a === '--sort' || a.startsWith('--sort=')) {
      const raw = a === '--sort' ? argv[i + 1] : a.slice('--sort='.length);
      if (!raw || raw.startsWith('-')) {
        console.error(
          'Missing value for --sort. Supported values: subdeps, size, name, publish'
        );
        printHelpAndExit(1);
      }
      if (raw === 'publish-asc' || raw === 'publish-desc') {
        args.sort = 'publish';
        if (!args.direction) args.direction = raw.endsWith('-asc') ? 'asc' : 'desc';
      } else if (!allowedSorts.has(raw)) {
        console.error(`Unsupported --sort value: ${raw}`);
        printHelpAndExit(1);
      } else {
        args.sort = raw;
      }
      if (a === '--sort') i++;
    } else if (a === '--direction' || a.startsWith('--direction=')) {
      const raw = a === '--direction' ? argv[i + 1] : a.slice('--direction='.length);
      if (!raw || raw.startsWith('-')) {
        console.error('Missing value for --direction. Supported values: asc, desc');
        printHelpAndExit(1);
      }
      if (!allowedDirections.has(raw)) {
        console.error(`Unsupported --direction value: ${raw}`);
        printHelpAndExit(1);
      }
      args.direction = raw;
      if (a === '--direction') i++;
    } else if (a === '--top') {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n > 0) args.top = n;
      i++;
    } else if (a === '--omit' || a.startsWith('--omit=')) {
      const raw = a === '--omit' ? argv[i + 1] : a.slice('--omit='.length);
      const values = addTypes(raw, '--omit');
      for (const v of values) args.omit.add(v);
      if (a === '--omit') i++;
    } else if (a === '--include' || a.startsWith('--include=')) {
      const raw = a === '--include' ? argv[i + 1] : a.slice('--include='.length);
      const values = addTypes(raw, '--include');
      for (const v of values) args.include.add(v);
      if (a === '--include') i++;
    } else if (a === '-h' || a === '--help') {
      printHelpAndExit();
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelpAndExit(1);
    }
  }

  // npm-style precedence: include wins over omit
  for (const t of args.include) args.omit.delete(t);

  return args;
}

function printHelpAndExit(code = 0) {
  console.log(`rank-subdeps

Rank top-level dependencies by unique transitive subdependencies, latest publish date, and approximate file size.

Usage:
  rank-subdeps [--json] [--top N] [--sort subdeps|size|name|publish] [--direction asc|desc] [--omit=<type>[,<type>]] [--include=<type>[,<type>]]

Options:
  --json        Output machine-readable JSON instead of a table (includes lastUpdated and aggregateApproxBytes)
  --top N       Number of items to include in the "Top N" summary (default: 10)
  --sort        Sort by subdeps, size, name, or publish date
  --direction   Sort direction for selected --sort: asc or desc
  --omit        Dependency types to omit: dev, optional, peer (can be repeated)
  --include     Dependency types to include even if omitted (can be repeated)
  -h, --help    Show this help
`);
  process.exit(code);
}

function getResultsComparator(sortMode, direction = null) {
  const effectiveDirection = getEffectiveSortDirection(sortMode, direction);
  const asc = effectiveDirection === 'asc';

  if (sortMode === 'publish') {
    return (a, b) => {
      const aTs = getPublishTimestamp(a.lastUpdated);
      const bTs = getPublishTimestamp(b.lastUpdated);

      if (aTs == null && bTs == null) {
        return b.subdeps - a.subdeps || b.approxBytes - a.approxBytes || a.name.localeCompare(b.name);
      }
      if (aTs == null) return 1;
      if (bTs == null) return -1;
      return (
        (asc ? aTs - bTs : bTs - aTs) ||
        b.subdeps - a.subdeps ||
        b.approxBytes - a.approxBytes ||
        a.name.localeCompare(b.name)
      );
    };
  }
  if (sortMode === 'size') {
    return (a, b) =>
      (asc ? a.approxBytes - b.approxBytes : b.approxBytes - a.approxBytes) ||
      b.subdeps - a.subdeps ||
      a.name.localeCompare(b.name);
  }
  if (sortMode === 'name') {
    return (a, b) =>
      (asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)) ||
      b.subdeps - a.subdeps ||
      b.approxBytes - a.approxBytes;
  }
  return (a, b) =>
    (asc ? a.subdeps - b.subdeps : b.subdeps - a.subdeps) ||
    b.approxBytes - a.approxBytes ||
    a.name.localeCompare(b.name);
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const root = process.cwd();
  const pkg = loadPkgJson(root);
  const tree = runNpmLs(root, args);
  const outdatedJson = runNpmOutdated(root, args);
  const outdatedMarkers = collectOutdatedMarkers(root, outdatedJson);
  const outdatedCountsAvailable = outdatedJson !== null;

  const topDepsMap = new Map();
  const addTopDeps = (depsObj, type) => {
    if (!depsObj) return;
    if (type !== 'prod' && args.omit.has(type)) return;
    for (const [name, wanted] of Object.entries(depsObj)) {
      const cur = topDepsMap.get(name);
      if (!cur) {
        topDepsMap.set(name, {
          types: new Set([type]),
          wantedByType: { [type]: wanted },
        });
      } else {
        cur.types.add(type);
        cur.wantedByType[type] = wanted;
      }
    }
  };

  addTopDeps(pkg.dependencies, 'prod');
  addTopDeps(pkg.devDependencies, 'dev');
  addTopDeps(pkg.optionalDependencies, 'optional');
  addTopDeps(pkg.peerDependencies, 'peer');

  const topDeps = {};
  for (const [name, meta] of topDepsMap.entries()) {
    // npm semantics: optionalDependencies override dependencies when both exist.
    const wanted =
      meta.wantedByType.optional ??
      meta.wantedByType.prod ??
      meta.wantedByType.dev ??
      meta.wantedByType.peer ??
      'UNKNOWN';
    topDeps[name] = { ...meta, wanted };
  }
  const lastUpdatedByPackage = collectLastUpdatedByPackage(root, Object.keys(topDeps));

  const results = [];
  const pathSizeCache = new Map();

  for (const [name, meta] of Object.entries(topDeps)) {
    const types = ['prod', 'dev', 'optional', 'peer'].filter(t => meta.types.has(t));
    const node = tree.dependencies?.[name];
    if (!node) {
      results.push({
        name,
        wanted: meta.wanted,
        installed: 'NOT INSTALLED',
        lastUpdated: lastUpdatedByPackage.get(name) ?? null,
        types,
        subdeps: 0,
        outdatedSubdeps: outdatedCountsAvailable ? 0 : null,
        approxBytes: 0,
      });
      continue;
    }

    const stats = collectSubtreeStats(name, node, pathSizeCache, outdatedMarkers);
    results.push({
      name,
      wanted: meta.wanted,
      installed: node.version || 'UNKNOWN',
      lastUpdated: lastUpdatedByPackage.get(name) ?? null,
      types,
      subdeps: stats.subdeps,
      outdatedSubdeps: outdatedCountsAvailable ? stats.outdatedSubdeps : null,
      approxBytes: stats.approxBytes,
    });
  }

  results.sort(getResultsComparator(args.sort, args.direction));
  const aggregateApproxBytes = collectAggregateApproxBytes(tree, Object.keys(topDeps), pathSizeCache);

  if (args.json) {
    // JSON mode: full dataset
    console.log(JSON.stringify({ results, aggregateApproxBytes }, null, 2));
    return;
  }

  // Pretty table
  const header = [
    '#',
    'name',
    'wanted(range)',
    'installed',
    'last published',
    'types',
    'subdeps',
    'outdated',
    'approx size',
  ];
  const rows = [header];

  results.forEach((r, idx) => {
    rows.push([
      String(idx + 1),
      r.name,
      r.wanted,
      r.installed,
      formatLastUpdated(r.lastUpdated),
      r.types.join(','),
      String(r.subdeps),
      r.outdatedSubdeps == null ? '?' : String(r.outdatedSubdeps),
      formatApproxBytes(r.approxBytes),
    ]);
  });

  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => String(row[i]).length)));
  const line = row => row.map((cell, i) => pad(cell, widths[i])).join('  ');

  console.log(line(rows[0]));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (let i = 1; i < rows.length; i++) console.log(line(rows[i]));
  if (!outdatedCountsAvailable) {
    console.log('\nNote: outdated counts unavailable (npm outdated failed).');
  }

  const topN = results.slice(0, args.top);
  const maxNameLen = Math.max(...topN.map(x => x.name.length), 4);
  const effectiveDirection = getEffectiveSortDirection(args.sort, args.direction);
  const topLabel =
    args.sort === 'size'
      ? `approx size (${effectiveDirection})`
      : args.sort === 'name'
        ? `name (${effectiveDirection})`
        : args.sort === 'publish'
          ? `publish date (${effectiveDirection})`
          : `subdependencies (${effectiveDirection})`;
  console.log(`\nTop ${args.top} by ${topLabel}:`);
  topN.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2, ' ')}. ${pad(r.name, maxNameLen)}  →  ${r.subdeps} subdeps  (${formatApproxBytes(r.approxBytes)}) (${r.installed}) [${r.types.join(',')}]`
    );
  });

  console.log(`\nAggregate approx size (deduped by name@version): ${formatApproxBytes(aggregateApproxBytes)}`);
}

function shouldRunAsCli(moduleFilePath, argv1) {
  if (!argv1) return false;
  const invokedFile = resolve(argv1);
  try {
    return realpathSync(moduleFilePath) === realpathSync(invokedFile);
  } catch {
    return moduleFilePath === invokedFile;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (shouldRunAsCli(thisFile, process.argv[1])) main();

export {
  collectLastUpdatedByPackage,
  collectAggregateApproxBytes,
  collectOutdatedMarkers,
  collectSubtreeStats,
  formatApproxBytes,
  formatLastUpdated,
  getApproxPathSize,
  getResultsComparator,
  isOutdatedNode,
  main,
  parseArgs,
  runNpmLs,
  runNpmOutdated,
  runNpmViewLastUpdated,
  shouldRunAsCli,
};
