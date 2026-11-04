# claude-session-hub

See every Claude Code session running on your machine in one pane, and jump to
any of them with a single key.

```
○ web-app-d7  idle · 2m                                     [ 1 Jump ]
  web-app @ main  ~/code/web-app
  Fix flaky checkout test
  › why does the e2e job time out on arm runners?
    ⚙ Bash: Run the e2e suite locally
○ api-server-e4  idle · 10m                                 [ 2 Jump ]
  ...
● dotfiles-a1  busy · 0s                               (this session)
```

For each session the pane shows:

- the session's **name** and whether it is **busy or idle**, and when it was last active
- the **repo, branch and folder** it runs in
- its **title** and its **last 3 prompts**
- its **last 3 tool calls** (commands run, files edited, ...)

Busy sessions are listed first. The pane refreshes every 5 seconds while it is open.

## Requirements

- **Claude Code 2.1.318 or newer.** session-hub is a *mod* (a plugin with a
  hooks module), an early-access feature of Claude Code.
- **macOS or Linux.**
- `git` (to show repo and branch). Optional, for jumping on Linux:
  `tmux`, `wmctrl` or `xdotool`.

## Install

In Claude Code, type:

```
/plugin install session-hub --marketplace devoriales/claude-session-hub
```

1. Answer `y` when asked to add the marketplace `github:devoriales/claude-session-hub`.
2. Pick the **user** scope (press Enter), so it loads in every session.
3. You should see `Installed session-hub. Plugin is now active.`

Or install it from a shell:

```sh
claude plugin install session-hub --marketplace devoriales/claude-session-hub
```

**In the Claude desktop app:** click **+** next to the prompt box, then
**Plugins** → **Add marketplace** → `devoriales/claude-session-hub` → **Add plugin**.

## Use

1. Type `/sessions` to open the pane. (On a terminal 144 columns or wider it also
   opens by itself when a session starts.)
2. Press `ctrl+x tab` (or click the pane) to give it the keyboard.
3. Press `1`–`9`, or click **Jump**, to switch to that session.

The session you are in is listed last, marked `(this session)`.

### What "Jump" does

| Where the other session runs | What happens |
| --- | --- |
| tmux (macOS / Linux) | switches to that tmux pane |
| iTerm2 or Terminal.app (macOS) | brings that exact tab to the front |
| VS Code, Cursor, Windsurf, VSCodium (macOS / Linux) | brings the editor window for that folder to the front |
| Another terminal app (macOS) | brings that app to the front |
| An X11 terminal (Linux, with `wmctrl` or `xdotool`) | brings that window to the front |
| A background session (`claude --bg`) | opens a new terminal window running `claude attach` |
| Anything else (for example Wayland without tmux) | copies a `cd` command to your clipboard and tells you which terminal it is on |

On macOS, the first jump may ask you to let Claude Code control iTerm2 or
Terminal (System Settings → Privacy & Security → Automation). Allow it.

## Update or remove

```
/plugin update session-hub
/plugin uninstall session-hub
```

## How it works

- The session list comes from `claude agents --json`.
- Titles, prompts and tool calls are read from the end of each session's
  transcript in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). A
  transcript is only re-read when it changes.
- Jumping is done by [`bin/jump.sh`](bin/jump.sh), a small POSIX shell script.

Everything stays on your machine: session-hub makes no network calls.

## Develop

```sh
git clone https://github.com/devoriales/claude-session-hub
claude --plugin-dir ./claude-session-hub      # start a session with your local copy loaded
claude plugin validate ./claude-session-hub   # check the manifest and hooks module
```

The pane is in [`hooks/register.tsx`](hooks/register.tsx).

## License

[MIT](LICENSE)
