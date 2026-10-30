#!/bin/sh
# Linux release builds: moves the binary's line tables into peetmail.debug (uploaded to
# Sentry and attached to the release, not shipped) and leaves a stripped binary with a
# link to it, before Tauri packs the binary into the AppImage. Sentry matches the two by
# the GNU build ID, which stripping keeps. Windows gets the same split from MSVC (the PDB).
#
# Run by tauri build as the beforeBundleCommand (see release.yml), with the release
# profile's `strip` turned off so there is debug info to move.
set -eu
dir="${CARGO_TARGET_DIR:-src-tauri/target}/release"
bin="$dir/peetmail"
[ -f "$bin" ] || { echo "split-debuginfo: $bin not found" >&2; exit 1; }
objcopy --only-keep-debug "$bin" "$dir/peetmail.debug"
objcopy --strip-debug --strip-unneeded --add-gnu-debuglink="$dir/peetmail.debug" "$bin"
echo "split-debuginfo: $(du -h "$dir/peetmail.debug" | cut -f1) of debug info moved out; binary now $(du -h "$bin" | cut -f1)"
