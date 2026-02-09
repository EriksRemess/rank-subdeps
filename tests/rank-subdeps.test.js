import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectAggregateApproxBytes,
  collectSubtreeStats,
  getResultsComparator,
  parseArgs,
  runNpmLs,
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
  const betaStats = collectSubtreeStats('beta', tree.dependencies.beta, cache);
  const gammaStats = collectSubtreeStats('gamma', tree.dependencies.gamma, cache);
  const aggregate = collectAggregateApproxBytes(tree, ['alpha', 'beta', 'gamma'], cache);

  assert.equal(betaStats.subdeps, 1);
  assert.equal(gammaStats.subdeps, 1);
  assert.equal(betaStats.approxBytes, 60);
  assert.equal(gammaStats.approxBytes, 70);
  assert.equal(aggregate, 100);
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
