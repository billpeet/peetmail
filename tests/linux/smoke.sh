#!/bin/sh
# Starts a Linux AppImage on a virtual display with a throwaway home folder and checks it
# comes up: the window opens, the database is created, sync and the health checks run.
# Release builds have no test knobs (src-tauri/src/testenv.rs), so this is the only check
# that the shipped AppImage itself starts. CI runs it on every release build.
#
#   sh tests/linux/smoke.sh path/to/PeetMail_x.y.z_amd64.AppImage
#
# Needs xvfb-run and dbus-run-session (packages xvfb, dbus-x11 / dbus).
set -eu
app="$(realpath "$1")"
home="$(mktemp -d)"
pid=""
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null || true; rm -rf "$home"' EXIT
chmod +x "$app"
logs="$home/.local/share/com.peetsoftware.peetmail/logs"

# CI machines and containers have no FUSE; the runtime unpacks itself instead.
HOME="$home" XDG_DATA_HOME= XDG_CONFIG_HOME= XDG_CACHE_HOME= APPIMAGE_EXTRACT_AND_RUN=1 \
  dbus-run-session -- xvfb-run -a -s "-screen 0 1280x900x24" "$app" >"$home/stdout.log" 2>&1 &
pid=$!

for _ in $(seq 1 90); do
  if grep -qs "health: checked" "$logs"/*.log; then
    if kill -0 "$pid" 2>/dev/null; then
      echo "smoke: PeetMail started"
      grep -h "INFO\|WARN\|ERROR" "$logs"/*.log | head -20
      [ -f "$home/.local/share/com.peetsoftware.peetmail/peetmail.db" ] || { echo "smoke: no database" >&2; exit 1; }
      exit 0
    fi
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done

echo "smoke: PeetMail didn't come up" >&2
echo "--- stdout/stderr" >&2; tail -50 "$home/stdout.log" >&2 || true
echo "--- log" >&2; cat "$logs"/*.log >&2 2>/dev/null || true
exit 1
