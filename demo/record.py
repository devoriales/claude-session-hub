#!/usr/bin/env python3
"""Records docs/demo.gif: a few real Claude Code sessions in the dummy repos,
then a session that opens /sessions and resumes an ended one in place.

Run through demo/record.sh, which sets up the sandbox environment first.
  record.py            full run: ended sessions, running sessions, recording
  record.py --smoke    only start the recording session, to check the screen
"""

import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from pty_driver import Term  # noqa: E402

HOME = os.environ["HOME"]
CLAUDE = os.environ["CLAUDE_BIN"]
PLUGIN_DIR = os.environ["PLUGIN_DIR"]
OUT = os.environ.get("DEMO_CAST", os.path.join(os.environ["DEMO_ROOT"], "demo.cast"))
# Wide enough that the docked pane gets the full banner and room for each row.
COLS, ROWS = 160, 52
# Background sessions use a small model; the pane never shows which.
# Only the tools the demo prompts need; anything else is denied (no one answers prompts).
WORKER = [
    CLAUDE, "--model", "haiku",
    "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash(./scripts/lint.sh*),Bash(sh scripts/lint.sh*),Bash(scripts/lint.sh*)",
]
ENV = dict(os.environ)


def repo(name):
    return os.path.join(HOME, "code", name)


def git(name, *args):
    subprocess.run(["git", "-C", repo(name), *args], check=True, capture_output=True)


def agents():
    out = subprocess.run([CLAUDE, "agents", "--json"], capture_output=True, text=True, env=ENV)
    try:
        return json.loads(out.stdout or "[]")
    except json.JSONDecodeError:
        return []


def wait_idle(term, cwd, timeout=240):
    """Waits until the session in `cwd` has worked and gone idle again."""
    start, seen_busy, idle_polls = time.time(), False, 0
    while time.time() - start < timeout:
        time.sleep(3)
        rows = [r for r in agents() if r.get("pid") == term.pid or r.get("cwd") == cwd]
        status = rows[0].get("status") if rows else None
        seen_busy |= status == "busy"
        idle_polls = idle_polls + 1 if status == "idle" else 0
        if idle_polls >= 2 and (seen_busy or time.time() - start > 30):
            return True
    print(f"  ! {cwd} did not go idle within {timeout}s", file=sys.stderr)
    return False


def worker(name, prompt):
    print(f"- {name}: {prompt}")
    # Typed in rather than passed as an argument: --allowedTools takes a list
    # and would swallow a trailing prompt.
    term = Term(WORKER, repo(name), ENV, COLS, ROWS)
    time.sleep(5)
    term.send(prompt, 0.01)
    time.sleep(0.5)
    term.send("\r")
    time.sleep(2)
    return term


def ended(name, prompt):
    term = worker(name, prompt)
    wait_idle(term, repo(name))
    time.sleep(4)  # let the title get written
    term.send("/exit", 0.05)
    time.sleep(0.5)
    term.send("\r")
    term.close(15)


def record():
    print(f"recording to {OUT}")
    term = Term([CLAUDE, "--plugin-dir", PLUGIN_DIR], repo("acme-shop"), ENV, COLS, ROWS, record=OUT)
    time.sleep(6)
    if "--smoke" in sys.argv:
        term.send("/sessions", 0.08)
        time.sleep(0.6)
        term.send("\r")
        time.sleep(10)
        term.stop_recording()
        term.send("\x03\x03")
        term.close(5)
        return
    term.send("/sessions", 0.11)
    time.sleep(0.8)
    term.send("\r")
    time.sleep(8)  # the list fills in, the busy session ticks along
    # A click on the pane gives it the keyboard (ctrl+x tab does too in a real
    # terminal, but not through this pty). The spot is the banner's empty corner.
    term.send(f"\x1b[<0;{COLS - 20};4M")
    time.sleep(0.1)
    term.send(f"\x1b[<0;{COLS - 20};4m")
    time.sleep(1.5)
    term.send("s")  # into the search field
    time.sleep(1.2)
    term.send("coupon", 0.18)  # the list narrows as it is typed
    time.sleep(3)
    term.send("\r")  # onto the first match's Resume button
    time.sleep(1.5)
    term.send("\r")  # arm it: says it will resume here
    time.sleep(3)
    term.send("\r")  # confirm: resumes it right here
    time.sleep(8)
    term.stop_recording()  # exit prints a resume hint with local paths
    term.send("\x03")
    time.sleep(0.4)
    term.send("\x03")
    term.close(5)


def scrub(path):
    """Blanks account notices (usage limits, reset times) out of the recording.

    Each is replaced by as many spaces, so the screen around it stays the same.
    """
    notice = re.compile(r"You've used \d+% of your [a-z ]*limit[^\x1b]*")
    lines = open(path).read().splitlines()
    out = lines[:1]
    for line in lines[1:]:
        event = json.loads(line)
        event[2] = notice.sub(lambda m: " " * len(m.group(0)), event[2])
        out.append(json.dumps(event))
    open(path, "w").write("\n".join(out) + "\n")


def main():
    if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        sys.exit("No token: run `claude setup-token` and save it to ~/.config/session-hub-demo/token")
    if "--smoke" in sys.argv:
        return record()

    running = []
    try:
        # Ended sessions, oldest first, so the acme-shop one is the newest ("a").
        ended("pixel-notes", "Add a --list flag to main.py that prints every saved note")
        git("acme-shop", "checkout", "-q", "feat/coupons")
        ended("acme-shop", "Add a unit test for applyCoupon covering the WELCOME10 code")
        git("acme-shop", "checkout", "-q", "fix/checkout-timeout")

        # Running sessions: two finished and idle, one still busy while recording.
        for name, prompt in [
            ("weather-api", "Add a rate limiter to src/server.js: 60 requests per minute per IP"),
            ("acme-shop", "The checkout e2e test times out on slow CI runners. Find out why and fix it"),
        ]:
            term = worker(name, prompt)
            running.append(term)
            wait_idle(term, repo(name))
        running.append(worker("dotfiles", "Run scripts/lint.sh and tell me what it reports"))
        time.sleep(15)

        record()
        scrub(OUT)
    finally:
        for term in running:
            term.send("\x03\x03")
            term.close(3)
    print("done")


if __name__ == "__main__":
    main()
