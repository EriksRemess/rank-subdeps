import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectLastUpdatedByPackage,
  collectAggregateApproxBytes,
  collectOutdatedMarkers,
  collectSubtreeStats,
  formatLastUpdated,
  getResultsComparator,
  parseArgs,
  runNpmLs,
  runNpmOutdated,
  runNpmViewLastUpdated,
  shouldRunAsCli,
} from '../bin/rank-subdeps.js';

test('runNpmLs requests --long and parses captured JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-test-'));
  const args = {
    omit: new Set(['optional', 'dev']),
    include: new Set(['peer']),
  };

  let seenBin = null;
  let seenArgs = null;
  const fakeExec = (bin, npmArgs, options) => {
    seenBin = bin;
    seenArgs = npmArgs;
    writeSync(options.stdio[1], JSON.stringify({ name: 'fixture' }));
  };

  const tree = runNpmLs(root, args, fakeExec);

  assert.ok(seenBin === 'npm' || seenBin === 'npm.cmd');
  assert.ok(seenArgs.includes('--long'));
  assert.deepEqual(
    seenArgs,
    ['ls', '--all', '--json', '--long', '--omit=dev', '--omit=optional', '--include=peer']
  );
  assert.deepEqual(tree, { name: 'fixture' });
});

test('collects subtree and aggregate bytes with dedupe by name@version', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-size-test-'));
  mkdirSync(join(root, 'node_modules', 'alpha'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'beta'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'gamma'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'shared'), { recursive: true });

  writeFileSync(join(root, 'node_modules', 'alpha', 'size.txt'), 'a'.repeat(10), 'utf8');
  writeFileSync(join(root, 'node_modules', 'beta', 'size.txt'), 'b'.repeat(20), 'utf8');
  writeFileSync(join(root, 'node_modules', 'gamma', 'size.txt'), 'c'.repeat(30), 'utf8');
  writeFileSync(join(root, 'node_modules', 'shared', 'size.txt'), 'd'.repeat(40), 'utf8');

  const tree = {
    dependencies: {
      alpha: {
        version: '1.0.0',
        path: join(root, 'node_modules', 'alpha'),
      },
      beta: {
        version: '1.0.0',
        path: join(root, 'node_modules', 'beta'),
        dependencies: {
          shared: {
            version: '1.0.0',
            path: join(root, 'node_modules', 'shared'),
          },
        },
      },
      gamma: {
        version: '1.0.0',
        path: join(root, 'node_modules', 'gamma'),
        dependencies: {
          shared: {
            version: '1.0.0',
            path: join(root, 'node_modules', 'shared'),
          },
        },
      },
    },
  };

  const cache = new Map();
  const outdatedMarkers = {
    paths: new Set([join(root, 'node_modules', 'shared')]),
    ids: new Set(),
  };
  const betaStats = collectSubtreeStats('beta', tree.dependencies.beta, cache, outdatedMarkers);
  const gammaStats = collectSubtreeStats('gamma', tree.dependencies.gamma, cache, outdatedMarkers);
  const aggregate = collectAggregateApproxBytes(tree, ['alpha', 'beta', 'gamma'], cache);

  assert.equal(betaStats.subdeps, 1);
  assert.equal(gammaStats.subdeps, 1);
  assert.equal(betaStats.outdatedSubdeps, 1);
  assert.equal(gammaStats.outdatedSubdeps, 1);
  assert.equal(betaStats.approxBytes, 60);
  assert.equal(gammaStats.approxBytes, 70);
  assert.equal(aggregate, 100);
});

test('collectOutdatedMarkers parses npm outdated JSON entries recursively', () => {
  const root = '/tmp/project';
  const parsed = collectOutdatedMarkers(root, {
    chalk: {
      current: '5.3.0',
      wanted: '5.6.2',
      latest: '5.6.2',
      location: 'node_modules/chalk',
    },
    nested: {
      entries: [
        {
          name: 'ansi-styles',
          current: '6.2.1',
          latest: '6.3.0',
          location: 'node_modules/chalk/node_modules/ansi-styles',
        },
      ],
    },
  });

  assert.equal(parsed.ids.has('chalk@5.3.0'), true);
  assert.equal(parsed.ids.has('ansi-styles@6.2.1'), true);
  assert.equal(parsed.paths.has(join(root, 'node_modules', 'chalk')), true);
  assert.equal(parsed.paths.has(join(root, 'node_modules', 'chalk', 'node_modules', 'ansi-styles')), true);
});

test('runNpmOutdated parses JSON from non-zero exit with stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-outdated-test-'));
  const args = {
    omit: new Set(['optional', 'dev']),
    include: new Set(['peer']),
  };

  let seenBin = null;
  let seenArgs = null;
  const fakeExec = (bin, npmArgs) => {
    seenBin = bin;
    seenArgs = npmArgs;
    const err = new Error('outdated found');
    err.stdout = Buffer.from(JSON.stringify({
      chalk: {
        current: '5.3.0',
        latest: '5.6.2',
        location: 'node_modules/chalk',
      },
    }));
    throw err;
  };

  const outdated = runNpmOutdated(root, args, fakeExec);

  assert.ok(seenBin === 'npm' || seenBin === 'npm.cmd');
  assert.deepEqual(
    seenArgs,
    ['outdated', '--all', '--json', '--omit=dev', '--omit=optional', '--include=peer']
  );
  assert.equal(outdated.chalk.current, '5.3.0');
});

test('runNpmViewLastUpdated parses latest dist-tag publish time from npm view', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-view-test-'));

  let seenBin = null;
  let seenArgs = null;
  const fakeExec = (bin, npmArgs) => {
    seenBin = bin;
    seenArgs = npmArgs;
    return Buffer.from(JSON.stringify({
      'dist-tags.latest': '5.6.2',
      time: {
        created: '2013-08-03T00:21:56.318Z',
        modified: '2025-10-29T23:18:03.554Z',
        '5.6.2': '2025-09-08T14:47:54.486Z',
      },
    }));
  };

  const lastUpdated = runNpmViewLastUpdated(root, 'chalk', fakeExec);

  assert.ok(seenBin === 'npm' || seenBin === 'npm.cmd');
  assert.deepEqual(seenArgs, ['view', 'chalk', 'dist-tags.latest', 'time', '--json']);
  assert.equal(lastUpdated, '2025-09-08T14:47:54.486Z');
});

test('collectLastUpdatedByPackage handles mixed success and failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-view-map-test-'));
  const fakeExec = (_bin, npmArgs) => {
    if (npmArgs[1] === 'chalk') {
      return Buffer.from(JSON.stringify({
        'dist-tags.latest': '5.6.2',
        time: {
          '5.6.2': '2025-09-08T14:47:54.486Z',
        },
      }));
    }
    throw new Error('not found');
  };

  const results = collectLastUpdatedByPackage(root, ['chalk', 'missing'], fakeExec);

  assert.equal(results.get('chalk'), '2025-09-08T14:47:54.486Z');
  assert.equal(results.get('missing'), null);
});

test('formatLastUpdated uses YYYY-MM-DD and fallback markers', () => {
  assert.equal(formatLastUpdated('2025-10-29T23:18:03.554Z'), '2025-10-29');
  assert.equal(formatLastUpdated('not-a-date'), 'not-a-date');
  assert.equal(formatLastUpdated(null), '?');
});

test('parseArgs supports --sort value and --sort=value', () => {
  const withEquals = parseArgs(['node', 'rank-subdeps.js', '--sort=size']);
  const withSpace = parseArgs(['node', 'rank-subdeps.js', '--sort', 'name']);
  const defaultSort = parseArgs(['node', 'rank-subdeps.js']);

  assert.equal(withEquals.sort, 'size');
  assert.equal(withSpace.sort, 'name');
  assert.equal(defaultSort.sort, 'subdeps');
});

test('getResultsComparator sorts by selected mode', () => {
  const sample = [
    { name: 'beta', subdeps: 3, approxBytes: 80 },
    { name: 'alpha', subdeps: 3, approxBytes: 10 },
    { name: 'gamma', subdeps: 1, approxBytes: 120 },
  ];

  const bySubdeps = [...sample].sort(getResultsComparator('subdeps')).map(x => x.name);
  const bySize = [...sample].sort(getResultsComparator('size')).map(x => x.name);
  const byName = [...sample].sort(getResultsComparator('name')).map(x => x.name);

  assert.deepEqual(bySubdeps, ['beta', 'alpha', 'gamma']);
  assert.deepEqual(bySize, ['gamma', 'beta', 'alpha']);
  assert.deepEqual(byName, ['alpha', 'beta', 'gamma']);
});

test('shouldRunAsCli handles symlinked invocation paths', { skip: process.platform === 'win32' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rank-subdeps-cli-test-'));
  const realScript = join(tmp, 'rank-subdeps.js');
  const linkedScript = join(tmp, 'rank-subdeps-link.js');

  writeFileSync(realScript, 'export {};\n', 'utf8');
  symlinkSync(realScript, linkedScript);

  assert.equal(shouldRunAsCli(realScript, linkedScript), true);
  assert.equal(shouldRunAsCli(realScript, join(tmp, 'different.js')), false);
});
