#!/usr/bin/env bash
# shellcheck disable=SC2154  # auth_header, SCRATCH and friends come from the sourcing script
# Label and guarded auto-merge for the pull requests a pin-bump fan-out opens
# or refreshes. Sourced by scripts/sync_consumers.sh.
#
# Every bump pull request gets the `auto-bump` label (created on first use),
# which marks it as opened by an automatic dependency bump so the review crew
# does not spend an LLM review on it. It also asks Gitea to merge it when
# checks succeed. Gitea merges IMMEDIATELY when the base branch has no
# required status checks, and merges as soon as the named checks pass when the
# list is exact names (others may still be pending). So auto-merge is requested
# only when the base branch has enable_status_check set and status_check_contexts
# contains the literal pattern "*"; otherwise it is skipped and the run summary
# says so. The branch is read via GET /branches/{branch}, which the bot can
# access (branch_protections needs admin).
#
# Nothing here is fatal to the fan-out: a failed label or merge call becomes a
# "warning" row in the summary. Needs record, auth_header, SCRATCH, GITEA_URL
# and GITEA_OWNER from the caller.

AUTO_BUMP_LABEL="auto-bump"
AUTO_BUMP_LABEL_COLOR="#0e8a16"
AUTO_BUMP_LABEL_DESCRIPTION="Opened by an automatic dependency bump; merges itself on green CI"

lookup_auto_bump_label_id() {
	# lookup_auto_bump_label_id <repo>: echo the id of the auto-bump label, or
	# nothing when the repo has no such label. Returns 1 on a transport failure.
	local repo="$1" page=1 limit=50 response status count label_id
	response="$SCRATCH/labels.json"
	while :; do
		status="$(curl -sS -o "$response" -w '%{http_code}' -H "$auth_header" \
			"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/labels?limit=$limit&page=$page")" || return 1
		[ "$status" = "200" ] || return 1
		count="$(jq -r 'if type == "array" then length else empty end' "$response" 2>/dev/null)" || return 1
		case "$count" in
		'' | *[!0-9]*) return 1 ;;
		esac
		[ "$count" -eq 0 ] && return 0
		label_id="$(jq -r --arg name "$AUTO_BUMP_LABEL" '[.[] | select(.name == $name)][0].id // empty' "$response")" || return 1
		if [ -n "$label_id" ]; then
			printf '%s' "$label_id"
			return 0
		fi
		[ "$count" -lt "$limit" ] && return 0
		page=$((page + 1))
	done
}

ensure_auto_bump_label_id() {
	# ensure_auto_bump_label_id <repo>: echo the label id, creating the label
	# when the repo does not have it yet.
	local repo="$1" label_id payload response status
	label_id="$(lookup_auto_bump_label_id "$repo")" || return 1
	if [ -n "$label_id" ]; then
		printf '%s' "$label_id"
		return 0
	fi
	payload="$(jq -cn --arg name "$AUTO_BUMP_LABEL" --arg color "$AUTO_BUMP_LABEL_COLOR" \
		--arg description "$AUTO_BUMP_LABEL_DESCRIPTION" \
		'{name: $name, color: $color, description: $description}')"
	response="$SCRATCH/label_create.json"
	status="$(curl -sS -o "$response" -w '%{http_code}' -X POST \
		-H "$auth_header" -H "Content-Type: application/json" \
		--data-binary "$payload" \
		"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/labels")" || return 1
	case "$status" in
	200 | 201) ;;
	*) return 1 ;;
	esac
	label_id="$(jq -r '.id // empty' "$response")"
	[ -n "$label_id" ] || return 1
	printf '%s' "$label_id"
}

apply_auto_bump_label() {
	# apply_auto_bump_label <repo> <number>: attach the label to the pull
	# request. Adding a label the issue already carries is a no-op.
	local repo="$1" number="$2" label_id payload status
	label_id="$(ensure_auto_bump_label_id "$repo")" || return 1
	payload="$(jq -cn --argjson id "$label_id" '{labels: [$id]}')"
	status="$(curl -sS -o "$SCRATCH/label_apply.json" -w '%{http_code}' -X POST \
		-H "$auth_header" -H "Content-Type: application/json" \
		--data-binary "$payload" \
		"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/issues/$number/labels")" || return 1
	case "$status" in
	200 | 201) return 0 ;;
	*) return 1 ;;
	esac
}

base_branch_requires_status_checks() {
	# base_branch_requires_status_checks <repo> <base_branch>: returns 0 when
	# the branch requires every status check (enable_status_check is true and
	# status_check_contexts contains the literal pattern "*"), 1 when it does
	# not, 2 when the branch cannot be read. An exact-name list is not enough:
	# Gitea auto-merges as soon as the named checks pass, while other checks may
	# still be pending. The branches endpoint is used because the bot cannot
	# read branch_protections (it needs admin).
	local repo="$1" base_branch="$2" response status encoded_branch required
	response="$SCRATCH/branch.json"
	encoded_branch="$(printf '%s' "$base_branch" | jq -sRr @uri)"
	status="$(curl -sS -o "$response" -w '%{http_code}' -H "$auth_header" \
		"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/branches/$encoded_branch")" || return 2
	[ "$status" = "200" ] || return 2
	required="$(jq -r 'if type == "object" then (if .enable_status_check == true and ((.status_check_contexts // []) | index("*")) != null then "yes" else "no" end) else "unreadable" end' \
		"$response" 2>/dev/null)" || return 2
	case "$required" in
	yes) return 0 ;;
	no) return 1 ;;
	*) return 2 ;;
	esac
}

schedule_auto_merge() {
	# schedule_auto_merge <repo> <number> <head_sha>: ask Gitea to squash-merge
	# the pull request's current head once all "*" checks pass. The payload keeps
	# head_commit_id for the direct-merge fallback, but Gitea ignores it when
	# scheduling auto-merge; the scheduled merge follows the current head.
	# Echoes the HTTP status on failure.
	local repo="$1" number="$2" head_sha="$3" payload status
	payload="$(jq -cn --arg head "$head_sha" \
		'{Do: "squash", merge_when_checks_succeed: true, delete_branch_after_merge: true, head_commit_id: $head}')"
	status="$(curl -sS -o "$SCRATCH/merge_schedule.json" -w '%{http_code}' -X POST \
		-H "$auth_header" -H "Content-Type: application/json" \
		--data-binary "$payload" \
		"$GITEA_URL/api/v1/repos/$GITEA_OWNER/$repo/pulls/$number/merge")" || status="curl-error"
	case "$status" in
	2??) return 0 ;;
	*)
		printf '%s' "$status"
		return 1
		;;
	esac
}

finalize_pull_request() {
	# finalize_pull_request <repo> <base_branch> <number> <head_sha>: label the
	# pull request and request guarded auto-merge. Always returns 0; problems
	# are recorded as a warning row.
	local repo="$1" base_branch="$2" number="$3" head_sha="$4"
	local notes="" guard_code merge_status

	if [ -z "$number" ]; then
		record "$repo" "warning" "could not read the pull request number, so no label or auto-merge"
		return 0
	fi

	if apply_auto_bump_label "$repo" "$number"; then
		notes="PR #$number labeled $AUTO_BUMP_LABEL"
	else
		notes="warning: could not apply label $AUTO_BUMP_LABEL to PR #$number"
	fi

	base_branch_requires_status_checks "$repo" "$base_branch"
	guard_code=$?
	case "$guard_code" in
	0)
		if merge_status="$(schedule_auto_merge "$repo" "$number" "$head_sha")"; then
			notes="$notes; auto-merge requested"
		else
			notes="$notes; warning: auto-merge request returned $merge_status"
		fi
		;;
	1) notes="$notes; auto-merge skipped: $base_branch does not require all status checks (*)" ;;
	*) notes="$notes; auto-merge skipped: could not read branch $base_branch" ;;
	esac

	case "$notes" in
	*warning:*) record "$repo" "warning" "$notes" ;;
	*) record "$repo" "auto-bump" "$notes" ;;
	esac
	return 0
}
