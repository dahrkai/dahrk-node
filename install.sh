#!/bin/sh
# install.sh - install the dahrk-node client and, given a connect token, enrol this machine as a node
# in one copy-paste. Served at https://dahrk.ai/install.sh, so it is written for POSIX `sh` and is
# safe to pipe straight into a shell:
#
#   curl -fsSL https://dahrk.ai/install.sh | sh                                # install only
#   curl -fsSL https://dahrk.ai/install.sh | sh -s -- --token <connect-token>  # install + enrol
#
# THIS FILE IS THE SOURCE OF TRUTH. It is copied byte for byte to dahrk-web/public/install.sh, which
# is what dahrk.ai actually serves, and a guard in that repo fails if the two drift. Edit here, then
# sync; never edit the copy.
#
# It installs `dahrk-node` from npm (the same version the npm and Homebrew channels ship), then hands
# the token to the client's own commands: `dahrk doctor` preflights it, `dahrk start` enrols the node
# and installs the always-on service. It does NOT install a Node runtime; it requires Node 22+ already
# on PATH and, when that is missing, prints the exact commands for the platform it detects rather than
# a generic list. Every bad input - unsupported OS, missing or old Node, an unwritable npm prefix, a
# failed install, a bad token - exits non-zero with a legible message, never a silent half-install.
#
# Idempotent: the client persists a stable node id at ~/.dahrk/node.json, so re-running this upgrades
# the client and re-attaches as the same node rather than creating a duplicate.
#
# Keep to shell built-ins and the four external commands this genuinely needs (uname, npm, node,
# dahrk). The onboarding boxes it runs on are minimal, and scripts/test-install.sh drives it with a
# PATH containing nothing but stubs of those four.
set -eu

# The Node floor: matches `engines.node` in the published package.
NODE_MIN_MAJOR=22
# Pinned in the nvm hint below so the fallback route is a command that works rather than a gesture.
NVM_VERSION=v0.40.6
# Overridable so the tests can point the distro probe at a fixture instead of the real host.
OS_RELEASE=${DAHRK_OS_RELEASE:-/etc/os-release}

# A legible failure: message to stderr, non-zero exit. Every guard below routes through this.
fail() {
  echo "dahrk install: $1" >&2
  exit 1
}

# --- arguments and environment -------------------------------------------------------------------
# A flag wins over the matching environment variable. DAHRK_TOKEN is the installer's spelling of the
# connect token; it is handed to the client as --token. DAHRK_HUB_URL overrides the hub for
# self-hosters and staging (the client defaults it to wss://api.dahrk.ai).
token=${DAHRK_TOKEN:-}
hub_url=${DAHRK_HUB_URL:-}
no_service=0

while [ $# -gt 0 ]; do
  case "$1" in
    --token) [ $# -ge 2 ] || fail "--token needs a value"; token=$2; shift 2 ;;
    --token=*) token=${1#--token=}; shift ;;
    --hub-url) [ $# -ge 2 ] || fail "--hub-url needs a value"; hub_url=$2; shift 2 ;;
    --hub-url=*) hub_url=${1#--hub-url=}; shift ;;
    --no-service) no_service=1; shift ;;
    -h | --help)
      echo "Usage: install.sh [--token <connect-token>] [--hub-url <url>] [--no-service]"
      echo "  Installs dahrk-node; with a token, also enrols this machine as a node."
      exit 0
      ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
done

# --- platform detection --------------------------------------------------------------------------
# Two facts, and nothing else: a human label to show the user (so a wrong guess is visible rather than
# silently producing wrong advice), and which package manager to phrase the Node instructions for.
#
# The package manager is found by PROBING for the binary, not by matching an ID in /etc/os-release.
# Probing is what makes the derivatives work - Mint and Pop!_OS report their own ID but carry apt-get,
# and an ID table would have to list every one of them to stay correct. Same choice, same reason, as
# dahrk-harness/testbed/bootstrap.sh.
PLATFORM_LABEL=unknown
PKG=none
# How this user can reach root, if at all: root | sudo | su | none. Every instruction that needs
# privilege is rendered through this, because a box without sudo is not exotic - a stock Debian has
# none, and telling such a user to run `sudo apt-get` is the same dead end as telling them to run
# brew. `su` is the fallback there (it asks for the root password rather than theirs), and when
# there is no route at all we must not print a privileged command we know cannot work.
PRIV=none

# Read one KEY=value from an os-release file using only shell built-ins. That file is designed to be
# sourced, but this script may be piped into a root shell, so it is parsed rather than executed: a
# machine that can write /etc/os-release must not thereby get to run code here.
os_release_field() {
  _key=$1
  [ -r "$OS_RELEASE" ] || return 1
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      "$_key"=*)
        _value=${_line#*=}
        # Values may be quoted either way; strip one matching pair.
        case "$_value" in
          \"*\") _value=${_value#\"}; _value=${_value%\"} ;;
          \'*\') _value=${_value#\'}; _value=${_value%\'} ;;
        esac
        [ -n "$_value" ] || return 1
        printf '%s' "$_value"
        return 0
        ;;
    esac
  done < "$OS_RELEASE"
  return 1
}

detect_privilege() {
  if [ "$(id -u 2>/dev/null || echo 1000)" = "0" ]; then
    PRIV=root
  elif command -v sudo >/dev/null 2>&1; then
    PRIV=sudo
  elif command -v su >/dev/null 2>&1; then
    PRIV=su
  fi
}

# Render a command so it runs as root on THIS box, as a single unsplittable line. Empty output means
# there is no route to root, and the caller must offer something else instead.
#
# One command, not two. The apt recipe used to print as two lines - add the NodeSource repo, then
# `apt-get install -y nodejs` - and a user whose first line failed ran the second on its own. That
# installs Debian's own nodejs, which is 18 and ships no npm: strictly worse than nothing, because
# `node` now exists and the failure changes from "not installed" to "too old". Joined with && it
# cannot half-apply.
as_root() {
  case "$PRIV" in
    root) printf '%s' "$1" ;;
    sudo) printf "sudo -E sh -c '%s'" "$1" ;;
    su) printf "su -c '%s'" "$1" ;;
    *) printf '' ;;
  esac
}

detect_platform() {
  case "$PLATFORM_OS" in
    Darwin)
      _ver=""
      if command -v sw_vers >/dev/null 2>&1; then
        _ver=$(sw_vers -productVersion 2>/dev/null || echo "")
      fi
      if [ -n "$_ver" ]; then PLATFORM_LABEL="macOS $_ver"; else PLATFORM_LABEL="macOS"; fi
      if command -v brew >/dev/null 2>&1; then PKG=brew; fi
      ;;
    Linux)
      PLATFORM_LABEL=$(os_release_field PRETTY_NAME || os_release_field NAME || echo "Linux")
      # Ordered by how often we expect to meet them, not by preference.
      if command -v apt-get >/dev/null 2>&1; then PKG=apt
      elif command -v dnf >/dev/null 2>&1; then PKG=dnf
      elif command -v apk >/dev/null 2>&1; then PKG=apk
      elif command -v pacman >/dev/null 2>&1; then PKG=pacman
      elif command -v zypper >/dev/null 2>&1; then PKG=zypper
      fi
      ;;
  esac
}

# The commands that actually install Node 22 on the box we are standing on. Printed by both the
# missing-Node and the too-old-Node branch, so a user never gets two different answers to one problem.
#
# The nvm route is always offered as the second option because it is the only one that needs no sudo,
# and it is spelled out in full: "nvm install 22" on a machine with no nvm is the advice that sent a
# real user round in a circle.
node_install_hint() {
  # The system-wide recipe for this package manager, as ONE command, without any privilege prefix.
  sys_label=""
  sys_cmd=""
  case "$PKG" in
    apt)
      sys_label="Debian / Ubuntu (NodeSource)"
      sys_cmd="curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | bash - && apt-get install -y nodejs"
      ;;
    dnf)
      sys_label="Fedora / RHEL (NodeSource)"
      sys_cmd="curl -fsSL https://rpm.nodesource.com/setup_${NODE_MIN_MAJOR}.x | bash - && dnf install -y nodejs"
      ;;
    apk)
      sys_label="Alpine"
      sys_cmd="apk add --no-cache nodejs npm"
      ;;
    pacman)
      sys_label="Arch"
      sys_cmd="pacman -S --noconfirm nodejs npm"
      ;;
    zypper)
      sys_label="openSUSE"
      sys_cmd="zypper install -y nodejs${NODE_MIN_MAJOR}"
      ;;
  esac

  echo ""
  echo "Detected: $PLATFORM_LABEL, running as $(whoami 2>/dev/null || echo "this user")"
  echo ""
  echo "Install Node ${NODE_MIN_MAJOR}, then re-run this command."
  echo ""

  # Homebrew is never run as root, so it does not go through as_root at all.
  if [ "$PKG" = brew ]; then
    echo "  macOS (Homebrew):"
    echo "    brew install node@${NODE_MIN_MAJOR} && brew link --overwrite node@${NODE_MIN_MAJOR}"
    echo ""
  elif [ -n "$sys_cmd" ]; then
    sys_rooted=$(as_root "$sys_cmd")
    if [ -n "$sys_rooted" ]; then
      echo "  $sys_label:"
      echo "    $sys_rooted"
      case "$PRIV" in
        su) echo "    (this box has no sudo, so su asks for the ROOT password, not yours.)" ;;
      esac
      if [ "$PKG" = apk ]; then
        echo "    (check 'node -v' afterwards: only Alpine 3.20+ carries Node ${NODE_MIN_MAJOR}.)"
      fi
      echo ""
    else
      echo "  This box has no sudo and no su, so there is no way to install Node system-wide."
      echo "  Use the nvm route below, which installs into your home directory."
      echo ""
    fi
  elif [ "$PLATFORM_OS" = "Darwin" ]; then
    echo "  macOS: install Homebrew (https://brew.sh), then:"
    echo "    brew install node@${NODE_MIN_MAJOR}"
    echo ""
  else
    echo "  No supported package manager found (apt-get, dnf, apk, pacman, zypper)."
    echo "  Use the nvm route below, or the official builds at https://nodejs.org/en/download."
    echo ""
  fi

  # nvm installs into $HOME, so WHICH user runs it is the whole point. Running it under `su -` puts
  # Node in /root/.nvm, where the account that will actually run the node cannot see it - a silent
  # no-op that reads as "I installed Node and the installer still says it is missing".
  echo "  Or with nvm, which needs no root at all:"
  echo "    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash"
  echo "    . \"\$HOME/.nvm/nvm.sh\" && nvm install ${NODE_MIN_MAJOR}"
  if [ "$PRIV" = root ]; then
    echo "    (you are root: nvm would install into /root. Run these as the user that will run"
    echo "     the node, or use the system-wide route above.)"
  else
    echo "    (installs into \$HOME for $(whoami 2>/dev/null || echo "this user") only - run it as"
    echo "     the same user that will run the node, never under su or sudo.)"
  fi
  echo ""
  echo "  Official builds: https://nodejs.org/en/download"
  echo ""
}

# --- operating system ----------------------------------------------------------------------------
# macOS and Linux only. Name Windows explicitly, since a curious Windows user is the likely case and
# WSL2 is the supported answer there.
PLATFORM_OS=$(uname -s 2>/dev/null || echo unknown)
case "$PLATFORM_OS" in
  Darwin | Linux) ;;
  MINGW* | MSYS* | CYGWIN* | Windows*)
    fail "Windows is not supported. Run dahrk-node inside WSL2 (a Linux shell), or see https://dahrk.ai/docs/install." ;;
  *)
    fail "unsupported operating system: $PLATFORM_OS. dahrk-node supports macOS and Linux." ;;
esac

detect_privilege
detect_platform

# --- Node 22+ ------------------------------------------------------------------------------------
# The client is a Node program; this script does not install a runtime, so a missing or too-old Node
# is a hard stop. What it is not any more is a dead end: node_install_hint prints the commands that
# work on this box.
if ! command -v node >/dev/null 2>&1; then
  echo "dahrk install: Node ${NODE_MIN_MAJOR}+ is required, but 'node' was not found on PATH." >&2
  node_install_hint >&2
  exit 1
fi

node_version=$(node -v 2>/dev/null) || fail "could not run 'node -v' to check the Node version."
node_major=${node_version#v}
node_major=${node_major%%.*}
case "$node_major" in
  '' | *[!0-9]*) fail "could not read the Node version from '${node_version}'. Install Node ${NODE_MIN_MAJOR}+ and re-run." ;;
esac
if [ "$node_major" -lt "$NODE_MIN_MAJOR" ]; then
  echo "dahrk install: Node ${NODE_MIN_MAJOR}+ is required, but this is ${node_version}." >&2
  node_install_hint >&2
  exit 1
fi

# Node without npm is a real Debian/Ubuntu shape, not a broken install: their `nodejs` package
# only SUGGESTS npm, so `apt-get install nodejs` leaves you with node and no npm. "Reinstall Node"
# is the wrong instruction there, which is why this branch takes the platform into account too.
if ! command -v npm >/dev/null 2>&1; then
  echo "dahrk install: Node is present (${node_version}) but npm is not on PATH." >&2
  if [ "$PKG" = apt ] || [ "$PKG" = dnf ]; then
    echo "" >&2
    echo "Your distro's nodejs package ships without npm. The NodeSource build includes it:" >&2
    echo "" >&2
    node_install_hint >&2
  else
    echo "Reinstall Node ${NODE_MIN_MAJOR}+ so npm comes with it, then re-run." >&2
  fi
  exit 1
fi

# --- the global npm prefix must be writable --------------------------------------------------------
# A distro Node puts its global prefix under /usr, which an ordinary user cannot write, so
# `npm install -g` dies with a wall of EACCES. That is the very next thing a user hits after fixing
# Node, so it is checked up front and answered here rather than left to npm's stack trace. An
# nvm-managed Node, a Homebrew Node and root all pass this trivially.
npm_prefix=$(npm prefix -g 2>/dev/null || echo "")
if [ -n "$npm_prefix" ]; then
  # The modules directory is the thing npm writes; before the first global install it may not exist
  # yet, in which case the prefix itself is what has to be writable.
  prefix_target=$npm_prefix
  if [ -d "$npm_prefix/lib/node_modules" ]; then
    prefix_target=$npm_prefix/lib/node_modules
  fi
  # A prefix that does not exist yet is not a failure - npm creates it. `npm config set prefix
  # ~/.npm-global` without a mkdir is an extremely common setup, and testing -w on the missing
  # directory rejected it out of hand. The real question is whether the nearest EXISTING ancestor is
  # writable, i.e. whether npm will be able to create what is missing.
  while [ ! -e "$prefix_target" ] && [ "$prefix_target" != "/" ]; do
    prefix_parent=${prefix_target%/*}
    [ -n "$prefix_parent" ] || prefix_parent=/
    prefix_target=$prefix_parent
  done
  if [ ! -w "$prefix_target" ]; then
    echo "dahrk install: the global npm prefix ($prefix_target) is not writable, so" >&2
    echo "'npm install -g dahrk-node' would fail with EACCES." >&2
    echo "" >&2
    echo "Either give npm a prefix you own (recommended, and no sudo afterwards):" >&2
    echo "" >&2
    echo "  mkdir -p \"\$HOME/.npm-global\"" >&2
    echo "  npm config set prefix \"\$HOME/.npm-global\"" >&2
    echo "  echo 'export PATH=\"\$HOME/.npm-global/bin:\$PATH\"' >> \"\$HOME/.profile\"" >&2
    echo "  export PATH=\"\$HOME/.npm-global/bin:\$PATH\"" >&2
    echo "" >&2
    # Same rule as the Node hint: only offer a privileged command this box can actually run.
    case "$PRIV" in
      sudo)
        echo "or install it as root instead:" >&2
        echo "" >&2
        echo "  curl -fsSL https://dahrk.ai/install.sh | sudo sh -s -- --token <connect-token>" >&2
        echo "" >&2
        ;;
      su)
        echo "or install it as root instead (su asks for the ROOT password; this box has no sudo):" >&2
        echo "" >&2
        echo "  su -c 'curl -fsSL https://dahrk.ai/install.sh | sh -s -- --token <connect-token>'" >&2
        echo "" >&2
        ;;
    esac
    exit 1
  fi
fi

# --- install the client --------------------------------------------------------------------------
echo "==> Installing dahrk-node (npm install -g dahrk-node)"
npm install -g dahrk-node ||
  fail "'npm install -g dahrk-node' failed (see the error above; a registry or network problem is usual). Fix it and re-run."

# Installed, but only useful if the shell can find it. A user-owned npm prefix that was never added to
# PATH is the common cause, and it is silent otherwise: the install "succeeds" and `dahrk` is missing.
command -v dahrk >/dev/null 2>&1 ||
  fail "installed dahrk-node, but 'dahrk' is not on your PATH. Add your global npm bin directory to PATH (\$(npm prefix -g)/bin) and re-run."

# --- no token: install only, print the next step -------------------------------------------------
if [ -z "$token" ]; then
  echo ""
  echo "dahrk-node is installed. To enrol this machine as a node, run:"
  echo ""
  echo "    dahrk start --token <your-connect-token>"
  echo ""
  echo "Get a connect token at https://app.dahrk.ai."
  exit 0
fi

# --- token: preflight, then enrol ----------------------------------------------------------------
# Preflight the token before committing to enrol. `dahrk doctor` checks Node, runtimes, hub
# reachability and the token itself, and exits non-zero on a missing / expired / consumed / revoked
# token. We stop there on failure - the client stays installed, so a re-run with a fresh token just
# works, no rollback.
set -- doctor --token "$token"
if [ -n "$hub_url" ]; then set -- "$@" --hub-url "$hub_url"; fi
echo "==> Checking the connect token (dahrk doctor)"
dahrk "$@" ||
  fail "the connect token was not accepted (see the doctor output above). Get a fresh token at https://app.dahrk.ai and re-run; the client stays installed."

# Good token: enrol. `dahrk start` persists the token, installs the always-on service, and returns.
# --no-service enrols without installing the daemon, for users who supervise the node themselves.
set -- start --token "$token"
if [ -n "$hub_url" ]; then set -- "$@" --hub-url "$hub_url"; fi
if [ "$no_service" -eq 1 ]; then set -- "$@" --no-service; fi
echo "==> Enrolling this node (dahrk start)"
dahrk "$@"
