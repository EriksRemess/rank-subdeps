# rank-subdeps

Rank your top-level dependencies by how many transitive subdependencies they bring in, how many of those are outdated, how many have audit issues (with severity), the latest available direct version, when direct dependencies were last updated, and their approximate aggregate file size.

## Install

```bash
npm i -g rank-subdeps
```

## Usage

From a project directory (with `node_modules` installed):

```bash
rank-subdeps
```

### Options

| Flag | Description |
|------|--------------|
| `--json` | Output machine-readable JSON (includes `latest`, `latestStatus`, `outdatedSubdeps`, `auditSubdeps`, and `lastUpdated` (latest publish time or GitHub commit time) per result) |
| `-v, --verbose` | Print diagnostic details to stderr, including GitHub refs, commit hashes, dates, and lookup counts |
| `--top N` | Show a “Top N” summary (default: 10) |
| `--sort subdeps\|size\|name\|publish` | Sort by subdependency count, approximate size, package name, or update date |
| `--direction asc\|desc` | Sort direction for the selected `--sort` field (defaults: `subdeps/size/publish=desc`, `name=asc`) |
| `--omit=<type>[,<type>]` | Omit dependency types: `dev`, `optional`, `peer` |
| `--include=<type>[,<type>]` | Include dependency types even if omitted |
| `-h, --help` | Show help |

### Example output

```
#  name          wanted  latest  installed  last updated  types  subdeps  outdated  audit         approx size
-  ------------- ------- ------- ---------- ------------  ------ -------  --------  ------------  -----------
1  express       ^4.19.2 4.21.0  4.19.2     2025-12-01      prod   69       12        4 (critical)  ~2.8 MB
2  typescript    ^5.6.2  5.6.2   5.6.2      2025-10-10      dev    10       0         0             ~23 MB
3  chalk         ^5.3.0  5.6.2   5.3.0      2025-09-08      prod   2        1         1 (moderate)  ~94 KB

Top 10 by subdependencies:
 1. express      →  69 subdeps  (~2.8 MB) (4.19.2) [prod]
 2. typescript   →  10 subdeps  (~23 MB) (5.6.2) [dev]
 3. chalk        →  2 subdeps   (~94 KB) (5.3.0) [prod]

Aggregate approx size (deduped by name@version): ~25 MB
```

## How it works

The CLI runs:

```bash
npm ls --all --json --long
npm outdated --all --json
npm audit --all --json
npm view <package> dist-tags.latest time --json
```

It then counts **unique subdependencies** by `(name@version)` for each top-level dependency from `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies`.

It also counts how many unique transitive subdependencies in each subtree are outdated (based on `npm outdated` output).

It also counts unique transitive subdependencies with `npm audit` findings and shows the highest severity per subtree in the `audit` column.

The `latest` and `installed` columns show package versions for registry packages. For GitHub-installed direct dependencies, `latest` shows the short hash for the latest commit on the requested GitHub ref or branch, and `installed` shows the short hash for the installed commit when available.

When `latest` and `installed` differ, the table marks `latest` as `(newer)`, `(older)`, or `(different)`. Registry packages are compared with semver ordering; GitHub packages are compared by commit dates when available, otherwise by hash difference.

The `last updated` column is sourced from the publish timestamp of each direct dependency's npm `latest` dist-tag version. When a direct dependency is installed from a GitHub URL or shorthand with a commit/ref, the CLI tries GitHub's commits API and uses that commit's timestamp instead. If `GITHUB_TOKEN` is set, it is sent with those GitHub requests.

Approximate file size is derived from installed package files under `node_modules` and deduped by `(name@version)`.

If `npm outdated` fails (for example due to registry/auth/network issues), the main report still works and the `outdated` column is shown as `?`.

If `npm audit` fails (for example due to registry/auth/network issues), the main report still works and the `audit` column is shown as `?`.

Filtering follows npm-style omit/include semantics:

- `--omit=dev,optional` (or repeated `--omit` flags)
- `--include=<type>` overrides omit for that type
- default omit includes `dev` when `NODE_ENV=production`
- when a package exists in both `dependencies` and `optionalDependencies`, the optional range is used (npm override behavior)

## License

MIT © 2025 Ēriks Remess
