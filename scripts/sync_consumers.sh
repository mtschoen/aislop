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
# When the pin-bump branch is absent or holds only pin-bump commits,
# update_consumer rebuilds it from the default branch and force-pushes; an
# already-open PR then has its title and body refreshed to match the new sha.
# When the branch holds any other commit (fixes added so the new pin passes
# the consumer's gate), it commits the new pin on top and pushes without
# --force, leaving the open PR's title and body alone. The run summary names
# the path ("rebuild" or "append") taken for each consumer.
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

refresh_open_pull_request() {
	# refresh_open_pull_request <repo> <base_branch> <title> <body>
	# Finds the open pull request whose head branch is BRANCH and base
	# branch is <base_branch>, then PATCHes its title and body to the given
	# values. Lists open PRs (paginated) and filters with jq instead of
	# relying on a by-base-head lookup endpoint, since the list+filter form
	# works on every Gitea version. Echoes the PR html_url on success.
	# Returns 1 if no matching PR is found or the PATCH does not succeed.
	local repo="$1" base_branch="$2" title="$3" body="$4"
	local list_file="$SCRATCH/open_prs.json"
	local page=1
	local limit=50
	local number=""
	local list_status count

	while :; do
		list_status="$(curl -sS -o "$list_file" -w '%{http_code}' -H "$auth_header" \
			"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/pulls?state=open&limit=$limit&page=$page")"
		if [ "$list_status" != "200" ]; then
			return 1
		fi

		count="$(jq -r 'if type == "array" then length else empty end' "$list_file" 2>/dev/null)" || return 1
		case "$count" in
		'' | *[!0-9]*) return 1 ;;
		esac
		[ "$count" -eq 0 ] && break

		number="$(jq -r --arg head "$BRANCH" --arg base "$base_branch" '[.[] | select(.head.ref == $head and .base.ref == $base)][0].number // empty' "$list_file" 2>/dev/null)" || return 1
		if [ -n "$number" ]; then
			break
		fi

		[ "$count" -lt "$limit" ] && break
		page=$((page + 1))
	done

	if [ -z "$number" ]; then
		return 1
	fi

	local patch_body patch_response patch_status
	patch_body="$(jq -n --arg title "$title" --arg body "$body" '{title: $title, body: $body}')"
	patch_response="$SCRATCH/pr_patch_response.json"
	patch_status="$(curl -sS -o "$patch_response" -w '%{http_code}' -X PATCH -H "$auth_header" -H "Content-Type: application/json" --data-binary "$patch_body" "$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/pulls/$number")"

	case "$patch_status" in
	200 | 201)
		jq -r '.html_url // empty' "$patch_response"
		return 0
		;;
	*)
		return 1
		;;
	esac
}

branch_has_only_pin_commits() {
	# branch_has_only_pin_commits <repo_dir> <default_branch>
	# Returns 0 when every commit reachable from origin/BRANCH but not from
	# origin/<default_branch> is a plain (non-merge) commit touching only
	# .aislop/fork-commit, or when there is no such commit. Returns 1 when
	# anything else is on the branch, 2 if history cannot be read.
	local repo_dir="$1" default_branch="$2"
	local range="origin/$default_branch..origin/$BRANCH"
	local merges commits commit files

	merges="$(git -C "$repo_dir" rev-list --min-parents=2 "$range")" || return 2
	[ -n "$merges" ] && return 1
	commits="$(git -C "$repo_dir" rev-list "$range")" || return 2
	for commit in $commits; do
		files="$(git -C "$repo_dir" diff-tree --no-commit-id --name-only -r --root "$commit")" || return 2
		[ "$files" = ".aislop/fork-commit" ] || return 1
	done
	return 0
}

update_consumer() {
	# update_consumer <repo> <default_branch> <clone_url>
	# Two paths, named in the run summary:
	#   rebuild: BRANCH is absent, or carries only pin-bump commits. Rebuild it
	#            from the default branch and force-push.
	#   append:  BRANCH carries any other commit (fixes added so the new pin
	#            passes the consumer's gate). Commit the pin on top of the
	#            existing tip and push WITHOUT --force; the open pull request's
	#            title and body are left alone.
	local repo="$1" branch="$2" clone_url="$3"
	local repo_dir="$SCRATCH/$repo"
	rm -rf "$repo_dir"

	local push_url
	push_url="$(authed_url "$clone_url")"

	if ! git clone --quiet --depth 1 --branch "$branch" "$push_url" "$repo_dir" >/dev/null 2>&1; then
		record "$repo" "failed" "clone of $branch failed"
		return 1
	fi

	local path="rebuild" remote_heads expected_branch_tip=""
	if ! remote_heads="$(git -C "$repo_dir" ls-remote --heads origin "refs/heads/$BRANCH" 2>/dev/null)"; then
		record "$repo" "failed" "could not look up $BRANCH on the remote"
		return 1
	fi
	if [ -n "$remote_heads" ]; then
		if [ "$(git -C "$repo_dir" rev-parse --is-shallow-repository)" = "true" ]; then
			git -C "$repo_dir" fetch --quiet --unshallow origin >/dev/null 2>&1 || {
				record "$repo" "failed" "could not fetch history of $branch"
				return 1
			}
		fi
		if ! git -C "$repo_dir" fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" >/dev/null 2>&1; then
			record "$repo" "failed" "could not fetch existing $BRANCH"
			return 1
		fi
		expected_branch_tip="$(git -C "$repo_dir" rev-parse "refs/remotes/origin/$BRANCH")"
		branch_has_only_pin_commits "$repo_dir" "$branch"
		case $? in
		0) path="rebuild" ;;
		1) path="append" ;;
		*)
			record "$repo" "failed" "could not inspect commits on $BRANCH"
			return 1
			;;
		esac
	fi

	local pin_commit_message="chore: bump aislop fork pin to $SHORT_SHA"
	local nothing_to_commit=0
	(
		cd "$repo_dir" || exit 1
		git config user.name claude-code
		git config user.email claude-code@noreply.sticktoitive.net
		if [ "$path" = "append" ]; then
			git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
		else
			git checkout --quiet -B "$BRANCH" "origin/$branch"
		fi
		mkdir -p .aislop
		printf '%s\n' "$NEW_SHA" >.aislop/fork-commit
		git add .aislop/fork-commit
		if [ "$path" = "append" ] && git diff --cached --quiet; then
			exit 3
		fi
		git commit --quiet -m "$pin_commit_message"
	)
	case $? in
	0) ;;
	3) nothing_to_commit=1 ;;
	*)
		record "$repo" "failed" "local commit failed"
		return 1
		;;
	esac

	if [ "$path" = "append" ]; then
		if [ "$nothing_to_commit" -eq 0 ] && ! git -C "$repo_dir" push --quiet "$push_url" "HEAD:refs/heads/$BRANCH" >/dev/null 2>&1; then
			record "$repo" "failed" "path=append: push to $BRANCH rejected (non-fast-forward or error), not retried with force"
			return 1
		fi
	elif ! git -C "$repo_dir" push --quiet --force-with-lease="refs/heads/$BRANCH:$expected_branch_tip" "$push_url" "HEAD:refs/heads/$BRANCH" >/dev/null 2>&1; then
		record "$repo" "failed" "path=rebuild: force-push to $BRANCH failed"
		return 1
	fi

	local pr_title pr_body_text pr_body pr_status pr_response
	pr_title="chore: bump aislop fork pin to $SHORT_SHA"
	pr_body_text="Automated update of .aislop/fork-commit to $NEW_SHA by sync-consumers."
	pr_body="$(jq -n --arg title "$pr_title" --arg head "$BRANCH" --arg base "$branch" --arg body "$pr_body_text" '{title: $title, head: $head, base: $base, body: $body}')"
	pr_response="$SCRATCH/pr_response.json"
	pr_status="$(curl -sS -o "$pr_response" -w '%{http_code}' -X POST \
		-H "$auth_header" -H "Content-Type: application/json" \
		--data-binary "$pr_body" \
		"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/pulls")"

	case "$pr_status" in
	200 | 201)
		record "$repo" "updated" "path=$path: PR opened ($(jq -r '.html_url // "no url"' "$pr_response"))"
		return 0
		;;
	409)
		if [ "$path" = "append" ]; then
			if [ "$nothing_to_commit" -eq 1 ]; then
				record "$repo" "updated" "path=append: $BRANCH already carries the new pin, nothing pushed, open PR left alone"
			else
				record "$repo" "updated" "path=append: pin commit pushed (fast-forward), open PR title/body left alone"
			fi
			return 0
		fi
		local refreshed_url
		if refreshed_url="$(refresh_open_pull_request "$repo" "$branch" "$pr_title" "$pr_body_text")"; then
			record "$repo" "updated" "path=rebuild: PR already open, force-push and title/body refreshed (${refreshed_url:-no url})"
			return 0
		fi
		record "$repo" "failed" "PR already open but title/body refresh failed"
		return 1
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
