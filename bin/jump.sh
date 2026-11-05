#!/bin/sh
# Bring another Claude Code session to the front.
#
# usage: jump.sh <pid> <kind> <session-id> <cwd>
#        jump.sh 0 resume <session-id> <cwd>   open a terminal running `claude --resume`
#
# Prints one line:
#   focused <how>   the terminal holding that session is now in front
#   opened <how>    a new terminal window was opened attached to it (background sessions)
#   fallback <tty>  nothing could be focused; the caller copies a command instead
#
# Works on macOS (iTerm2, Terminal.app, any other .app as a last resort) and
# Linux (tmux, or X11 via wmctrl / xdotool). Wayland without tmux falls back.

pid=$1
kind=$2
sid=$3
cwd=$4
os=$(uname -s)

tty_of() {
  t=$(ps -o tty= -p "$1" 2>/dev/null | tr -d ' ')
  case $t in '' | '?' | '??' | '-') return 1 ;; esac
  case $t in /dev/*) echo "$t" ;; *) echo "/dev/$t" ;; esac
}

# Is a macOS app running? Ask LaunchServices by bundle id (does not launch it);
# pgrep alone misses iTerm2 in some setups.
mac_running() {
  [ "$(osascript -e "application id \"$1\" is running" 2>/dev/null)" = true ] || pgrep -xq "$2"
}

# Which macOS terminal new windows open in: $SESSION_HUB_TERMINAL (iterm or
# terminal) wins, else the one Claude Code itself runs in, else auto.
mac_pref() {
  case $(printf '%s' "${SESSION_HUB_TERMINAL:-}" | tr '[:upper:]' '[:lower:]') in
    iterm | iterm2) echo iterm; return ;;
    terminal | apple_terminal) echo terminal; return ;;
  esac
  case ${TERM_PROGRAM:-} in
    iTerm.app) echo iterm ;;
    Apple_Terminal) echo terminal ;;
    *) echo auto ;;
  esac
}

parent_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }

# Every ancestor pid of $1, nearest first.
ancestors() {
  p=$1
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
    echo "$p"
    p=$(parent_of "$p")
  done
}

try_tmux() {
  command -v tmux >/dev/null 2>&1 || return 1
  target=$(tmux list-panes -a -F '#{pane_tty} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null |
    awk -v t="$1" '$1 == t { print $2; exit }')
  [ -n "$target" ] || return 1
  tmux select-window -t "$target" 2>/dev/null
  tmux select-pane -t "$target" 2>/dev/null
  # Switch the attached client (ours, if we run inside tmux) to that session.
  tmux switch-client -t "$target" 2>/dev/null
  echo "focused tmux $target"
}

mac_iterm() {
  mac_running com.googlecode.iterm2 iTerm2 || return 1
  r=$(osascript - "$1" <<'OSA' 2>/dev/null
on run argv
  set t to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          if tty of s is t then
            tell w to select
            tell tb to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "no"
end run
OSA
)
  [ "$r" = ok ] && echo "focused iTerm2"
}

mac_terminal() {
  mac_running com.apple.Terminal Terminal || return 1
  r=$(osascript - "$1" <<'OSA' 2>/dev/null
on run argv
  set t to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with tb in tabs of w
        if tty of tb is t then
          set selected of tb to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "no"
end run
OSA
)
  [ "$r" = ok ] && echo "focused Terminal"
}

# Any other macOS terminal (Ghostty, WezTerm, kitty, VS Code...): bring its
# app to the front. It cannot pick the tab, but gets you to the right window set.
mac_app() {
  for p in $(ancestors "$1"); do
    exe=$(ps -o comm= -p "$p" 2>/dev/null)
    case $exe in
      *.app/*)
        app=$(printf '%s\n' "$exe" | sed 's#\(\.app\)/.*#\1#')
        name=$(basename "$app" .app)
        case $name in
          # Editors: opening the folder raises the window that has it open.
          *Code* | Cursor | Windsurf | VSCodium | Zed)
            open -a "$app" "$cwd" 2>/dev/null && echo "focused $name window" && return 0 ;;
        esac
        open -a "$app" 2>/dev/null && echo "focused $name" && return 0
        ;;
    esac
  done
  return 1
}

# VS Code-family editor terminals: `code <folder>` raises the window that has it.
# Works on X11 and Wayland alike.
linux_editor() {
  for p in $(ancestors "$1"); do
    exe=$(readlink "/proc/$p/exe" 2>/dev/null || ps -o comm= -p "$p")
    for ed in code code-insiders cursor windsurf codium; do
      case $(basename "$exe") in
        "$ed" | "$ed".bin | "$ed"-*)
          command -v "$ed" >/dev/null 2>&1 && "$ed" "$cwd" >/dev/null 2>&1 &&
            echo "focused $ed window" && return 0 ;;
      esac
    done
    case $exe in
      */code/code | */Code/code | */code-insiders/*)
        command -v code >/dev/null 2>&1 && code "$cwd" >/dev/null 2>&1 &&
          echo "focused code window" && return 0 ;;
    esac
  done
  return 1
}

linux_x11() {
  [ -n "$DISPLAY" ] || return 1
  for p in $(ancestors "$1"); do
    if command -v wmctrl >/dev/null 2>&1; then
      win=$(wmctrl -lp 2>/dev/null | awk -v p="$p" '$3 == p { print $1; exit }')
      if [ -n "$win" ]; then
        wmctrl -ia "$win" && echo "focused wmctrl" && return 0
      fi
    fi
    if command -v xdotool >/dev/null 2>&1; then
      win=$(xdotool search --pid "$p" 2>/dev/null | head -n 1)
      if [ -n "$win" ]; then
        xdotool windowactivate "$win" 2>/dev/null && echo "focused xdotool" && return 0
      fi
    fi
  done
  return 1
}

# Open a new terminal window in $cwd running `claude $1 $sid`: `attach` for a
# background session (it has no terminal), `--resume` for one that ended.
open_attached() {
  run="claude $1 $sid"
  cmd="cd '$(printf '%s' "$cwd" | sed "s/'/'\\\\''/g")' && $run"
  if [ "$os" = Darwin ]; then
    pref=$(mac_pref)
    if [ "$pref" = iterm ] || { [ "$pref" = auto ] && mac_running com.googlecode.iterm2 iTerm2; }; then
      osascript - "$cmd" <<'OSA' >/dev/null 2>&1 && echo "opened iTerm2" && return 0
on run argv
  tell application "iTerm2"
    set w to (create window with default profile)
    tell current session of w to write text (item 1 of argv)
    activate
  end tell
end run
OSA
    fi
    osascript - "$cmd" <<'OSA' >/dev/null 2>&1 && echo "opened Terminal" && return 0
on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run
OSA
    return 1
  fi
  if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1; then
    tmux new-window -c "$cwd" "$run" && echo "opened tmux" && return 0
  fi
  for term in "$TERMINAL" x-terminal-emulator gnome-terminal konsole kitty alacritty wezterm foot xterm; do
    [ -n "$term" ] && command -v "$term" >/dev/null 2>&1 || continue
    case $term in
      gnome-terminal) set -- "$term" -- sh -c "$cmd; exec \$SHELL" ;;
      wezterm) set -- "$term" start -- sh -c "$cmd; exec \$SHELL" ;;
      kitty | foot) set -- "$term" sh -c "$cmd; exec \$SHELL" ;;
      *) set -- "$term" -e sh -c "$cmd; exec \$SHELL" ;;
    esac
    nohup "$@" >/dev/null 2>&1 &
    echo "opened $term"
    return 0
  done
  return 1
}

if [ "$kind" = resume ]; then
  open_attached --resume && exit 0
  echo "fallback none"
  exit 0
fi

tty=$(tty_of "$pid")

if [ -n "$tty" ]; then
  try_tmux "$tty" && exit 0
  if [ "$os" = Darwin ]; then
    mac_iterm "$tty" && exit 0
    mac_terminal "$tty" && exit 0
    mac_app "$pid" && exit 0
  else
    linux_editor "$pid" && exit 0
    linux_x11 "$pid" && exit 0
  fi
fi

if [ "$kind" != interactive ]; then
  open_attached attach && exit 0
fi

echo "fallback ${tty:-none}"
