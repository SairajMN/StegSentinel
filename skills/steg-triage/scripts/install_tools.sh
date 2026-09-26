#!/usr/bin/env bash
# Install the steganalysis tools the scorer shells out to. Runs once per fresh sandbox.
# Best effort: if a tool cannot be installed, the scorer still runs its pure-Python checks.
set -u

have() { command -v "$1" >/dev/null 2>&1; }

install_pkgs() {
  # shellcheck disable=SC2086
  if have apt-get; then
    (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $1) >/dev/null 2>&1
  elif have apk; then
    apk add --no-cache $1 >/dev/null 2>&1
  elif have dnf; then
    dnf install -y -q $1 >/dev/null 2>&1
  elif have brew; then
    brew install $1 >/dev/null 2>&1
  fi
}

want=()
have exiftool || want+=(exiftool)
have pngcheck || want+=(pngcheck)
have binwalk  || want+=(binwalk)
[ ${#want[@]} -eq 0 ] || install_pkgs "${want[@]}"

# zsteg is a Ruby gem; steghide needs mcrypt, which is not packaged everywhere, so each is
# attempted on its own and a failure is not fatal.
have zsteg || gem install --no-document zsteg >/dev/null 2>&1
have steghide || install_pkgs steghide
have steghide || install_pkgs libmcrypt steghide

exit 0
