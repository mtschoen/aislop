# OSS Benchmarking

`aislop`'s false-positive pass is easiest to keep disciplined when the cohort is frozen and every iteration re-runs the exact same repos.

The benchmark harness in `tools/oss-benchmark.mjs` does two separate jobs:

1. Capture the current GitHub Trending top repos for each language into a cohort manifest.
2. Clone those repos into fresh directories, then run `aislop` against each one in an isolated worker with telemetry disabled and CI-style deterministic output.

## Default cohort

The default language set is the 7 supported Trending tracks we use for OSS validation:

- `typescript`
- `python`
- `go`
- `rust`
- `ruby`
- `php`
- `java`

Default limit is `10` repos per language.

## Scan command

Benchmark scans require Linux and Bubblewrap (`bwrap`) with unprivileged user namespaces enabled. The runner checks the sandbox before cloning and fails closed if it cannot start; it never falls back to a host scan. Capture-only commands do not require Bubblewrap.

Inside the worker, every scan uses:

```bash
/scanner/node /scanner/dist/cli.js scan /repo --json
```

The worker has a cleared environment, a private home and temporary directory, no network access, and read-only mounts of the repository and scanner runtime assets. It inherits no operator credentials and has no writable host mounts. Telemetry, history, update checks, and ANSI output are disabled. This boundary also covers executable project configurations such as Knip's, not just the scanner itself. Network-dependent audits and analyzers that need to write build outputs may be unavailable; inspect engine failures and notices when comparing results. Scans are bounded to five minutes and 64 MiB of captured output, with a 512 MiB temporary filesystem.

Manifest identities are validated against the supported language list and single-component GitHub owner/repository names. Clone URLs must be canonical GitHub HTTPS URLs, and pinned revisions must be full object IDs. Clone and report paths reject traversal and symlinked ancestors. Git runs without inherited credentials or user/system configuration. Each run allocates new checkout directories; it does not update or recursively delete old caches. Host path checks protect against malformed manifests and pre-existing link traps, not a hostile process concurrently rewriting paths as the same operating-system user.

## Workflow

Build first:

```bash
pnpm build
```

Capture a new frozen cohort:

```bash
pnpm bench:trending:capture
```

Run the latest frozen cohort as iteration 1:

```bash
pnpm bench:trending:run -- --iteration pass-1
```

Capture and run in one step:

```bash
pnpm bench:trending:cycle -- --iteration pass-1
```

Re-run the exact same cohort after rule fixes:

```bash
pnpm bench:trending:run -- --manifest tools/benchmark-data/cohorts/trending-daily-2026-05-29.json --iteration pass-2
pnpm bench:trending:run -- --manifest tools/benchmark-data/cohorts/trending-daily-2026-05-29.json --iteration pass-3
```

Run a smaller smoke test:

```bash
pnpm bench:trending:cycle -- --languages typescript,php --limit 1 --iteration smoke
```

## Output layout

Generated benchmark data is ignored by git and lands under `tools/benchmark-data/`:

- `cohorts/*.json`: frozen repo lists
- `repos/<language>/<owner>__<repo>-<unique>/checkout/`: fresh clones (retained for inspection; remove old runs manually when no benchmark is using them)
- `runs/<run-id>/summary.json`: machine-readable aggregate report
- `runs/<run-id>/summary.md`: human review report
- `runs/<run-id>/repos/.../scan.json`: raw per-repo scan JSON
- `runs/<run-id>/repos/.../stdout.txt`, `stderr.txt`, `metadata.json`: reproduction details

## Review loop

Use the report in this order:

1. Check failures first so the cohort is complete.
2. Check the lowest-score repos.
3. Check the highest-volume rules across many repos.
4. Open the per-repo `scan.json` files for likely false positives.
5. Fix the rules.
6. Re-run the same manifest as the next iteration.

Only refresh the cohort when you want a new market snapshot. For iteration work, keep the manifest stable.
