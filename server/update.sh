#!/usr/bin/env bash
# Run by dueck-update.timer every 5 minutes. Pulls new server code from GitHub; if the server code
# changed, restarts the server, and if the new version doesn't start, goes straight back to the old one.
# Everything is inside main() so bash reads the whole script before git swaps this file out.
main() {
  set -uo pipefail
  local U="$DUECK_USER" C="$DUECK_CODE" B="${DUECK_BRANCH:-main}"
  g() { runuser -u "$U" -- git -C "$C" "$@"; }
  g fetch -q --depth 1 origin "$B" || { echo "Couldn't reach GitHub, will try again later."; return 0; }
  local old new
  old="$(g rev-parse HEAD)"; new="$(g rev-parse FETCH_HEAD)"
  [ "$old" = "$new" ] && return 0
  local BAD=/var/lib/dueck-bad-version
  if [ -f "$BAD" ] && [ "$(cat "$BAD")" = "$new" ]; then return 0; fi   # this version already failed once; wait for a fix
  local changed=0
  g diff --quiet "$old" "$new" -- server || changed=1
  g reset -q --hard "$new"
  echo "Updated code ${old:0:7} -> ${new:0:7}"
  [ "$changed" = 1 ] || return 0
  systemctl restart dueck-server
  local i
  for i in $(seq 1 20); do
    sleep 1
    if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then echo "Server restarted on the new version."; return 0; fi
  done
  echo "New version didn't start. Going back to ${old:0:7}."
  echo "$new" > "$BAD"
  g reset -q --hard "$old"
  systemctl restart dueck-server
}
main "$@"; exit $?
