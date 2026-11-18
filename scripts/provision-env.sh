#!/bin/sh
# Copy this repository's machine-local .env into a new checkout.
#
# T3 does not run the global post-checkout hook for the worktrees that it
# creates. t3.json runs this script after it creates a worktree. See
# docs/worktree-setup.md.
#
# Source order: BLIBS_ENV_SOURCE, $SECRETS_DIR/<repo>/.env (SECRETS_DIR
# defaults to ~/.secrets), then the main checkout's .env. The destination is
# .env at the checkout root. An existing file, symlink, or directory is never
# replaced. Use --check to report the destination without writing.
set -eu

top=$(git rev-parse --show-toplevel)
common=$(git rev-parse --git-common-dir)
case "$common" in
  /* | [A-Za-z]:[/\\]*) ;;
  *) common="$top/$common" ;;
esac
main_root=$(cd "$common/.." && pwd -P)
repo=$(basename "$main_root")
dest="$top/.env"

if [ "${1:-}" = "--check" ]; then
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "env: $dest exists"
    exit 0
  fi
  echo "env: $dest missing"
  exit 1
fi

if [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "env: kept existing $dest"
  exit 0
fi

secrets=${SECRETS_DIR:-$HOME/.secrets}
src=
for candidate in "${BLIBS_ENV_SOURCE:-}" "$secrets/$repo/.env" "$main_root/.env"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    src=$candidate
    break
  fi
done

if [ -z "$src" ]; then
  echo "env: warning: no .env source found for $repo." >&2
  echo "env: set BLIBS_ENV_SOURCE, or create $secrets/$repo/.env." >&2
  if [ "${BLIBS_REQUIRE_ENV:-}" = "1" ]; then
    echo "env: BLIBS_REQUIRE_ENV=1 is set." >&2
    exit 1
  fi
  exit 0
fi

cp "$src" "$dest"
chmod 600 "$dest" 2>/dev/null || true

if ! git -C "$top" check-ignore -q .env; then
  exclude=$(git -C "$top" rev-parse --git-path info/exclude)
  case "$exclude" in
    /* | [A-Za-z]:[/\\]*) ;;
    *) exclude="$top/$exclude" ;;
  esac
  mkdir -p "$(dirname "$exclude")"
  printf '.env\n' >> "$exclude"
fi

echo "env: copied $src -> $dest"
