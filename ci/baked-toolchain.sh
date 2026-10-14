#!/usr/bin/env bash
# Report which requested CI toolchains the fleet Linux runner image already
# carries at its manifest pin, so a workflow can skip the step that would
# download them (schoen-lab#3353).
#
# Usage: ci/baked-toolchain.sh TOOL... where each TOOL is node. It writes
# TOOL=true|false to $GITHUB_OUTPUT for each one. A baked node is also
# prepended to $GITHUB_PATH, as actions/setup-node would do. Outside the
# fleet image (no image.env, or an image built before node was baked) node
# reports false and the workflow's own setup step runs as before.
set -euo pipefail

image_env=${FLEET_IMAGE_ENV:-/usr/local/share/fleet-runner/image.env}
: "${GITHUB_OUTPUT:?}" "${GITHUB_PATH:?}"

if [[ -f "$image_env" ]]; then
  # shellcheck source=/dev/null
  source "$image_env"
fi

baked() {
  case "$1" in
    node)
      if [[ -z "${FLEET_NODE_VERSION:-}" ]]; then
        return 1
      fi
      local node_bin="/opt/fleet/node-${FLEET_NODE_VERSION}/bin"
      local output
      if ! output=$("$node_bin/node" --version 2> /dev/null); then
        return 1
      fi
      if [[ "$output" == "v$FLEET_NODE_VERSION" ]]; then
        printf '%s\n' "$node_bin" >> "$GITHUB_PATH" || return 1
        return 0
      fi
      return 1
      ;;
    *)
      printf 'unknown toolchain: %s\n' "$1" >&2
      exit 2
      ;;
  esac
}

if [[ $# -eq 0 ]]; then
  printf 'usage: %s TOOL...\n' "$0" >&2
  exit 2
fi
for tool in "$@"; do
  if baked "$tool"; then
    state=true
  else
    state=false
  fi
  printf '%s=%s\n' "$tool" "$state" >> "$GITHUB_OUTPUT"
  printf 'baked %s: %s\n' "$tool" "$state"
done
