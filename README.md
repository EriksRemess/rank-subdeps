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
| `-h, --help` | Show help |

### Example output

```
#  name          wanted(range)  installed  dev?  subdeps
-  ------------- -------------- ---------- ----- -------
1  express       ^4.19.2        4.19.2     no    69
2  typescript    ^5.6.2         5.6.2      yes   10
3  chalk         ^5.3.0         5.3.0      no    2

Top 10 by subdependencies:
 1. express      →  69 subdeps  (4.19.2)
 2. typescript   →  10 subdeps  (5.6.2) [dev]
 3. chalk        →  2 subdeps   (5.3.0)
```

## How it works

The CLI runs:

```bash
npm ls --all --json
```

It then counts **unique subdependencies** by `(name@version)` for each top-level dependency (from both `dependencies` and `devDependencies`).

## License

MIT © 2025 Ēriks Remess
