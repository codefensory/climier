#!/usr/bin/env bash

set -euo pipefail

say_error() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

release_root="${CLIMIER_RELEASE_BASE_URL:-https://github.com/codefensory/climier/releases}"
release_root="${release_root%/}"

raw_os=$(uname -s 2>/dev/null || say_error "cannot detect the operating system")
case "$raw_os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT*)
    printf '%s\n' "install.sh: Windows is not supported by the v1 installer." >&2
    printf '%s\n' "Download the standalone binary manually from:" >&2
    printf '%s\n' "  $release_root/latest/download/climier-windows-x64.exe" >&2
    exit 1
    ;;
  *) say_error "unsupported operating system '$raw_os'; download a standalone binary manually" ;;
esac

raw_arch=$(uname -m 2>/dev/null || say_error "cannot detect the CPU architecture")
case "$raw_arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) say_error "unsupported CPU architecture '$raw_arch'; download a standalone binary manually" ;;
esac

platform="${os}-${arch}"
asset="climier-${platform}"
version="${CLIMIER_VERSION:-latest}"
if [ "$version" = "latest" ]; then
  release_path="latest"
else
  case "$version" in
    v*) release_path="$version" ;;
    *) release_path="v${version}" ;;
  esac
fi
if [ "$version" = "latest" ]; then
  release_url="$release_root/latest/download"
else
  release_url="$release_root/download/$release_path"
fi
binary_url="${CLIMIER_BINARY_URL:-$release_url/$asset}"
checksum_url="${CLIMIER_CHECKSUM_URL:-$release_url/SHA256SUMS}"
install_dir="${CLIMIER_INSTALL_DIR:-$HOME/.local/bin}"

command -v mktemp >/dev/null 2>&1 || say_error "mktemp is required"

download() {
  url=$1
  output=$2
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --output "$output" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --output-document="$output" "$url"
  else
    say_error "curl or wget is required to download release assets"
  fi
}

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/climier-install.XXXXXX")
staged_target=""
cleanup() {
  if [ -n "$staged_target" ]; then
    rm -f "$staged_target"
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

binary_file="$tmp_dir/$asset"
checksum_file="$tmp_dir/SHA256SUMS"
download "$binary_url" "$binary_file" || say_error "failed to download $binary_url"
download "$checksum_url" "$checksum_file" || say_error "failed to download checksum manifest $checksum_url"

expected=$(awk -v asset="$asset" '{ gsub(/\r$/, "", $2); if ($2 == asset || $2 == "*" asset) { print $1; exit } }' "$checksum_file")
expected=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
case "$expected" in
  ''|*[![:xdigit:]]*) say_error "checksum manifest has no valid SHA-256 entry for $asset" ;;
esac
if [ "${#expected}" -ne 64 ]; then
  say_error "checksum manifest has no valid SHA-256 entry for $asset"
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$binary_file" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$binary_file" | awk '{print $1}')
elif command -v openssl >/dev/null 2>&1; then
  actual=$(openssl dgst -sha256 "$binary_file" | awk '{print $NF}')
else
  say_error "sha256sum, shasum, or openssl is required to verify the release"
fi

actual=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')
if [ "$actual" != "$expected" ]; then
  say_error "checksum verification failed for $asset"
fi

mkdir -p "$install_dir"
target="$install_dir/climier"
staged_target="$install_dir/.climier.$$"
cp "$binary_file" "$staged_target"
chmod 0755 "$staged_target"
mv -f "$staged_target" "$target"
printf 'Installed climier to %s\n' "$target"
case ":${PATH:-}:" in
  *:"$install_dir":*) ;;
  *) printf 'Add %s to PATH to run climier.\n' "$install_dir" ;;
esac
