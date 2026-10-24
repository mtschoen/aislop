# Local and fleet deployment

Agents must read this entire document before linking a local build, refreshing
or diagnosing a fleet install, changing wrappers, or publishing the fork
package. It supplements [AGENTS.md](../AGENTS.md); it does not grant permission
to publish, promote, or merge without an explicit request in the current task.

## Running your build as the global aislop

To make the `aislop` command run a local checkout instead of the published npm
release:

```bash
pnpm build              # produce dist/
pnpm link --global      # repoint the global aislop at this checkout
aislop --version        # verify it resolves to your build
```

Writing worktrees live in sibling `~/aislop-worktrees/<task>` directories, one
per branch, not inside the checkout. `pnpm link --global` from a worktree points
the global command at that worktree's `dist/`, so rebuild after switching
branches. `origin` is upstream (`scanaislop/aislop`); `fork` is the personal fork
(`mtschoen/aislop`) with integration branch `schoen/main`. The default upstream
workflow remains branching from current `origin/develop` and targeting `develop`
unless the task explicitly says otherwise.

## Fleet machines: the per-user checkout

Each fleet machine resolves `aislop` to a checkout at `~/aislop` owned by the
interactive user. Refresh it as that user:

```bash
scripts/update-local-checkout.sh    # fetch schoen/main, install, rebuild dist/
```

The [refresh script](../scripts/update-local-checkout.sh) honors `AISLOP_HOME`
(default `~/aislop`) and bootstraps the checkout by cloning from Gitea when it
is absent. It runs on Linux and Windows under Git Bash. Installation runs the
package's prepare build; its package-manager pin selects pnpm.

Nothing refreshes a machine install on its own.
[`sync-consumers.yml`](../.gitea/workflows/sync-consumers.yml) bumps consumer
repository pins (`.aislop/fork-commit`) and touches nothing else, so a checkout
moves only when someone runs the script above. A wrapper or note claiming
otherwise is wrong. A stale shared install once left runtime hooks grading
against an old rule set while CI enforced the pinned one. Consumer CI was
unaffected because every consumer gate builds the fork at its pinned commit in
an ephemeral workspace. `aislop doctor` reports this comparison as its `Fork pin`
row when the repository carries a pin.

Every build stamps `dist/build-info.json` with the commit it was built from:
`{"version", "commit", "builtAt"}`. The commit is null when unavailable (for
example, an npm source tarball without Git); a valid `COMMIT` environment
override can supply it. External tooling reads the file to identify the actual
running build without spawning the CLI. Hand-refreshed installs are a standing
staleness risk; this provenance makes drift detectable. See
[`tsdown.config.ts`](../tsdown.config.ts) and
[`src/utils/build-info.ts`](../src/utils/build-info.ts).

## Ownership, package layout, and wrappers

**The account that installs a checkout must be the account that runs aislop
from it.** pnpm hard-links package files out of its content-addressable store.
On NTFS a hard link shares one ACL with its store file, so installing out of a
different account's store yields `node_modules` entries the running user cannot
read. This is also why the checkout keeps pnpm's default isolated layout: the
junction farm traverses correctly when owner and runner match.
`node-linker=hoisted` would not change the hard-link ACL behavior causing
cross-account failures. Do not substitute a machine-shared install.

Put `aislop` on PATH by copying both wrappers from `scripts/wrappers/` to a PATH
directory. Windows needs both halves:

- [`aislop.cmd`](../scripts/wrappers/aislop.cmd) serves cmd and PowerShell.
- The extensionless [`aislop`](../scripts/wrappers/aislop) serves Git Bash,
  which does not apply `PATHEXT` and cannot see a `.cmd` file.

Either wrapper honors `AISLOP_HOME` to select a different checkout. Keep the
repository wrappers rather than hand-written copies that can hide a stale
install or incorrectly describe refresh behavior.

## Internal registry publication

To publish the fork build as `@schoen/aislop` to the internal Gitea npm registry
(for consumer repositories installing it as a normal dependency), run
[`scripts/publish-gitea.ps1`](../scripts/publish-gitea.ps1) from a machine on the
internal network. Bump `version` in `package.json` first; the registry rejects an
already-published version. Publication still requires explicit task permission.
Verify installation in a clean temporary environment before reporting a
published package as working.
