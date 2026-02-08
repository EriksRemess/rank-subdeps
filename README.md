# rank-subdeps

Rank your top-level dependencies by how many transitive subdependencies they bring in.

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
| `--json` | Output machine-readable JSON |
| `--top N` | Show a “Top N” summary (default: 10) |
| `--omit=<type>[,<type>]` | Omit dependency types: `dev`, `optional`, `peer` |
| `--include=<type>[,<type>]` | Include dependency types even if omitted |
| `-h, --help` | Show help |

### Example output

```
#  name          wanted(range)  installed  types  subdeps
-  ------------- -------------- ---------- ------ -------
1  express       ^4.19.2        4.19.2     prod   69
2  typescript    ^5.6.2         5.6.2      dev    10
3  chalk         ^5.3.0         5.3.0      prod   2

Top 10 by subdependencies:
 1. express      →  69 subdeps  (4.19.2) [prod]
 2. typescript   →  10 subdeps  (5.6.2) [dev]
 3. chalk        →  2 subdeps   (5.3.0) [prod]
```

## How it works

The CLI runs:

```bash
npm ls --all --json
```

It then counts **unique subdependencies** by `(name@version)` for each top-level dependency from `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies`.

Filtering follows npm-style omit/include semantics:

- `--omit=dev,optional` (or repeated `--omit` flags)
- `--include=<type>` overrides omit for that type
- default omit includes `dev` when `NODE_ENV=production`
- when a package exists in both `dependencies` and `optionalDependencies`, the optional range is used (npm override behavior)

## License

MIT © 2025 Ēriks Remess
