# Sourced by the demo scripts. Points Claude Code, git and gh at a throwaway
# sandbox so the recording shows only the dummy repos, never your real sessions.
#
#   DEMO_ROOT   where the sandbox lives (default: $TMPDIR/session-hub-demo)
#   token file  ~/.config/session-hub-demo/token, from `claude setup-token`

DEMO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_DIR="$(cd "$DEMO_SRC/.." && pwd)"
REAL_HOME="${REAL_HOME:-$HOME}"
DEMO_ROOT="${DEMO_ROOT:-${TMPDIR:-/tmp}/session-hub-demo}"
# Resolve symlinks (macOS: /var -> /private/var) so paths match what Claude Code
# records and the pane can shorten them to ~/...
(umask 077 && mkdir -p "$DEMO_ROOT/home") && DEMO_ROOT="$(cd "$DEMO_ROOT" && pwd -P)"
if [ ! -O "$DEMO_ROOT" ]; then
  echo "DEMO_ROOT $DEMO_ROOT is not owned by you; pick another" >&2
  return 1 2>/dev/null || exit 1
fi
chmod 700 "$DEMO_ROOT"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}"

TOKEN_FILE="$REAL_HOME/.config/session-hub-demo/token"
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r "$TOKEN_FILE" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
fi

export REAL_HOME DEMO_ROOT PLUGIN_DIR CLAUDE_BIN CLAUDE_CODE_OAUTH_TOKEN
export HOME="$DEMO_ROOT/home"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
# The fake `gh` (PR status for the dummy branches) comes first.
export PATH="$DEMO_SRC/bin:$PATH"
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
# Don't inherit the session this script was started from.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_PID \
  CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_CHILD_SESSION \
  CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_EXECPATH CLAUDE_EFFORT TMUX TERM_PROGRAM ITERM_SESSION_ID
export TERM=xterm-256color COLORTERM=truecolor
