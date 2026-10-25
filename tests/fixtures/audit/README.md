# Captured dependency audit reports

These fixtures are trimmed real tool output, not example schemas. Each capture
has a `.meta.json` sidecar with its version, invocation, project input, exit code,
output channel, capture date and trimming notes. Tests mock only the subprocess
boundary and replay the recorded exit code and output through the audit runner.
No installed auditors or network access are needed to replay them.

The replay matrix covers Bun, pip-audit, NuGet, govulncheck and cargo audit.
Cargo captures use `cargo audit --json`; their reports retain the advisory
database commit and update date. The cargo failure project has a Cargo.lock with
an invalid version field; cargo audit creates a missing lockfile automatically.

- `vulnerable` retains named advisories and their package identities.
- `clean` means no findings at the invoked tool's scan level. In particular,
  govulncheck can print uncalled standard-library advisories without reporting a
  reachable vulnerability.
- `failure` records missing lockfiles, requirements or restored assets. A failure
  is incomplete even if its stdout looks like a report (govulncheck emits its
  config before failing). The pip-audit missing-file probe was invoked directly;
  aislop normally checks for requirements.txt before launching it.

Govulncheck `.json` files are streams of JSON objects, not single JSON documents.
Its older symbol-level fixture lives one directory above `audit/`, with a sidecar
that distinguishes original provenance from the exit status verified by recapture.

To refresh, create the input described in the sidecar in an isolated scratch
project, run any stated setup command, then invoke the recorded binary and
arguments in that project directory. Capture stdout, stderr and exit status
separately. Keep parser-relevant fields and representative findings, remove
machine-specific paths, and document every trim. Do not copy raw captures or logs
into the repository. Preserve parser mismatches as explicitly failing tests
rather than changing production parsing in a fixture-only update.
