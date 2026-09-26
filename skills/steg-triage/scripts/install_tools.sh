#!/usr/bin/env bash
# Install the steganalysis tools the scorer shells out to. Runs once per fresh sandbox.
# Best effort: if a tool cannot be installed, the scorer still runs its pure-Python checks,
# and reports the gap in unavailable_tools rather than implying a full analysis.
#
# Everything is logged to $STEG_INSTALL_LOG so a failure can be diagnosed from the session
# log instead of guessed at.
set -u

LOG="${STEG_INSTALL_LOG:-/tmp/steg-install.log}"
[ -f "$LOG" ] || : >"$LOG" 2>/dev/null
say() { printf '%s\n' "$*" >>"$LOG"; }
run() { say "\$ $*"; "$@" >>"$LOG" 2>&1; }

say "whoami=$(id -un 2>&1) uid=$(id -u 2>&1)"
command -v apt-get >>"$LOG" 2>&1 && say "apt-get: yes" || say "apt-get: no"
command -v gem >>"$LOG" 2>&1 && say "gem: $(gem --version 2>&1)" || say "gem: no"
command -v ruby >>"$LOG" 2>&1 && say "ruby: $(ruby --version 2>&1)" || say "ruby: no"

# A turn triages several files back to back, so the install must not repeat per file. The marker
# records success only, and is written at the end rather than before: a first file killed
# mid-install (exec timeout) would otherwise leave the marker behind, and every later file would
# skip installing and report all five tools as missing.
MARKER="${LOG}.done"
[ -f "$MARKER" ] && exit 0

have() { command -v "$1" >/dev/null 2>&1; }

# The install runs as whatever user the sandbox gives us; apt needs root or passwordless sudo,
# and neither is assumed.
SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  SUDO="sudo -n"
fi
say "sudo: ${SUDO:-unavailable}"

want=()
have exiftool || want+=(exiftool)
have pngcheck || want+=(pngcheck)
have binwalk  || want+=(binwalk)

# One apt run for everything, then one lock-protected pass for the rest. Triage may be called
# on several files in the same turn, and a previous run can still be holding the apt lock
# ("Could not get lock /var/lib/apt/lists/lock") — serialise on our own lock file and wait.
with_lock() {
  local waited=0
  until mkdir /tmp/.steg-apt-lock 2>/dev/null; do
    say "apt lock busy (wait ${waited}s)"
    [ "$waited" -ge 120 ] && { say "gave up waiting for apt lock"; rm -rf /tmp/.steg-apt-lock; return 1; }
    sleep 3
    waited=$((waited + 3))
  done
  "$@"
  local status=$?
  rmdir /tmp/.steg-apt-lock 2>/dev/null
  return $status
}

apt_install() {
  if have apt-get; then
    $SUDO apt-get update -qq
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  else
    say "apt-get unavailable; cannot install: $*"
    return 1
  fi
}

if [ ${#want[@]} -gt 0 ]; then
  with_lock apt_install "${want[@]}"
fi

# zsteg is a Ruby gem. No Ruby in the image means no zsteg; the scorer still reports it.
if ! have zsteg; then
  if ! have gem; then
    with_lock apt_install ruby ruby-dev build-essential
  fi
  have gem && run gem install --no-document zsteg
fi

# steghide needs mcrypt, which is not in Debian's default index. One attempt, no retry storm.
have steghide || with_lock apt_install steghide

say "--- final ---"
ok=0
for t in exiftool binwalk pngcheck zsteg steghide; do
  if have "$t"; then
    say "$t: ok ($(command -v "$t"))"
    ok=$((ok + 1))
  else
    say "$t: MISSING"
  fi
done
# Only mark the sandbox as provisioned when the tools that can be installed actually arrived.
# steghide needs mcrypt, which is absent from Debian's index, so it is excluded deliberately.
if [ "$ok" -ge 4 ]; then
  touch "$MARKER" 2>/dev/null
  say "provisioned: $ok/4 core tools present"
else
  say "provisioning incomplete: $ok/4 — a later run will retry"
fi
exit 0
