#!/bin/bash
# Builds the demo sandbox: a fake $HOME with its own Claude config and four
# small dummy git repos under ~/code. Safe to re-run; it starts from scratch.
set -euo pipefail
source "$(dirname "$0")/env.sh"

case "$DEMO_ROOT" in
  */session-hub-demo*|/private/tmp/*|/tmp/*) ;;
  *) echo "refusing to wipe unexpected DEMO_ROOT=$DEMO_ROOT" >&2; exit 1 ;;
esac
rm -rf "$HOME" && mkdir -p "$HOME/code" "$CLAUDE_CONFIG_DIR"

cat > "$HOME/.gitconfig" <<'EOF'
[user]
	name = Demo Dev
	email = dev@example.com
[init]
	defaultBranch = main
[advice]
	detachedHead = false
EOF

commit() { git add -A && GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -qm "$2"; }

# --- acme-shop: a small web store -------------------------------------------
R="$HOME/code/acme-shop"; mkdir -p "$R/src" "$R/tests" && cd "$R" && git init -q
git remote add origin git@github.com:demo-org/acme-shop.git
cat > package.json <<'EOF'
{ "name": "acme-shop", "version": "1.3.2", "scripts": { "test": "playwright test" } }
EOF
cat > src/checkout.js <<'EOF'
export async function checkout(cart, payment) {
  const total = cart.items.reduce((sum, i) => sum + i.price * i.qty, 0)
  const res = await payment.charge(total)
  return { orderId: res.id, total }
}
EOF
cat > tests/checkout.spec.js <<'EOF'
import { test, expect } from '@playwright/test'

test('checkout completes', async ({ page }) => {
  await page.goto('/cart')
  await page.click('text=Checkout')
  await expect(page.locator('.order-confirmed')).toBeVisible({ timeout: 5000 })
})
EOF
cat > playwright.config.js <<'EOF'
export default { timeout: 10000, use: { baseURL: 'http://localhost:3000' } }
EOF
commit "2026-10-20T10:00:00" "Initial store"
git checkout -qb feat/coupons
cat > src/coupons.js <<'EOF'
export const applyCoupon = (total, code) => (code === 'WELCOME10' ? total * 0.9 : total)
EOF
commit "2026-10-28T10:00:00" "Coupon codes"
git checkout -q main && git merge -q --no-ff feat/coupons -m "Merge coupons"
git checkout -qb fix/checkout-timeout

# --- weather-api: a tiny HTTP API ---------------------------------------------
R="$HOME/code/weather-api"; mkdir -p "$R/src" && cd "$R" && git init -q
git remote add origin git@github.com:demo-org/weather-api.git
cat > src/server.js <<'EOF'
import http from 'node:http'
import { forecast } from './forecast.js'

http.createServer(async (req, res) => {
  const city = new URL(req.url, 'http://x').searchParams.get('city')
  res.end(JSON.stringify(await forecast(city)))
}).listen(8080)
EOF
cat > src/forecast.js <<'EOF'
export async function forecast(city) {
  return { city, tempC: 18, sky: 'cloudy' }
}
EOF
commit "2026-10-25T09:00:00" "Weather API"
git checkout -qb feat/rate-limit

# --- dotfiles -------------------------------------------------------------------
R="$HOME/code/dotfiles"; mkdir -p "$R/scripts" && cd "$R" && git init -q
git remote add origin git@github.com:demo-org/dotfiles.git
printf 'set -o vi\nalias gs="git status"\n' > zshrc
cat > scripts/lint.sh <<'EOF'
#!/bin/sh
# Lints every shell file. Slow on purpose (it is a demo).
for f in zshrc scripts/*.sh; do echo "checking $f"; sleep 45; done
echo "all clean"
EOF
chmod +x scripts/lint.sh
commit "2026-10-01T09:00:00" "dotfiles"

# --- pixel-notes ----------------------------------------------------------------
R="$HOME/code/pixel-notes"; mkdir -p "$R" && cd "$R" && git init -q
git remote add origin git@github.com:demo-org/pixel-notes.git
cat > main.py <<'EOF'
import sys

def add(note: str) -> None:
    with open("notes.txt", "a") as f:
        f.write(note + "\n")

if __name__ == "__main__":
    add(" ".join(sys.argv[1:]))
EOF
commit "2026-09-12T09:00:00" "pixel-notes"

# --- Claude Code config: onboarding done, the demo folders trusted ---------------
python3 - "$HOME" <<'EOF'
import json, sys, os
home = sys.argv[1]
repos = [os.path.join(home, "code", r) for r in ("acme-shop", "weather-api", "dotfiles", "pixel-notes")]
trusted = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True, "projectOnboardingSeenCount": 5}
cfg = {
    "hasCompletedOnboarding": True,
    "lastOnboardingVersion": "2.1.318",
    "theme": "dark",
    "hasIdeOnboardingBeenShown": {"vscode": True},
    "hasSeenAutoDefaultNotice": True,
    "hasSeenAutoModeEntryWarning": True,
    "projects": {r: dict(trusted) for r in repos},
}
json.dump(cfg, open(os.path.join(home, ".claude", ".claude.json"), "w"), indent=2)
settings = {
    "theme": "dark",
    "autoUpdates": False,
    "spinnerTipsEnabled": False,
}
json.dump(settings, open(os.path.join(home, ".claude", "settings.json"), "w"), indent=2)
EOF

echo "sandbox ready: $HOME"
