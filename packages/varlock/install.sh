#!/bin/sh

# NOTE - https://varlock.dev/install.sh redirects to this file on github
# so can be used to install by running `curl -sSfL https://varlock.dev/install.sh | sh -s`

set -e

GITHUB_URL="https://github.com/dmno-dev/varlock"
GITHUB_RELEASES_URL="${GITHUB_URL}/releases"
HOMEBREW_FORMULA_URL="https://raw.githubusercontent.com/dmno-dev/homebrew-tap/refs/heads/main/Formula/varlock.rb"
HOMEBREW_TAP_NAME="dmno-dev/tap/varlock"

OS=""
ARCH=""
VERSION=""
LATEST_VERSION=""
INSTALL_DIR="${HOME}/.varlock/bin"
INSTALL_DIR_UNEXPANDED="~/.varlock/bin"
REINSTALL=""
FORCE_NO_BREW="false"

usage() {
  echo "Usage: $0 [options]"
  echo ""
  echo "install varlock binary"
  echo ""
  echo "Options:"
  echo "  --dir             directory to install varlock to (default: \"${INSTALL_DIR}\")"
  echo "  --reinstall       reinstall even if already installed (default: false)"
  echo "  --version         version of varlock to install (defaults to latest)"
  echo "  --force-no-brew   force install without homebrew even when detected (default: false)"
  echo ""
}

parse_args() {
  # parse arguments
  for arg in "$@"; do
    case $arg in
    version=* | --version=*)
      VERSION="${arg#*=}"
    ;;
    dir=* | --dir=*)
      INSTALL_DIR="${arg#*=}"
    ;;
    reinstall | --reinstall)
      REINSTALL="1"
    ;;
    force-no-brew | --force-no-brew)
      FORCE_NO_BREW="true"
    ;;
    help | --help)
      usage
      return 0
    ;;
    *)
      # Unknown option
      echo "Unknown option: $arg"
      usage
      return 1
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

  get_architecture || return 1

  # if homebrew is detected, we just use it
  if cmd_exists brew && [ "$FORCE_NO_BREW" = "false" ]; then
    echo "Detected homebrew 🍺 - installing varlock via brew"
    echo "(rerun with \`--force-no-brew\` to install binary directly instead)"
    echo ""
    brew install "$HOMEBREW_TAP_NAME"
    return 0;
  fi

  require_cmd mktemp
  require_cmd grep
  require_cmd rm
  

  # check installation directory is writable
  mkdir -p "${INSTALL_DIR}"

  if [ ! -w "${INSTALL_DIR}" ]; then
    # TODO - how to let the user specify the directory when installing via curl
    err "Installation directory (${INSTALL_DIR}) is not writable by the current user"
  fi

  case $OS in
    win-*) _ext=".zip" ;;
    *) _ext=".tar.gz" ;;
  esac

  _archive_name="varlock-${OS}-${ARCH}${_ext}"

  if [ -z "${VERSION}" ]; then
    VERSION=$(get_varlock_latest_version)
    echo "The latest version (${VERSION}) will be installed."
  else
    check_requested_version "${VERSION}"
    echo "Version ${VERSION} will be installed"
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

  test ! -d "${INSTALL_DIR}" && install -d "${INSTALL_DIR}"

  install "${_temp_dir}/${_bin_name}" "${INSTALL_DIR}/" || err "Failed to install"
  _bin_path=${INSTALL_DIR}/${_bin_name}

  chmod u+x "$_bin_path"

  echo "✅ Successfully installed varlock @ $($_bin_path --version) to ${_bin_path}"
  rm -rf "${_temp_dir}"

  echo ""
  echo "You must add this folder to your PATH!"
  echo "(For example add this to your ~/.zshrc, ~/.bashrc, etc)"
  echo ""
  echo "export PATH=\"${INSTALL_DIR_UNEXPANDED}:\$PATH\""
  echo ""

  return 0;
}

get_architecture() {
  require_cmd uname

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


ensure_containing_dir_exists() {
  local CONTAINING_DIR
  CONTAINING_DIR="$(dirname "$1")"
  if [ ! -d "$CONTAINING_DIR" ]; then
    echo " >> Creating directory $CONTAINING_DIR"
    mkdir -p "$CONTAINING_DIR"
  fi
}

require_cmd() {
  if ! cmd_exists "$1"; then
    err "\`$1\` is required (command not found)."
  fi
}

cmd_exists() {
  command -v "$1" > /dev/null 2>&1
}

err() {
  printf "🚨 VARLOCK INSTALLATION ERROR - %s\n" "$1"
  exit 1
}

main "$@" || exit 1