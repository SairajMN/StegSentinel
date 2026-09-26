#!/usr/bin/env bash
# Install the steganalysis tools the scorer shells out to. Runs once per fresh sandbox.
# Best effort: if a tool cannot be installed, the scorer still runs its pure-Python checks,
# and reports the gap in unavailable_tools rather than implying a full analysis.
#
# Everything is logged to $STEG_INSTALL_LOG so a failure can be diagnosed from the session
# log instead of guessed at.
set -u

LOG="${STEG_INSTALL_LOG:-/tmp/steg-install.log}"
: >"$LOG"
say() { printf '%s\n' "$*" >>"$LOG"; }
run() { say "\$ $*"; "$@" >>"$LOG" 2>&1; }

say "whoami=$(id -un 2>&1) uid=$(id -u 2>&1)"
command -v apt-get >>"$LOG" 2>&1 && say "apt-get: yes" || say "apt-get: no"
command -v gem >>"$LOG" 2>&1 && say "gem: $(gem --version 2>&1)" || say "gem: no"
command -v ruby >>"$LOG" 2>&1 && say "ruby: $(ruby --version 2>&1)" || say "ruby: no"

# The sandbox may not be root. sudo exists in some images but is unusable without a password,
# so probe it once rather than firing a doomed command at every step.
SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  SUDO="sudo -n"
fi
say "sudo: ${SUDO:-unavailable}"

have() { command -v "$1" >/dev/null 2>&1; }

install_pkgs() {
  if have apt-get; then
    run $SUDO apt-get update -qq
    run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif have apk; then
    run $SUDO apk add --no-cache "$@"
  elif have dnf; then
    run $SUDO dnf install -y -q "$@"
  elif have brew; then
    run brew install "$@"
  else
    say "no package manager found"
  fi
}

want=()
have exiftool || want+=(exiftool)
have pngcheck || want+=(pngcheck)
have binwalk  || want+=(binwalk)
[ ${#want[@]} -eq 0 ] || install_pkgs "${want[@]}"

# zsteg is a Ruby gem. No Ruby in the image means no zsteg; the scorer still reports it.
if ! have zsteg; then
  if have gem; then
    run $SUDO gem install --no-document zsteg
  else
    install_pkgs ruby ruby-dev build-essential
    have gem && run $SUDO gem install --no-document zsteg
  fi
fi

# steghide needs mcrypt, which is not packaged everywhere. Each attempt is independent.
if ! have steghide; then
  install_pkgs steghide || install_pkgs libmcrypt steghide || install_pkgs mcrypt steghide
fi

say "--- final ---"
for t in exiftool binwalk pngcheck zsteg steghide; do
  have "$t" && say "$t: ok ($(command -v "$t"))" || say "$t: MISSING"
done
exit 0
