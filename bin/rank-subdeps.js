#!/usr/bin/env node
// ESM CLI: rank-subdeps
// Ranks top-level deps by number of unique transitive subdependencies using `npm ls --all --json`.
//
// Usage:
//   rank-subdeps
//   rank-subdeps --json
//   rank-subdeps --top 20
//
// Notes:
// - Counts unique subdeps by (name@version) excluding the package itself.
// - Includes both dependencies and devDependencies.
// - Requires an installed tree (node_modules). Run `npm i` first.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

function runNpmLs(root) {
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const out = execFileSync(bin, ['ls', '--all', '--json'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.toString('utf8'));
  } catch (err) {
    const stdout = err?.stdout?.toString('utf8');
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {}
    }
    console.error('Failed to run "npm ls --all --json".');
    if (err?.stderr) console.error(String(err.stderr));
    process.exit(1);
  }
}

const makeId = (name, version) => `${name}@${version || 'UNKNOWN'}`;

function collectUniqueSubdeps(node) {
  // Collect unique (name@version) for all descendants of `node`
  const seen = new Set();
  const stack = [];

  if (!node || !node.dependencies) return seen;

  for (const [name, child] of Object.entries(node.dependencies)) {
    stack.push([name, child]);
  }

  while (stack.length) {
    const [name, cur] = stack.pop();
    const id = makeId(name, cur?.version);
    if (seen.has(id)) continue;
    seen.add(id);
    if (cur && cur.dependencies) {
      for (const [n2, c2] of Object.entries(cur.dependencies)) {
        stack.push([n2, c2]);
      }
    }
  }
  return seen;
}

const pad = (str, len) => {
  str = String(str);
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
};

function parseArgs(argv) {
  const args = { json: false, top: 10 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.json = true;
    } else if (a === '--top') {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n > 0) args.top = n;
      i++;
    } else if (a === '-h' || a === '--help') {
      printHelpAndExit();
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelpAndExit(1);
    }
  }
  return args;
}

function printHelpAndExit(code = 0) {
  console.log(`rank-subdeps

Rank top-level dependencies by unique transitive subdependencies.

Usage:
  rank-subdeps [--json] [--top N]

Options:
  --json        Output machine-readable JSON instead of a table
  --top N       Number of items to include in the "Top N" summary (default: 10)
  -h, --help    Show this help
`);
  process.exit(code);
}

(function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const pkg = loadPkgJson(root);
  const tree = runNpmLs(root);

  const topDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  const isDev = {};
  for (const name of Object.keys(pkg.devDependencies || {})) isDev[name] = true;

  const results = [];

  for (const [name, wanted] of Object.entries(topDeps)) {
    const node = tree.dependencies?.[name];
    if (!node) {
      results.push({
        name,
        wanted,
        installed: 'NOT INSTALLED',
        dev: !!isDev[name],
        subdeps: 0,
      });
      continue;
    }

    const uniqueSub = collectUniqueSubdeps(node);
    results.push({
      name,
      wanted,
      installed: node.version || 'UNKNOWN',
      dev: !!isDev[name],
      subdeps: uniqueSub.size,
    });
  }

  results.sort((a, b) => b.subdeps - a.subdeps || a.name.localeCompare(b.name));

  if (args.json) {
    // JSON mode: full dataset
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  // Pretty table
  const header = ['#', 'name', 'wanted(range)', 'installed', 'dev?', 'subdeps'];
  const rows = [header];

  results.forEach((r, idx) => {
    rows.push([
      String(idx + 1),
      r.name,
      r.wanted,
      r.installed,
      r.dev ? 'yes' : 'no',
      String(r.subdeps),
    ]);
  });

  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => String(row[i]).length)));
  const line = row => row.map((cell, i) => pad(cell, widths[i])).join('  ');

  console.log(line(rows[0]));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (let i = 1; i < rows.length; i++) console.log(line(rows[i]));

  const topN = results.slice(0, args.top);
  const maxNameLen = Math.max(...topN.map(x => x.name.length), 4);
  console.log(`\nTop ${args.top} by subdependencies:`);
  topN.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2, ' ')}. ${pad(r.name, maxNameLen)}  →  ${r.subdeps} subdeps  (${r.installed})${r.dev ? ' [dev]' : ''}`
    );
  });
})();
