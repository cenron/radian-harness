#!/bin/bash
# Disposable native filesystem/Git probes, not a production worker sandbox.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]] || [[ ! -x /usr/bin/sandbox-exec ]]; then
  printf 'SKIP: requires macOS and sandbox-exec\n'
  exit 77
fi

developer_dir=$(/usr/bin/xcode-select -p)
git_bin="$developer_dir/usr/bin/git"
if [[ ! -x "$git_bin" ]]; then
  printf 'SKIP: requires Git in the selected Apple developer toolchain\n'
  exit 77
fi
case "$developer_dir" in
  *\"*|*\\*|*$'\n'*) printf 'Unsupported toolchain path for this probe profile\n'; exit 1 ;;
esac

root=$(mktemp -d /tmp/radian-feasibility.XXXXXX)
root=$(cd "$root" && pwd -P)
printf 'owned disposable fixture\n' > "$root/.fixture-owner"
success=0
cleanup() {
  if [[ "$success" == 1 && "${RADIAN_KEEP_FIXTURE:-0}" != 1 ]]; then
    case "$root" in
      /private/tmp/radian-feasibility.*)
        [[ -f "$root/.fixture-owner" ]] && rm -rf -- "$root" ;;
    esac
  else
    printf 'Fixture retained outside repository for diagnosis.\n'
    printf '%s\n' "$root" > /tmp/radian-last-feasibility-fixture
  fi
}
trap cleanup EXIT

mkdir -p "$root/repo" "$root/evidence" "$root/protected" "$root/home" "$root/resources" "$root/unrelated" "$root/other-task"
printf 'synthetic unrelated data\n' > "$root/unrelated/private.txt"
printf 'synthetic credential\n' > "$root/protected/credential.txt"
printf 'synthetic coordinator policy\n' > "$root/resources/policy.txt"
printf 'synthetic other task\n' > "$root/other-task/input.txt"

# Discard inherited credentials and user/global Git configuration for fixture setup.
fixture_git() {
  env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$root/home" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    "$git_bin" -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"
}
fixture_git -C "$root/repo" init -q -b main
fixture_git -C "$root/repo" config user.name Fixture
fixture_git -C "$root/repo" config user.email fixture@example.com
printf 'original\n' > "$root/repo/tracked.txt"
fixture_git -C "$root/repo" add tracked.txt
fixture_git -C "$root/repo" commit -q -m fixture
fixture_git -C "$root/repo" worktree add -q -b worker "$root/worker"
printf 'changed\n' > "$root/worker/tracked.txt"
ln -s ../protected/credential.txt "$root/worker/credential-link"
ln -s ../repo/.git/config "$root/worker/git-config-link"
ln -s ../unrelated/private.txt "$root/worker/unrelated-link"
ln -s ../resources/policy.txt "$root/worker/policy-link"
ln -s ../other-task/input.txt "$root/worker/other-task-link"

# Synthetic helpers deliberately placed in shared metadata. Controlled Git must
# not invoke them. They touch only the disposable evidence directory.
cat > "$root/repo/.git/hooks/pre-commit" <<EOF
#!/bin/sh
printf 'executed\n' > "$root/evidence/hook-executed"
EOF
cp "$root/repo/.git/hooks/pre-commit" "$root/repo/.git/hooks/post-merge"
cat > "$root/repo/.git/fixture-fsmonitor" <<EOF
#!/bin/sh
printf 'executed\n' > "$root/evidence/fsmonitor-executed"
EOF
chmod +x "$root/repo/.git/hooks/pre-commit" "$root/repo/.git/hooks/post-merge" "$root/repo/.git/fixture-fsmonitor"
fixture_git -C "$root/repo" config core.fsmonitor "$root/repo/.git/fixture-fsmonitor"
cp "$root/repo/.git/config" "$root/evidence/original-git-config"
cp "$root/repo/.git/refs/heads/main" "$root/evidence/original-main-ref"

cat > "$root/probe.sb" <<EOF
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
; Metadata permission is broad for path traversal; file CONTENT reads are scoped.
(allow file-read-metadata)
(allow file-read* (literal "/") (literal "/private") (literal "/private/tmp"))
(allow file-read* (subpath "$developer_dir"))
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library"))
(allow file-read* (subpath "$root/worker") (subpath "$root/evidence") (subpath "$root/home") (subpath "$root/resources") (subpath "$root/repo/.git"))
(allow file-read* (literal "$root/probe.sh") (literal "/dev/null"))
(allow file-write* (subpath "$root/worker") (subpath "$root/evidence") (subpath "$root/home"))
(deny file-write* (literal "$root/worker/.git"))
(allow file-write* (literal "/dev/null"))
EOF

cat > "$root/probe.sh" <<'EOF'
#!/bin/sh
set -u
root=$1
git_bin=$2
failures=0
check() {
  label=$1; expected=$2; shift 2
  if "$@" >/dev/null 2>&1; then actual=allow; else actual=deny; fi
  if [ "$actual" = "$expected" ]; then
    printf 'PASS %s (%s)\n' "$label" "$actual"
  else
    printf 'FAIL %s (expected %s, got %s)\n' "$label" "$expected" "$actual"
    failures=$((failures+1))
  fi
}
controlled_git() {
  "$git_bin" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.ext.allow=never "$@"
}
check task_read allow /bin/cat "$root/worker/tracked.txt"
check task_write allow /bin/sh -c 'printf allowed > "$1"' sh "$root/worker/output.txt"
check evidence_write allow /bin/sh -c 'printf evidence > "$1"' sh "$root/evidence/check.txt"
check policy_read allow /bin/cat "$root/resources/policy.txt"
check policy_write deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/resources/policy.txt"
check credential_read deny /bin/cat "$root/protected/credential.txt"
check unrelated_read deny /bin/cat "$root/unrelated/private.txt"
check other_task_read deny /bin/cat "$root/other-task/input.txt"
check credential_symlink_read deny /bin/cat "$root/worker/credential-link"
check unrelated_symlink_read deny /bin/cat "$root/worker/unrelated-link"
check other_task_symlink_read deny /bin/cat "$root/worker/other-task-link"
check policy_symlink_write deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/worker/policy-link"
check shared_git_config_write deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/repo/.git/config"
check shared_git_config_symlink_write deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/worker/git-config-link"
check shared_hook_write deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/repo/.git/hooks/pre-commit"
check target_ref_write deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/repo/.git/refs/heads/main"
check worktree_git_pointer_write deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/worker/.git"
check child_inherits_read_deny deny /bin/sh -c '/bin/cat "$1"' sh "$root/protected/credential.txt"
check child_inherits_write_deny deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/other-task/output.txt"
check git_status allow controlled_git -C "$root/worker" status --porcelain
check git_diff allow /bin/sh -c '"$3" -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$1" diff --no-ext-diff --no-textconv --binary > "$2"' sh "$root/worker" "$root/evidence/change.patch" "$git_bin"
check git_log allow controlled_git -C "$root/worker" log -1 --format=%s
check worker_git_add deny controlled_git -C "$root/worker" add tracked.txt
check worker_git_commit deny controlled_git -C "$root/worker" commit --allow-empty -m forbidden
check worker_git_config deny controlled_git -C "$root/worker" config core.hooksPath "$root/worker"
check worker_git_update_ref deny controlled_git -C "$root/worker" update-ref refs/heads/main HEAD
check worker_git_new_branch deny controlled_git -C "$root/worker" branch forbidden
check metadata_sentinel_add deny /bin/sh -c 'printf forbidden > "$1"' sh "$root/repo/.git/new-file"
check hook_not_executed allow /bin/test ! -e "$root/evidence/hook-executed"
check fsmonitor_not_executed allow /bin/test ! -e "$root/evidence/fsmonitor-executed"
check metadata_config_unchanged allow /usr/bin/cmp "$root/repo/.git/config" "$root/evidence/original-git-config"
check target_ref_unchanged allow /usr/bin/cmp "$root/repo/.git/refs/heads/main" "$root/evidence/original-main-ref"
exit "$failures"
EOF

(cd "$root/worker" && env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$root/home" \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  /usr/bin/sandbox-exec -f "$root/probe.sb" /bin/sh "$root/probe.sh" "$root" "$git_bin")

# Controlled coordinator operation applies a patch and commits. This is fixture
# Git only: no execution of candidate build/test code and no user checkout access.
fixture_git -C "$root/repo" apply --check "$root/evidence/change.patch"
fixture_git -C "$root/repo" apply "$root/evidence/change.patch"
fixture_git -C "$root/repo" add tracked.txt
fixture_git -C "$root/repo" commit -q -m 'controlled fixture integration'
[[ ! -e "$root/evidence/hook-executed" && ! -e "$root/evidence/fsmonitor-executed" ]]
printf 'PASS controlled_patch_apply_commit_without_helpers\n'
success=1
printf 'PASS native scoped-read/Git feasibility suite\n'
