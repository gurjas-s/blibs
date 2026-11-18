# Provision the local `.env` in a new worktree

blibs reads machine-local keys from a `.env` file at the checkout root. A new
T3 worktree starts without that file. This document explains why the Git hook
misses T3 worktrees, how the checked-in setup script fixes it, and how to turn
the setup on for the main checkout.

## Why the global hook is not reliable

The global `core.hooksPath` post-checkout hook is correct. It runs for a manual
`git worktree add` and copies the secrets file. T3 does not use that path.

T3 creates a worktree with `git worktree add --no-checkout`. It then populates
the worktree from its checkout cache with `core.hooksPath=/dev/null`. Last, it
runs `git hook run post-checkout` with an environment that does not resolve the
global hook. The global hook can therefore be skipped for a T3 worktree.

Do not change the global hook to work around this. Use the project setup script
instead, because it runs inside the new worktree at the right time.

## The T3 setup script

`t3.json` at the repository root defines one setup script:

```json
{
  "scripts": [
    {
      "name": "Provision local env",
      "command": "sh scripts/provision-env.sh",
      "icon": "configure",
      "runOnWorktreeCreate": true,
      "async": false
    }
  ]
}
```

`runOnWorktreeCreate` runs the script after T3 creates a worktree. `async: false`
holds the agent until the script exits. The file is then ready before the agent
starts. The script is POSIX shell. macOS and Linux use the system `sh`. Windows
needs `sh` from Git for Windows.

You can run the same command yourself:

```bash
sh scripts/provision-env.sh
```

## Where the source file comes from

The script resolves the checkout root and the repository name with Git. In a
linked worktree, it uses the directory name of the main checkout. It looks for a
source file in this order:

1. `BLIBS_ENV_SOURCE`, when set.
2. `<SECRETS_DIR>/<repo>/.env`. `SECRETS_DIR` defaults to `~/.secrets`.
3. The main checkout's own `.env`.

For this repository, the default path is `~/.secrets/blibs/.env`.

The script copies the source to `.env` at the checkout root only when `.env`
does not exist. It never overwrites an existing file, a symlink, or a directory.
On macOS and Linux it sets mode `0600`. On Windows it skips the mode change. The
script prints the source path and the destination path. It never prints file
contents or key values.

If no source file exists, the script prints a warning and exits 0. Set
`BLIBS_REQUIRE_ENV=1` to make a missing source a hard failure with exit 1:

```bash
BLIBS_REQUIRE_ENV=1 sh scripts/provision-env.sh
```

Use the check mode for a test or a diagnosis. It reports whether the destination
exists and exits without writing or changing anything. It exits 0 when the file
exists and 1 when it is missing:

```bash
sh scripts/provision-env.sh --check
```

## Git ignore rules

`.env` stays out of Git. When Git does not ignore `.env`, the script appends
`.env` to the repository's `info/exclude` file. The script does not edit
`.gitignore`. Do not commit `.env`, secret values, cookies, or session data.

## Activation requirement

T3 reads `t3.json` from the main checkout of the project. It does not read the
file from the new worktree. The setup script also uses the main checkout's
directory name.

Until the main checkout has this `t3.json`, the setup script does not run. After
this change lands in `blibs/refactor`, keep the main checkout on
`blibs/refactor`, or copy `t3.json` into the main checkout. The script path must
also exist in the checked-out branch at the time T3 creates the worktree.

If the main checkout stays on another branch, the file is absent and T3 reports
no setup script. Provision the file by hand until the main checkout changes:

```bash
sh scripts/provision-env.sh
```
