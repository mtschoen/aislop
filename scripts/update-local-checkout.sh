#!/usr/bin/env bash
# Brings a per-user aislop checkout up to date with schoen/main and rebuilds
# dist/, running as the interactive user who owns the checkout.
#
# The install this maintains is per-user by design. pnpm hard-links package
# files out of its content-addressable store, and on NTFS a hard link shares
# one ACL with the store file it points at. A checkout installed by one
# account out of that account's store therefore produces node_modules entries
# that a second account cannot read, which is why the install and the shell
# that runs aislop must belong to the same user. A machine-shared directory
# such as /opt/aislop is the shape this design exists to avoid.
#
# This script is the only thing that moves a machine install. sync-consumers.yml
# bumps consumer repository pins (.aislop/fork-commit) and nothing else, so a
# checkout nobody runs this against stays where it was indefinitely.
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
  # Get onto the target branch without discarding anything. A checkout that
  # already has the branch is fast-forwarded; one that does not gets it created
  # from the fetched tip. A branch that has diverged carries commits which may
  # exist nowhere else, so divergence stops the script rather than being forced
  # into line.
  if git -C "$checkoutDirectory" show-ref --verify --quiet "refs/heads/$targetBranch"; then
    if ! git -C "$checkoutDirectory" merge-base --is-ancestor "$targetBranch" FETCH_HEAD && \
       ! git -C "$checkoutDirectory" merge-base --is-ancestor FETCH_HEAD "$targetBranch"; then
      echo "ERROR: $targetBranch in $checkoutDirectory has diverged from the remote." >&2
      echo "It may hold commits that exist nowhere else. Inspect and reconcile it" >&2
      echo "by hand: git -C '$checkoutDirectory' log --oneline --left-right FETCH_HEAD...$targetBranch" >&2
      exit 1
    fi
    git -C "$checkoutDirectory" checkout "$targetBranch"
    git -C "$checkoutDirectory" merge --ff-only FETCH_HEAD
  else
    git -C "$checkoutDirectory" checkout -b "$targetBranch" FETCH_HEAD
  fi
fi

# `pnpm install` runs the package's prepare script, which builds dist/. The
# packageManager pin decides the pnpm version, so invoke pnpm through the
# checkout rather than assuming the caller's pnpm matches.
cd "$checkoutDirectory"
pnpm install --frozen-lockfile

node dist/cli.js --version
