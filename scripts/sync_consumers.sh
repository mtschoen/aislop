#!/usr/bin/env bash
# Fan out an aislop fork-commit pin bump to every consumer repository on the
# fleet Gitea instance. Invoked by .gitea/workflows/sync-consumers.yml after
# a push to schoen/main.
#
# Required one-time setup (not performed by this script): create an Actions
# secret named AISLOP_SYNC_TOKEN on this repository holding a Gitea personal
# access token for the claude-code bot, scoped at least write:repository and
# read:repository. claude-code must also be a write collaborator on every
# consumer repository this script updates, or repos/search will not surface
# private ones and the push/PR-create calls below will 403.
#
# Convention: a consumer repo opts in by carrying a file
# .aislop/fork-commit on its default branch containing exactly the 40-char
# sha of the aislop fork commit its CI is pinned to. A repo without that
# file is not a consumer and is skipped silently.
#
# Usage: sync_consumers.sh <new-sha>
# Required env: GITEA_TOKEN
# Optional env: GITEA_URL (default https://gitea.fleet.sticktoitive.net),
#               GITEA_OWNER (default schoen), SELF_REPO (default aislop)

set -u
set -o pipefail

NEW_SHA="${1:?usage: sync_consumers.sh <new-sha>}"
GITEA_URL="${GITEA_URL:-https://gitea.fleet.sticktoitive.net}"
GITEA_OWNER="${GITEA_OWNER:-schoen}"
SELF_REPO="${SELF_REPO:-aislop}"
: "${GITEA_TOKEN:?GITEA_TOKEN env var is required}"

for tool in curl git jq base64; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "sync_consumers.sh: required tool '$tool' not found on PATH" >&2
		exit 1
	fi
done

BRANCH="chore/aislop-pin-bump"
SHORT_SHA="${NEW_SHA:0:12}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

auth_header="Authorization: token $GITEA_TOKEN"
attempted=0
failed=0
declare -a SUMMARY

record() {
	# record <repo> <result> <detail>. Never pass a credential-bearing URL
	# here; detail lines get printed in the workflow log.
	SUMMARY+=("$(printf '%-28s %-18s %s' "$1" "$2" "$3")")
}

authed_url() {
	# authed_url <clone_url>: embed claude-code:GITEA_TOKEN as basic-auth
	# credentials in a git-smart-HTTP URL. The REST API accepts an
	# `Authorization: token` header, but that is an API-only convention;
	# git's own HTTP transport wants credentials in the URL (or a
	# credential helper), so clone/push use this form instead.
	local url="$1"
	local scheme="${url%%://*}"
	local rest="${url#*://}"
	printf '%s://claude-code:%s@%s' "$scheme" "$GITEA_TOKEN" "$rest"
}

resolve_owner_uid() {
	local body
	body="$(curl -sSf -H "$auth_header" "$GITEA_URL/api/v1/users/$GITEA_OWNER")" || return 1
	printf '%s' "$body" | jq -r '.id // empty'
}

list_consumer_candidates() {
	# Print "name<TAB>default_branch<TAB>clone_url" for every repo owned by
	# GITEA_OWNER, paginating repos/search until a short page is returned.
	local page=1
	local limit=50
	while :; do
		local body
		body="$(curl -sSf -H "$auth_header" \
			"$GITEA_URL/api/v1/repos/search?uid=$OWNER_UID&exclusive=true&limit=$limit&page=$page")" || return 1
		local count
		count="$(printf '%s' "$body" | jq -r '.data | length // empty' 2>/dev/null)" || return 1
		case "$count" in
		'' | *[!0-9]*) return 1 ;;
		esac
		[ "$count" -eq 0 ] && break
		printf '%s' "$body" | jq -r '.data[] | [.name, .default_branch, .clone_url] | @tsv' || return 1
		[ "$count" -lt "$limit" ] && break
		page=$((page + 1))
	done
}

fetch_current_pin() {
	# fetch_current_pin <repo> <default_branch>
	# Echoes the current pinned sha and returns 0, or returns 2 if the repo
	# is not a consumer (no .aislop/fork-commit file), or 1 on any other
	# fetch failure.
	local repo="$1" branch="$2"
	local body_file="$SCRATCH/contents.json"
	local status
	status="$(curl -sS -o "$body_file" -w '%{http_code}' -H "$auth_header" \
		"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/contents/.aislop/fork-commit?ref=$branch")"
	if [ "$status" = "404" ]; then
		return 2
	fi
	if [ "$status" != "200" ]; then
		return 1
	fi
	jq -r '.content' "$body_file" | tr -d '\n' | base64 -d | tr -d '[:space:]'
}

update_consumer() {
	# update_consumer <repo> <default_branch> <clone_url>
	local repo="$1" branch="$2" clone_url="$3"
	local repo_dir="$SCRATCH/$repo"
	rm -rf "$repo_dir"

	local push_url
	push_url="$(authed_url "$clone_url")"

	if ! git clone --quiet --depth 1 --branch "$branch" "$push_url" "$repo_dir" >/dev/null 2>&1; then
		record "$repo" "failed" "clone of $branch failed"
		return 1
	fi

	(
		cd "$repo_dir" || exit 1
		git config user.name claude-code
		git config user.email claude-code@noreply.sticktoitive.net
		git checkout --quiet -b "$BRANCH"
		mkdir -p .aislop
		printf '%s\n' "$NEW_SHA" >.aislop/fork-commit
		git add .aislop/fork-commit
		git commit --quiet -m "chore: bump aislop fork pin to $SHORT_SHA"
	) || {
		record "$repo" "failed" "local commit failed"
		return 1
	}

	if ! git -C "$repo_dir" push --quiet --force "$push_url" "HEAD:refs/heads/$BRANCH" >/dev/null 2>&1; then
		record "$repo" "failed" "force-push to $BRANCH failed"
		return 1
	fi

	local pr_body pr_status pr_response
	pr_body="$(jq -n --arg title "chore: bump aislop fork pin to $SHORT_SHA" \
		--arg head "$BRANCH" --arg base "$branch" \
		--arg body "Automated update of .aislop/fork-commit to $NEW_SHA by sync-consumers." \
		'{title: $title, head: $head, base: $base, body: $body}')"
	pr_response="$SCRATCH/pr_response.json"
	pr_status="$(curl -sS -o "$pr_response" -w '%{http_code}' -X POST \
		-H "$auth_header" -H "Content-Type: application/json" \
		--data-binary "$pr_body" \
		"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/pulls")"

	case "$pr_status" in
	200 | 201)
		record "$repo" "updated" "PR opened ($(jq -r '.html_url // "no url"' "$pr_response"))"
		return 0
		;;
	409)
		record "$repo" "updated" "PR already open, force-push refreshed it"
		return 0
		;;
	*)
		record "$repo" "failed" "PR create returned $pr_status"
		return 1
		;;
	esac
}

process_repo() {
	local repo="$1" branch="$2" clone_url="$3"
	[ "$repo" = "$SELF_REPO" ] && return 0

	local current_sha
	current_sha="$(fetch_current_pin "$repo" "$branch")"
	local rc=$?
	if [ "$rc" -eq 2 ]; then
		return 0 # not a consumer, skip silently
	fi
	if [ "$rc" -ne 0 ]; then
		attempted=$((attempted + 1))
		failed=$((failed + 1))
		record "$repo" "failed" "could not read .aislop/fork-commit"
		return 0
	fi
	if [ "$current_sha" = "$NEW_SHA" ]; then
		record "$repo" "skipped" "already pinned to $SHORT_SHA"
		return 0
	fi

	attempted=$((attempted + 1))
	if ! update_consumer "$repo" "$branch" "$clone_url"; then
		failed=$((failed + 1))
	fi
}

if ! OWNER_UID="$(resolve_owner_uid)" || [ -z "$OWNER_UID" ]; then
	echo "sync_consumers.sh: could not resolve a Gitea user id for owner '$GITEA_OWNER'" >&2
	exit 1
fi

if ! candidates="$(list_consumer_candidates)"; then
	echo "sync_consumers.sh: failed to list consumer candidate repositories from Gitea" >&2
	exit 1
fi
if [ -z "$candidates" ]; then
	echo "sync_consumers.sh: repos/search returned no repos for owner $GITEA_OWNER" >&2
	exit 1
fi

while IFS=$'\t' read -r name default_branch clone_url; do
	[ -z "$name" ] && continue
	process_repo "$name" "$default_branch" "$clone_url"
done <<<"$candidates"

echo
echo "sync-consumers summary for sha $NEW_SHA:"
printf '%-28s %-18s %s\n' "REPO" "RESULT" "DETAIL"
for row in "${SUMMARY[@]}"; do
	echo "$row"
done

if [ "$attempted" -gt 0 ] && [ "$failed" -eq "$attempted" ]; then
	echo "sync_consumers.sh: every attempted repo ($attempted) failed" >&2
	exit 1
fi

exit 0
