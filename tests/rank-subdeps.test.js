import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectAuditMarkers,
  collectGitHubCommitDatesByPackage,
  collectGitHubPackageInfoByPackage,
  collectLastUpdatedByPackage,
  collectPackageMetaByPackage,
  collectAggregateApproxBytes,
  collectOutdatedMarkers,
  collectSubtreeStats,
  compareLatestToInstalled,
  compareSemverVersions,
  formatInstalledVersion,
  formatLatestVersion,
  formatLatestWithStatus,
  formatLastUpdated,
  getGitHubCommitRefForNode,
  getGitHubTrackingRefForNode,
  getResultsComparator,
  parseGitHubCommitMetaValue,
  parseGitHubCommitRef,
  parseGitHubCommitDateValue,
  parseArgs,
  runGitHubCommitDate,
  runGitHubCommitMeta,
  runGitHubLatestCommitMeta,
  runNpmLs,
  runNpmAudit,
  runNpmOutdated,
  runNpmViewPackageMeta,
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
  const auditMarkers = {
    pathSeverityRanks: new Map([[join(root, 'node_modules', 'shared'), 2]]),
    packageSeverityRanks: new Map(),
  };
  const betaStats = collectSubtreeStats('beta', tree.dependencies.beta, cache, outdatedMarkers, auditMarkers);
  const gammaStats = collectSubtreeStats('gamma', tree.dependencies.gamma, cache, outdatedMarkers, auditMarkers);
  const aggregate = collectAggregateApproxBytes(tree, ['alpha', 'beta', 'gamma'], cache);

  assert.equal(betaStats.subdeps, 1);
  assert.equal(gammaStats.subdeps, 1);
  assert.equal(betaStats.outdatedSubdeps, 1);
  assert.equal(gammaStats.outdatedSubdeps, 1);
  assert.equal(betaStats.auditSubdeps, 1);
  assert.equal(gammaStats.auditSubdeps, 1);
  assert.equal(betaStats.auditSeverity, 'high');
  assert.equal(gammaStats.auditSeverity, 'high');
  assert.equal(betaStats.approxBytes, 60);
  assert.equal(gammaStats.approxBytes, 70);
  assert.equal(aggregate, 100);
});

test('collectAuditMarkers parses vulnerabilities with severity and node paths', () => {
  const root = '/tmp/project';
  const parsed = collectAuditMarkers(root, {
    vulnerabilities: {
      'ansi-regex': {
        name: 'ansi-regex',
        severity: 'high',
        nodes: ['node_modules/chalk/node_modules/ansi-regex'],
      },
      chalk: {
        severity: 'moderate',
        nodes: ['node_modules/chalk'],
      },
    },
  });

  assert.equal(parsed.packageSeverityRanks.get('ansi-regex'), 2);
  assert.equal(parsed.packageSeverityRanks.get('chalk'), 1);
  assert.equal(parsed.pathSeverityRanks.get(join(root, 'node_modules', 'chalk')), 1);
  assert.equal(parsed.pathSeverityRanks.get(join(root, 'node_modules', 'chalk', 'node_modules', 'ansi-regex')), 2);
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

test('runNpmAudit parses JSON from non-zero exit with stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-audit-test-'));
  const args = {
    omit: new Set(['optional', 'dev']),
    include: new Set(['peer']),
  };

  let seenBin = null;
  let seenArgs = null;
  const fakeExec = (bin, npmArgs) => {
    seenBin = bin;
    seenArgs = npmArgs;
    const err = new Error('audit found issues');
    err.stdout = Buffer.from(JSON.stringify({
      vulnerabilities: {
        chalk: {
          severity: 'moderate',
          nodes: ['node_modules/chalk'],
        },
      },
    }));
    throw err;
  };

  const audit = runNpmAudit(root, args, fakeExec);

  assert.ok(seenBin === 'npm' || seenBin === 'npm.cmd');
  assert.deepEqual(
    seenArgs,
    ['audit', '--all', '--json', '--omit=dev', '--omit=optional', '--include=peer']
  );
  assert.equal(audit.vulnerabilities.chalk.severity, 'moderate');
});

test('runNpmViewPackageMeta parses latest dist-tag and latest publish time', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-view-meta-test-'));
  const fakeExec = () =>
    Buffer.from(JSON.stringify({
      'dist-tags.latest': '5.6.2',
      time: {
        modified: '2025-10-29T23:18:03.554Z',
        '5.6.2': '2025-09-08T14:47:54.486Z',
      },
    }));

  const meta = runNpmViewPackageMeta(root, 'chalk', fakeExec);

  assert.equal(meta.latest, '5.6.2');
  assert.equal(meta.lastUpdated, '2025-09-08T14:47:54.486Z');
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

test('collectPackageMetaByPackage handles mixed success and failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-view-meta-map-test-'));
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

  const results = collectPackageMetaByPackage(root, ['chalk', 'missing'], fakeExec);

  assert.equal(results.get('chalk').latest, '5.6.2');
  assert.equal(results.get('chalk').lastUpdated, '2025-09-08T14:47:54.486Z');
  assert.equal(results.get('missing').latest, null);
  assert.equal(results.get('missing').lastUpdated, null);
});

test('parseGitHubCommitRef recognizes common GitHub dependency refs', () => {
  assert.deepEqual(parseGitHubCommitRef('github:octo/example#abc123'), {
    owner: 'octo',
    repo: 'example',
    ref: 'abc123',
  });
  assert.deepEqual(parseGitHubCommitRef('git+ssh://git@github.com:octo/example.git#refs/tags/v1.0.0'), {
    owner: 'octo',
    repo: 'example',
    ref: 'v1.0.0',
  });
  assert.deepEqual(parseGitHubCommitRef('https://codeload.github.com/octo/example/tar.gz/deadbeef'), {
    owner: 'octo',
    repo: 'example',
    ref: 'deadbeef',
  });
  assert.equal(parseGitHubCommitRef('github:octo/example#semver:^1.0.0'), null);
  assert.equal(parseGitHubCommitRef('^1.0.0'), null);
});

test('getGitHubCommitRefForNode uses installed GitHub source plus gitHead', () => {
  const root = mkdtempSync(join(tmpdir(), 'rank-subdeps-github-source-test-'));
  const githubPackageDir = join(root, 'node_modules', 'github-dep');
  mkdirSync(githubPackageDir, { recursive: true });
  writeFileSync(
    join(githubPackageDir, 'package.json'),
    JSON.stringify({
      name: 'github-dep',
      version: '1.0.0',
      _from: 'github:octo/example',
      gitHead: 'deadbeef',
    }),
    'utf8'
  );

  assert.deepEqual(
    getGitHubCommitRefForNode('github-dep', { version: '1.0.0', path: githubPackageDir }, '^1.0.0'),
    {
      owner: 'octo',
      repo: 'example',
      ref: 'deadbeef',
    }
  );

  const registryPackageDir = join(root, 'node_modules', 'registry-dep');
  mkdirSync(registryPackageDir, { recursive: true });
  writeFileSync(
    join(registryPackageDir, 'package.json'),
    JSON.stringify({
      name: 'registry-dep',
      version: '1.0.0',
      repository: {
        url: 'https://github.com/octo/example.git',
      },
      gitHead: 'deadbeef',
    }),
    'utf8'
  );

  assert.equal(
    getGitHubCommitRefForNode('registry-dep', { version: '1.0.0', path: registryPackageDir }, '^1.0.0'),
    null
  );
});

test('getGitHubCommitRefForNode prefers resolved installed commit over requested branch', () => {
  assert.deepEqual(
    getGitHubCommitRefForNode(
      'express',
      {
        version: '1.0.0',
        from: 'github:EriksRemess/express#eriks-esm',
      },
      'github:EriksRemess/express#eriks-esm',
      {
        version: '1.0.0',
        resolved: 'git+https://github.com/EriksRemess/express.git#ee84143abcdef',
      }
    ),
    {
      owner: 'EriksRemess',
      repo: 'express',
      ref: 'ee84143abcdef',
    }
  );
});

test('getGitHubTrackingRefForNode prefers requested GitHub branch over lockfile commit', () => {
  const node = {
    version: '1.0.0',
  };
  const lockEntry = {
    version: '1.0.0',
    resolved: 'git+https://github.com/EriksRemess/express.git#abcdef1234567890',
    from: 'github:EriksRemess/express#ee84143',
  };

  assert.deepEqual(
    getGitHubTrackingRefForNode(
      'express',
      node,
      'github:EriksRemess/express#eriks-esm',
      lockEntry
    ),
    {
      owner: 'EriksRemess',
      repo: 'express',
      ref: 'eriks-esm',
    }
  );

  assert.deepEqual(getGitHubTrackingRefForNode('express', node, 'github:EriksRemess/express', lockEntry), {
    owner: 'EriksRemess',
    repo: 'express',
    ref: null,
  });
});

test('runGitHubCommitMeta requests GitHub commit API and parses committer date and SHA', async () => {
  let seenUrl = null;
  const fakeRequester = async url => {
    seenUrl = url;
    return {
      sha: 'abcdef1234567890',
      commit: {
        committer: {
          date: '2025-11-01T12:34:56Z',
        },
      },
    };
  };
  const meta = await runGitHubCommitMeta(
    { owner: 'octo', repo: 'example', ref: 'feature/test' },
    fakeRequester
  );
  const date = await runGitHubCommitDate({ owner: 'octo', repo: 'example', ref: 'feature/test' }, fakeRequester);

  assert.equal(seenUrl, 'https://api.github.com/repos/octo/example/commits/feature%2Ftest');
  assert.deepEqual(meta, { date: '2025-11-01T12:34:56Z', sha: 'abcdef1234567890' });
  assert.equal(date, '2025-11-01T12:34:56Z');
  assert.equal(parseGitHubCommitDateValue({ commit: { author: { date: '2025-10-01T00:00:00Z' } } }), '2025-10-01T00:00:00Z');
  assert.deepEqual(parseGitHubCommitMetaValue({ sha: '1234567', commit: { author: { date: '2025-10-01T00:00:00Z' } } }), {
    date: '2025-10-01T00:00:00Z',
    sha: '1234567',
  });
});

test('runGitHubLatestCommitMeta requests latest GitHub commit list entry', async () => {
  let seenUrl = null;
  const meta = await runGitHubLatestCommitMeta(
    { owner: 'octo', repo: 'example', ref: 'abc123' },
    async url => {
      seenUrl = url;
      return [
        {
          sha: '9999999abcdef',
          commit: {
            committer: {
              date: '2025-12-01T00:00:00Z',
            },
          },
        },
      ];
    }
  );

  assert.equal(seenUrl, 'https://api.github.com/repos/octo/example/commits?sha=abc123&per_page=1');
  assert.deepEqual(meta, { date: '2025-12-01T00:00:00Z', sha: '9999999abcdef' });
});

test('runGitHubLatestCommitMeta reports verbose request failures', async () => {
  const messages = [];
  const meta = await runGitHubLatestCommitMeta(
    { owner: 'octo', repo: 'example', ref: 'main' },
    async () => {
      throw new Error('rate limit');
    },
    message => messages.push(message)
  );

  assert.deepEqual(meta, { date: null, sha: null });
  assert.deepEqual(messages, [
    'GitHub request: https://api.github.com/repos/octo/example/commits?sha=main&per_page=1',
    'GitHub request failed: https://api.github.com/repos/octo/example/commits?sha=main&per_page=1: rate limit',
  ]);
});

test('formatInstalledVersion uses a short hash for GitHub packages', () => {
  assert.equal(formatInstalledVersion('1.0.0', { sha: 'abcdef1234567890' }), 'abcdef1');
  assert.equal(formatInstalledVersion('1.0.0', { githubRef: { ref: 'deadbeef' } }), 'deadbee');
  assert.equal(formatInstalledVersion('1.0.0', { githubRef: { ref: 'main' } }), '1.0.0');
  assert.equal(formatInstalledVersion(null, null), 'UNKNOWN');
});

test('formatLatestVersion uses latest commit hash for GitHub packages', () => {
  assert.equal(formatLatestVersion('5.6.2', { latestSha: '9999999abcdef' }), '9999999');
  assert.equal(formatLatestVersion('5.6.2', { latestSha: null, latestRef: { ref: 'eriks-esm' } }), 'eriks-esm');
  assert.equal(formatLatestVersion('5.6.2', { latestSha: null, latestRef: { ref: 'a70e4d3abcdef' } }), 'a70e4d3');
  assert.equal(formatLatestVersion('5.6.2', { latestSha: null }), '?');
  assert.equal(formatLatestVersion('5.6.2', null), '5.6.2');
});

test('compareSemverVersions orders semver versions', () => {
  assert.equal(compareSemverVersions('5.6.2', '5.3.0') > 0, true);
  assert.equal(compareSemverVersions('1.0.0', '1.0.1') < 0, true);
  assert.equal(compareSemverVersions('1.0.0', '1.0.0-beta.1') > 0, true);
  assert.equal(compareSemverVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0, true);
  assert.equal(compareSemverVersions('main', '1.0.0'), null);
});

test('compareLatestToInstalled classifies registry and GitHub differences', () => {
  assert.equal(compareLatestToInstalled('5.6.2', '5.3.0'), 'newer');
  assert.equal(compareLatestToInstalled('5.3.0', '5.6.2'), 'older');
  assert.equal(compareLatestToInstalled('5.6.2', '5.6.2'), 'same');
  assert.equal(compareLatestToInstalled('main', 'abcdef1'), 'different');
  assert.equal(compareLatestToInstalled('?', 'abcdef1'), null);
  assert.equal(
    compareLatestToInstalled('9999999', 'abcdef1', {
      sha: 'abcdef1234567890',
      latestSha: '9999999abcdef',
      date: '2025-11-01T00:00:00Z',
      latestDate: '2025-12-01T00:00:00Z',
    }),
    'newer'
  );
  assert.equal(
    compareLatestToInstalled('9999999', 'abcdef1', {
      sha: 'abcdef1234567890',
      latestSha: '9999999abcdef',
      date: '2025-12-01T00:00:00Z',
      latestDate: '2025-11-01T00:00:00Z',
    }),
    'older'
  );
  assert.equal(
    compareLatestToInstalled('9999999', 'abcdef1', {
      sha: 'abcdef1234567890',
      latestSha: '9999999abcdef',
    }),
    'different'
  );
});

test('formatLatestWithStatus highlights changed latest values', () => {
  assert.equal(formatLatestWithStatus('5.6.2', 'newer'), '5.6.2 (newer)');
  assert.equal(formatLatestWithStatus('5.6.2', 'older'), '5.6.2 (older)');
  assert.equal(formatLatestWithStatus('main', 'different'), 'main (different)');
  assert.equal(formatLatestWithStatus('5.6.2', 'same'), '5.6.2');
  assert.equal(formatLatestWithStatus('5.6.2', null), '5.6.2');
});

test('collectGitHubCommitDatesByPackage only fetches dates for GitHub-installed packages', async () => {
  const topDeps = {
    githubDep: {
      wanted: '^1.0.0',
    },
    registryDep: {
      wanted: '^1.0.0',
    },
  };
  const tree = {
    dependencies: {
      githubDep: {
        version: '1.0.0',
      },
      registryDep: {
        version: '1.0.0',
      },
    },
  };
  const packageLock = {
    packages: {
      'node_modules/githubDep': {
        version: '1.0.0',
        resolved: 'git+https://github.com/octo/example.git#abc123',
      },
      'node_modules/registryDep': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/registryDep/-/registryDep-1.0.0.tgz',
      },
    },
  };
  const seenUrls = [];

  const results = await collectGitHubCommitDatesByPackage(
    topDeps,
    tree,
    async url => {
      seenUrls.push(url);
      if (url.endsWith('/commits?per_page=1')) {
        return [
          {
            sha: '9999999abcdef',
            commit: {
              committer: {
                date: '2025-12-01T00:00:00Z',
              },
            },
          },
        ];
      }
      return {
        sha: 'abcdef1234567890',
        commit: {
          committer: {
            date: '2025-11-01T12:34:56Z',
          },
        },
      };
    },
    null,
    packageLock
  );

  assert.deepEqual(seenUrls, [
    'https://api.github.com/repos/octo/example/commits/abc123',
    'https://api.github.com/repos/octo/example/commits?per_page=1',
  ]);
  assert.equal(results.get('githubDep'), '2025-11-01T12:34:56Z');
  assert.equal(results.has('registryDep'), false);
});

test('collectGitHubPackageInfoByPackage checks latest commit on requested branch', async () => {
  const topDeps = {
    express: {
      wanted: 'github:EriksRemess/express#eriks-esm',
    },
  };
  const tree = {
    dependencies: {
      express: {
        version: '1.0.0',
      },
    },
  };
  const packageLock = {
    packages: {
      'node_modules/express': {
        version: '1.0.0',
        resolved: 'git+https://github.com/EriksRemess/express.git#abcdef1234567890',
      },
    },
  };
  const seenUrls = [];

  const results = await collectGitHubPackageInfoByPackage(
    topDeps,
    tree,
    async url => {
      seenUrls.push(url);
      if (url.endsWith('/commits?sha=eriks-esm&per_page=1')) {
        return [
          {
            sha: '9999999abcdef',
            commit: {
              committer: {
                date: '2025-12-01T00:00:00Z',
              },
            },
          },
        ];
      }
      return {
        sha: 'abcdef1234567890',
        commit: {
          committer: {
            date: '2025-11-01T12:34:56Z',
          },
        },
      };
    },
    null,
    packageLock
  );

  assert.deepEqual(seenUrls, [
    'https://api.github.com/repos/EriksRemess/express/commits/abcdef1234567890',
    'https://api.github.com/repos/EriksRemess/express/commits?sha=eriks-esm&per_page=1',
  ]);
  assert.equal(results.get('express').latestRef.ref, 'eriks-esm');
  assert.equal(formatInstalledVersion('1.0.0', results.get('express')), 'abcdef1');
  assert.equal(formatLatestVersion(null, results.get('express')), '9999999');
});

test('collectGitHubPackageInfoByPackage reports verbose GitHub diagnostics', async () => {
  const topDeps = {
    express: {
      wanted: 'github:EriksRemess/express#eriks-esm',
    },
  };
  const tree = {
    dependencies: {
      express: {
        version: '1.0.0',
      },
    },
  };
  const packageLock = {
    packages: {
      'node_modules/express': {
        version: '1.0.0',
        resolved: 'git+https://github.com/EriksRemess/express.git#ee84143abcdef',
      },
    },
  };
  const messages = [];

  await collectGitHubPackageInfoByPackage(
    topDeps,
    tree,
    async url => {
      if (url.endsWith('/commits?sha=eriks-esm&per_page=1')) {
        return [
          {
            sha: 'a70e4d3abcdef',
            commit: {
              committer: {
                date: '2025-12-01T00:00:00Z',
              },
            },
          },
        ];
      }
      return {
        sha: 'ee84143abcdef',
        commit: {
          committer: {
            date: '2025-11-01T12:34:56Z',
          },
        },
      };
    },
    null,
    packageLock,
    message => messages.push(message)
  );

  assert.deepEqual(messages, [
    'express: GitHub installed ref EriksRemess/express#ee84143abcdef',
    'express: GitHub latest ref EriksRemess/express#eriks-esm',
    'GitHub packages detected: 1',
    'GitHub request: https://api.github.com/repos/EriksRemess/express/commits/ee84143abcdef',
    'GitHub request: https://api.github.com/repos/EriksRemess/express/commits?sha=eriks-esm&per_page=1',
    'express: installed commit ee84143 (2025-11-01T12:34:56Z)',
    'express: latest commit a70e4d3 (2025-12-01T00:00:00Z)',
  ]);
});

test('collectGitHubPackageInfoByPackage includes SHA for installed display', async () => {
  const topDeps = {
    githubDep: {
      wanted: 'github:octo/example#main',
    },
  };
  const tree = {
    dependencies: {
      githubDep: {
        version: '1.0.0',
      },
    },
  };

  const results = await collectGitHubPackageInfoByPackage(topDeps, tree, async url => {
    if (url.endsWith('/commits?sha=main&per_page=1')) {
      return [
        {
          sha: '9999999abcdef',
          commit: {
            committer: {
              date: '2025-12-01T00:00:00Z',
            },
          },
        },
      ];
    }
    return {
      sha: 'abcdef1234567890',
      commit: {
        committer: {
          date: '2025-11-01T12:34:56Z',
        },
      },
    };
  });

  assert.equal(results.get('githubDep').date, '2025-11-01T12:34:56Z');
  assert.equal(results.get('githubDep').sha, 'abcdef1234567890');
  assert.equal(results.get('githubDep').latestDate, '2025-12-01T00:00:00Z');
  assert.equal(results.get('githubDep').latestSha, '9999999abcdef');
  assert.equal(formatInstalledVersion('1.0.0', results.get('githubDep')), 'abcdef1');
  assert.equal(formatLatestVersion('5.6.2', results.get('githubDep')), '9999999');
});

test('formatLastUpdated uses YYYY-MM-DD and fallback markers', () => {
  assert.equal(formatLastUpdated('2025-10-29T23:18:03.554Z'), '2025-10-29');
  assert.equal(formatLastUpdated('not-a-date'), 'not-a-date');
  assert.equal(formatLastUpdated(null), '?');
});

test('parseArgs supports sort + universal direction, with legacy publish aliases', () => {
  const withEquals = parseArgs(['node', 'rank-subdeps.js', '--sort=size']);
  const withSpace = parseArgs(['node', 'rank-subdeps.js', '--sort', 'name']);
  const verboseLong = parseArgs(['node', 'rank-subdeps.js', '--verbose']);
  const verboseShort = parseArgs(['node', 'rank-subdeps.js', '-v']);
  const publishAsc = parseArgs(['node', 'rank-subdeps.js', '--sort=publish', '--direction=asc']);
  const publishDesc = parseArgs(['node', 'rank-subdeps.js', '--sort', 'publish', '--direction', 'desc']);
  const legacyPublishAsc = parseArgs(['node', 'rank-subdeps.js', '--sort=publish-asc']);
  const legacyPublishDesc = parseArgs(['node', 'rank-subdeps.js', '--sort', 'publish-desc']);
  const defaultSort = parseArgs(['node', 'rank-subdeps.js']);

  assert.equal(withEquals.sort, 'size');
  assert.equal(withEquals.direction, null);
  assert.equal(withSpace.sort, 'name');
  assert.equal(withSpace.direction, null);
  assert.equal(verboseLong.verbose, true);
  assert.equal(verboseShort.verbose, true);
  assert.equal(publishAsc.sort, 'publish');
  assert.equal(publishAsc.direction, 'asc');
  assert.equal(publishDesc.sort, 'publish');
  assert.equal(publishDesc.direction, 'desc');
  assert.equal(legacyPublishAsc.sort, 'publish');
  assert.equal(legacyPublishAsc.direction, 'asc');
  assert.equal(legacyPublishDesc.sort, 'publish');
  assert.equal(legacyPublishDesc.direction, 'desc');
  assert.equal(defaultSort.sort, 'subdeps');
  assert.equal(defaultSort.direction, null);
});

test('getResultsComparator sorts by selected mode', () => {
  const sample = [
    { name: 'beta', subdeps: 3, approxBytes: 80, lastUpdated: '2025-09-08T14:47:54.486Z' },
    { name: 'alpha', subdeps: 3, approxBytes: 10, lastUpdated: '2024-12-01T10:00:00.000Z' },
    { name: 'gamma', subdeps: 1, approxBytes: 120, lastUpdated: null },
    { name: 'delta', subdeps: 2, approxBytes: 30, lastUpdated: '2026-01-01T00:00:00.000Z' },
  ];

  const bySubdeps = [...sample].sort(getResultsComparator('subdeps')).map(x => x.name);
  const bySubdepsAsc = [...sample].sort(getResultsComparator('subdeps', 'asc')).map(x => x.name);
  const bySize = [...sample].sort(getResultsComparator('size')).map(x => x.name);
  const bySizeAsc = [...sample].sort(getResultsComparator('size', 'asc')).map(x => x.name);
  const byName = [...sample].sort(getResultsComparator('name')).map(x => x.name);
  const byNameDesc = [...sample].sort(getResultsComparator('name', 'desc')).map(x => x.name);
  const byPublishAsc = [...sample].sort(getResultsComparator('publish', 'asc')).map(x => x.name);
  const byPublishDesc = [...sample].sort(getResultsComparator('publish', 'desc')).map(x => x.name);

  assert.deepEqual(bySubdeps, ['beta', 'alpha', 'delta', 'gamma']);
  assert.deepEqual(bySubdepsAsc, ['gamma', 'delta', 'beta', 'alpha']);
  assert.deepEqual(bySize, ['gamma', 'beta', 'delta', 'alpha']);
  assert.deepEqual(bySizeAsc, ['alpha', 'delta', 'beta', 'gamma']);
  assert.deepEqual(byName, ['alpha', 'beta', 'delta', 'gamma']);
  assert.deepEqual(byNameDesc, ['gamma', 'delta', 'beta', 'alpha']);
  assert.deepEqual(byPublishAsc, ['alpha', 'beta', 'delta', 'gamma']);
  assert.deepEqual(byPublishDesc, ['delta', 'beta', 'alpha', 'gamma']);
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
