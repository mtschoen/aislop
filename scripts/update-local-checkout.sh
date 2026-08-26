#!/usr/bin/env bash
# Brings a per-user aislop checkout up to date with schoen/main and rebuilds
# dist/, running as the interactive user who owns the checkout.
#
# The install this maintains is per-user by design. pnpm hard-links package
# files out of its content-addressable store, and on NTFS a hard link shares
# one ACL with the store file it points at. A checkout installed by one
# account out of that account's store therefore produces node_modules entries
# that a second account cannot read, which is why the install and the shell
# that runs aislop must belong to the same user.
#
# Usage:
#   scripts/update-local-checkout.sh            # update ${AISLOP_HOME:-~/aislop}
#   AISLOP_HOME=/path/to/checkout scripts/update-local-checkout.sh
#
# Runs on Linux and on Windows under Git Bash.
set -euo pipefail

checkoutDirectory="${AISLOP_HOME:-$HOME/aislop}"
targetBranch="${AISLOP_BRANCH:-schoen/main}"
giteaRemoteUrl="https://gitea.fleet.sticktoitive.net/schoen/aislop.git"

if [ ! -d "$checkoutDirectory/.git" ]; then
  echo "Bootstrapping $checkoutDirectory from Gitea (one-time)"
  git clone --branch "$targetBranch" "$giteaRemoteUrl" "$checkoutDirectory"
else
  # Resolve the remote that actually points at the Gitea instance. Fleet
  # checkouts name it `gitea`; a fresh clone from the line above names it
  # `origin`. Fall back to the URL so neither naming is required.
  remoteName="$(git -C "$checkoutDirectory" remote \
    | while read -r candidate; do
        case "$(git -C "$checkoutDirectory" remote get-url "$candidate")" in
          *sticktoitive.net*) echo "$candidate"; break ;;
        esac
      done)"
  git -C "$checkoutDirectory" fetch "${remoteName:-$giteaRemoteUrl}" "$targetBranch"
  git -C "$checkoutDirectory" checkout -B "$targetBranch" FETCH_HEAD
fi

# `pnpm install` runs the package's prepare script, which builds dist/. The
# packageManager pin decides the pnpm version, so invoke pnpm through the
# checkout rather than assuming the caller's pnpm matches.
cd "$checkoutDirectory"
pnpm install --frozen-lockfile

node dist/cli.js --version
