# rank-subdeps

Rank your top-level dependencies by how many transitive subdependencies they bring in, how many of those are outdated, and their approximate aggregate file size.

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
| `--json` | Output machine-readable JSON (includes `outdatedSubdeps` per result) |
| `--top N` | Show a “Top N” summary (default: 10) |
| `--sort subdeps\|size\|name` | Sort by subdependency count (default), approximate size, or package name |
| `--omit=<type>[,<type>]` | Omit dependency types: `dev`, `optional`, `peer` |
| `--include=<type>[,<type>]` | Include dependency types even if omitted |
| `-h, --help` | Show help |

### Example output

```
#  name          wanted(range)  installed  types  subdeps  outdated  approx size
-  ------------- -------------- ---------- ------ -------  --------  -----------
1  express       ^4.19.2        4.19.2     prod   69       12        ~2.8 MB
2  typescript    ^5.6.2         5.6.2      dev    10       0         ~23 MB
3  chalk         ^5.3.0         5.3.0      prod   2        1         ~94 KB

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
```

It then counts **unique subdependencies** by `(name@version)` for each top-level dependency from `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies`.

It also counts how many unique transitive subdependencies in each subtree are outdated (based on `npm outdated` output).

Approximate file size is derived from installed package files under `node_modules` and deduped by `(name@version)`.

If `npm outdated` fails (for example due to registry/auth/network issues), the main report still works and the `outdated` column is shown as `?`.

Filtering follows npm-style omit/include semantics:

- `--omit=dev,optional` (or repeated `--omit` flags)
- `--include=<type>` overrides omit for that type
- default omit includes `dev` when `NODE_ENV=production`
- when a package exists in both `dependencies` and `optionalDependencies`, the optional range is used (npm override behavior)

## License

MIT © 2025 Ēriks Remess
