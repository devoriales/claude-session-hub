#!/bin/bash
# Re-records docs/demo.gif from dummy repos in a throwaway sandbox.
#
#   1. claude setup-token, and save the token to ~/.config/session-hub-demo/token
#   2. demo/record.sh            (needs python3 and agg: brew install agg)
#
# Nothing here reads or lists your real ~/.claude or projects: HOME and
# CLAUDE_CONFIG_DIR point into the sandbox for the whole run.
set -euo pipefail
cd "$(dirname "$0")/.."
bash demo/setup.sh
source demo/env.sh
python3 demo/record.py "$@"
[ "${1:-}" = "--smoke" ] && exit 0
mkdir -p docs
agg --theme monokai --font-size 14 --font-family "Menlo,Apple Symbols" --idle-time-limit 3 --last-frame-duration 4 \
  "$DEMO_ROOT/demo.cast" docs/demo.gif
echo "wrote docs/demo.gif ($(du -h docs/demo.gif | cut -f1))"
