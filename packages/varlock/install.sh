#!/bin/sh

# NOTE - https://varlock.dev/install.sh redirects to this file on github
# so can be used to install by running `curl -sSfL https://varlock.dev/install.sh | sh -s`

set -e

GITHUB_URL="https://github.com/dmno-dev/varlock"
GITHUB_RELEASES_URL="${GITHUB_URL}/releases"
HOMEBREW_FORMULA_URL="https://raw.githubusercontent.com/dmno-dev/homebrew-tap/refs/heads/main/Formula/varlock.rb"

OS=""
ARCH=""
VERSION=""
LATEST_VERSION=""

usage() {
    require_cmd cat
    this=$1
    cat 1>&2 <<EOF
$this: download + install binary for varlock

USAGE:
    $this [FLAGS] [OPTIONS] <tag>

FLAGS:
    -h, --help      Prints help information

OPTIONS:
    -b, --bindir <DIR_PATH>     Sets bindir or installation directory. Defaults to ./bin

ARGS:
    <version>       is a specific varlock version from ${GITHUB_RELEASES_URL}. (defaults to latest)
EOF
    exit 2
}

parse_args() {
  BINDIR=${BINDIR:-./bin}
  while [ "$#" -gt 0 ]; do
    case $1 in
      -h|--help)
        usage "$0"
        # shellcheck disable=SC2317
        shift # past argument
      ;;
      -b|--bindir)
        BINDIR="$2"
        shift # past argument
        shift # past value
      ;;
      *) VERSION=$1
        shift # past argument
      ;;
    esac
  done
}

# Returns 0 if $1 is a valid semantic version. For example 1.0.0
check_semver() {
  echo "$1" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' > /dev/null
}

# Returns 0 if $1 is a valid semantic version prefixed by v. For example v1.0.0
# Otherwise it calls err
check_requested_version() {
  if check_semver "$1"; then
    return 0;
  fi
  err "Invalid version '$1' - must be a valid semantic version (for example '1.2.3')"
}

get_varlock_latest_version() {
  # fetching the latest version number from the hombrew formula
  # this keeps things in sync, and means we dont have to parse release info JSON from github
  # (we cannot use "latest" because we have multiple packages being released from our monorepo)
  local homebrew_tap_src=""
  if cmd_exists curl; then
    homebrew_tap_src=$(curl -sSfL "$HOMEBREW_FORMULA_URL")
  elif cmd_exists wget; then
    homebrew_tap_src=$(wget -q "$HOMEBREW_FORMULA_URL")
  else
    err "Unable to find download command. Either 'curl' or 'wget' is required."
  fi

  # we could push this version number to an additional file, but this is simple enough
  local version_regex="  version \"([^\"]+)\""
  if [[ "$homebrew_tap_src" =~ $version_regex ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    err "Unable to find latest varlock version number"
  fi
}
main() {
  parse_args "$@"

  require_cmd uname
  require_cmd mktemp
  require_cmd grep
  require_cmd rm
  
  get_architecture || return 1

  case $OS in
    win-*) _ext=".zip" ;;
    *) _ext=".tar.gz" ;;
  esac

  _archive_name="varlock-${OS}-${ARCH}${_ext}"

  if [ -z "${VERSION}" ]; then
    VERSION=$(get_varlock_latest_version)
    println "The latest version (${VERSION}) will be installed."
  else
    check_requested_version "${VERSION}"
    println "Version ${VERSION} will be installed"
  fi
  _url="${GITHUB_RELEASES_URL}/download/varlock@${VERSION}/${_archive_name}"

  # Installation
  _temp_dir=$(mktemp -d)
  _archive_path="${_temp_dir}/${_archive_name}"

  download "${_url}" "${_archive_path}" || return 1

  case $_archive_path in
    *.zip)
      require_cmd unzip
      unzip "${_archive_path}" -d "${_temp_dir}"
      _bin_name="varlock.exe"
    ;;
    *)  require_cmd tar
      tar -xzf "${_archive_path}" -C "${_temp_dir}"
      _bin_name="varlock"
    ;;
  esac

  test ! -d "${BINDIR}" && install -d "${BINDIR}"

  install "${_temp_dir}/${_bin_name}" "${BINDIR}/" || err "Failed to install"
  _bin_path=${BINDIR}/${_bin_name}

  println "✅ Successfully installed varlock @ $($_bin_path --version) to ${_bin_path}"

  rm -rf "${_temp_dir}"

  return 0;
}

get_architecture() {
  _ostype="$(uname -s | tr '[:upper:]' '[:lower:]')"
  _cputype="$(uname -m | tr '[:upper:]' '[:lower:]')"

  case "$_cputype" in
    x86_64) ARCH="x64" ;;
    amd64) ARCH="x64" ;;
    arm64) ARCH="arm64" ;;
    aarch64) ARCH="arm64" ;;
    armv7l) ARCH="armv7l" ;;
    *)
      err "${_cputype} architecture is currently unsupported\n> please open an issue @ ${GITHUB_URL}/issues"
    ;;
  esac

  case "$_ostype" in
    linux) OS=linux ;;
    darwin) OS=macos ;;
    # windows systems
    cygwin*|mingw32*|msys*|mingw*) OS=win ;;
    *)
      err "${_ostype} OS is currently unsupported\n> please open an issue @ ${GITHUB_URL}/issues"
    ;;
  esac
}

# $1 - url for download. $2 - path to download
# Wrapper function for curl/wget
download() {
  if [ ! $# -eq 2 ]; then
    err "URL or target path not specified"
  fi

  if cmd_exists curl; then
    curl -sSfL "$1" -o "$2"
  elif cmd_exists wget; then
    wget -q "$1" -O "$2"
  else
    err "Unable to find download command. Either 'curl' or 'wget' is required."
  fi

  if [ $# -eq 2 ] && [ ! -f "$2" ]; then
    err "Failed to download file $1"
  fi
}

require_cmd() {
  if ! cmd_exists "$1"; then
    err "'$1' is required (command not found)."
  fi
}

cmd_exists() {
  command -v "$1" > /dev/null 2>&1
}

err() {
  println "🚨 INSTALLATION ERROR - $1" >&2
  exit 1
}

println() {
  printf 'varlock installer: %s\n' "$1"
}

main "$@" || exit 1