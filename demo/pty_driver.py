"""Runs programs in pseudo-terminals so the demo needs no terminal windows.

A Term drains its program's output (so it never blocks), answers the few
terminal queries a TUI waits on, and can record an asciicast v2 file that
`agg` turns into a GIF.
"""

import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import termios
import threading
import time

QUERIES = {
    b"\x1b[6n": b"\x1b[1;1R",  # cursor position
    b"\x1b[c": b"\x1b[?62;22c",  # primary device attributes
    b"\x1b[0c": b"\x1b[?62;22c",
    b"\x1b[>c": b"\x1b[>1;10;0c",  # secondary device attributes
    b"\x1b[>0q": b"\x1bP>|xterm(390)\x1b\\",  # terminal name / version
}


class Term:
    def __init__(self, argv, cwd, env, cols=110, rows=36, record=None):
        self.cols, self.rows = cols, rows
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.start = time.time()
        self.cast = open(record, "w") if record else None
        if self.cast:
            header = {"version": 2, "width": cols, "height": rows, "env": {"TERM": "xterm-256color"}}
            self.cast.write(json.dumps(header) + "\n")
        self.alive = True
        self.tail = b""
        # A multi-byte character can straddle two reads.
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self):
        while self.alive:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.2)
                if not ready:
                    continue
                data = os.read(self.fd, 65536)
            except OSError:
                break
            if not data:
                break
            for query, answer in QUERIES.items():
                if query in data:
                    os.write(self.fd, answer)
            self.tail = (self.tail + data)[-20000:]
            if self.cast:
                text = self.decoder.decode(data)
                if not text:
                    continue
                self.cast.write(json.dumps([round(time.time() - self.start, 4), "o", text]) + "\n")
                self.cast.flush()
        self.alive = False

    def send(self, text, per_char=0.0):
        data = text.encode()
        if per_char <= 0:
            os.write(self.fd, data)
            return
        for ch in text:
            os.write(self.fd, ch.encode())
            time.sleep(per_char)

    def stop_recording(self):
        """Ends the recording, so what the program prints on exit stays out of it."""
        cast, self.cast = self.cast, None
        if cast:
            cast.close()

    def running(self):
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            return pid == 0
        except ChildProcessError:
            return False

    def close(self, timeout=10):
        deadline = time.time() + timeout
        while self.running() and time.time() < deadline:
            time.sleep(0.2)
        if self.running():
            os.kill(self.pid, signal.SIGTERM)
            time.sleep(1)
            if self.running():
                os.kill(self.pid, signal.SIGKILL)
        self.alive = False
        if self.cast:
            self.cast.close()
