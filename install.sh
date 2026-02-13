#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# OpenCode Discord Rich Presence — Installer
#
# This script sets up the Discord Rich Presence plugin for OpenCode.
# It installs dependencies, symlinks the plugin into the global OpenCode
# config, and ensures everything is ready to go.
#
# Usage:
#   ./install.sh
#
# Prerequisites:
#   - OpenCode installed          (https://opencode.ai)
#   - Bun installed               (https://bun.sh)
#   - A Discord Application       (https://discord.com/developers/applications)
#     with the name "OpenCode" and a Rich Presence art asset "opencode_logo"
# ─────────────────────────────────────────────────────────────────────────────

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_CONFIG_DIR="${HOME}/.config/opencode"
OPENCODE_PLUGINS_DIR="${OPENCODE_CONFIG_DIR}/plugins"
OPENCODE_PACKAGE_JSON="${OPENCODE_CONFIG_DIR}/package.json"

info()    { echo -e "${CYAN}[info]${RESET}  $1"; }
success() { echo -e "${GREEN}[ok]${RESET}    $1"; }
warn()    { echo -e "${YELLOW}[warn]${RESET}  $1"; }
error()   { echo -e "${RED}[error]${RESET} $1"; exit 1; }

echo ""
echo -e "${BOLD}OpenCode Discord Rich Presence — Installer${RESET}"
echo "────────────────────────────────────────────"
echo ""

# ── Step 1: Check for OpenCode ───────────────────────────────────────────────
if command -v opencode &>/dev/null; then
  success "OpenCode found at $(which opencode)"
else
  warn "OpenCode not found in PATH."
  echo "  Install it: curl -fsSL https://opencode.ai/install | bash"
  echo ""
fi

# ── Step 2: Check for Bun ───────────────────────────────────────────────────
BUN_BIN=""
if command -v bun &>/dev/null; then
  BUN_BIN="bun"
elif [ -f "${HOME}/.bun/bin/bun" ]; then
  BUN_BIN="${HOME}/.bun/bin/bun"
else
  info "Bun not found. Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  BUN_BIN="${HOME}/.bun/bin/bun"
  if [ ! -f "$BUN_BIN" ]; then
    error "Bun installation failed. Please install manually: https://bun.sh"
  fi
  success "Bun installed at ${BUN_BIN}"
fi
success "Bun found at ${BUN_BIN}"

# ── Step 3: Create OpenCode config directories ──────────────────────────────
mkdir -p "${OPENCODE_PLUGINS_DIR}"
success "OpenCode plugins directory ready: ${OPENCODE_PLUGINS_DIR}"

# ── Step 4: Add @xhayper/discord-rpc dependency ─────────────────────────────
if [ -f "${OPENCODE_PACKAGE_JSON}" ]; then
  # Check if dependency already exists
  if grep -q '"@xhayper/discord-rpc"' "${OPENCODE_PACKAGE_JSON}"; then
    success "Dependency @xhayper/discord-rpc already in ${OPENCODE_PACKAGE_JSON}"
  else
    info "Adding @xhayper/discord-rpc to ${OPENCODE_PACKAGE_JSON}..."
    # Use a temp file to merge the dependency in
    TMP_FILE=$(mktemp)
    if command -v python3 &>/dev/null; then
      python3 -c "
import json, sys
with open('${OPENCODE_PACKAGE_JSON}', 'r') as f:
    data = json.load(f)
deps = data.get('dependencies', {})
deps['@xhayper/discord-rpc'] = '^1.3.0'
data['dependencies'] = deps
with open('${OPENCODE_PACKAGE_JSON}', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
      success "Added @xhayper/discord-rpc to package.json"
    else
      warn "python3 not found — please manually add @xhayper/discord-rpc to ${OPENCODE_PACKAGE_JSON}"
    fi
    rm -f "${TMP_FILE}"
  fi
else
  info "Creating ${OPENCODE_PACKAGE_JSON}..."
  cat > "${OPENCODE_PACKAGE_JSON}" <<'PKGJSON'
{
  "dependencies": {
    "@xhayper/discord-rpc": "^1.3.0"
  }
}
PKGJSON
  success "Created ${OPENCODE_PACKAGE_JSON}"
fi

# ── Step 5: Install dependencies ────────────────────────────────────────────
info "Installing dependencies with Bun..."
(cd "${OPENCODE_CONFIG_DIR}" && "${BUN_BIN}" install 2>&1) || warn "bun install had warnings (may be OK)"
success "Dependencies installed"

# ── Step 6: Symlink plugin ──────────────────────────────────────────────────
SYMLINK_TARGET="${OPENCODE_PLUGINS_DIR}/discord-rpc.ts"
PLUGIN_SOURCE="${PLUGIN_DIR}/src/index.ts"

if [ -L "${SYMLINK_TARGET}" ]; then
  CURRENT_TARGET=$(readlink "${SYMLINK_TARGET}")
  if [ "${CURRENT_TARGET}" = "${PLUGIN_SOURCE}" ]; then
    success "Symlink already exists and is correct"
  else
    info "Updating symlink (was pointing to ${CURRENT_TARGET})..."
    ln -sf "${PLUGIN_SOURCE}" "${SYMLINK_TARGET}"
    success "Symlink updated"
  fi
elif [ -f "${SYMLINK_TARGET}" ]; then
  warn "A file already exists at ${SYMLINK_TARGET} — backing up and replacing"
  mv "${SYMLINK_TARGET}" "${SYMLINK_TARGET}.bak"
  ln -sf "${PLUGIN_SOURCE}" "${SYMLINK_TARGET}"
  success "Symlink created (old file backed up)"
else
  ln -sf "${PLUGIN_SOURCE}" "${SYMLINK_TARGET}"
  success "Symlink created: ${SYMLINK_TARGET} -> ${PLUGIN_SOURCE}"
fi

# ── Step 7: Discord Client ID ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}Discord Application Setup${RESET}"
echo "────────────────────────────────────────────"
echo ""
echo "The plugin needs a Discord Application Client ID to show Rich Presence."
echo ""
echo "If you haven't created one yet:"
echo "  1. Go to https://discord.com/developers/applications"
echo "  2. Click 'New Application' and name it 'OpenCode'"
echo "  3. Upload a Rich Presence art asset named 'opencode_logo'"
echo "  4. Copy the Application ID (Client ID)"
echo ""

# Check if already set in env
if [ -n "${DISCORD_RPC_CLIENT_ID:-}" ]; then
  success "DISCORD_RPC_CLIENT_ID is already set: ${DISCORD_RPC_CLIENT_ID}"
else
  read -rp "$(echo -e "${CYAN}Enter your Discord Application Client ID (or press Enter to skip):${RESET} ")" CLIENT_ID

  if [ -n "${CLIENT_ID}" ]; then
    # Detect shell config file
    SHELL_RC=""
    if [ -f "${HOME}/.zshrc" ]; then
      SHELL_RC="${HOME}/.zshrc"
    elif [ -f "${HOME}/.bashrc" ]; then
      SHELL_RC="${HOME}/.bashrc"
    elif [ -f "${HOME}/.bash_profile" ]; then
      SHELL_RC="${HOME}/.bash_profile"
    fi

    if [ -n "${SHELL_RC}" ]; then
      # Remove any existing DISCORD_RPC_CLIENT_ID line
      grep -v "DISCORD_RPC_CLIENT_ID" "${SHELL_RC}" > "${SHELL_RC}.tmp" 2>/dev/null || true
      mv "${SHELL_RC}.tmp" "${SHELL_RC}"

      echo "" >> "${SHELL_RC}"
      echo "# OpenCode Discord Rich Presence" >> "${SHELL_RC}"
      echo "export DISCORD_RPC_CLIENT_ID=\"${CLIENT_ID}\"" >> "${SHELL_RC}"
      success "Added DISCORD_RPC_CLIENT_ID to ${SHELL_RC}"
      warn "Run 'source ${SHELL_RC}' or open a new terminal for it to take effect."
    else
      warn "Could not detect shell config file."
      echo "  Add this to your shell profile manually:"
      echo "    export DISCORD_RPC_CLIENT_ID=\"${CLIENT_ID}\""
    fi
  else
    warn "Skipped. Set DISCORD_RPC_CLIENT_ID before running OpenCode:"
    echo "    export DISCORD_RPC_CLIENT_ID=\"your-client-id\""
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
echo -e "${GREEN}${BOLD}Installation complete!${RESET}"
echo ""
echo "The plugin will activate automatically the next time you run:"
echo -e "  ${BOLD}opencode${RESET}"
echo ""
echo "Make sure Discord is running on your machine for Rich Presence to work."
echo ""
