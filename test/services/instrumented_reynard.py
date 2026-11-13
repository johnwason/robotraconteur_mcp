#!/usr/bin/env python3
"""Reynard the Robot with a diagnostics service, for testing without a person at the web page.

Runs Reynard as `python -m reynard_the_robot` does, with the same `reynard` service on port 29200 and
web page on port 29201, and adds a `reynard_diagnostics` service to the same node. It can send chat
messages as if typed in the web page, now or after a delay so that one arrives while a sequence runs,
and logs what Reynard is asked to do, in the units the `reynard` service uses, with wall clock times.

    python test/services/instrumented_reynard.py

Robot Raconteur command line options, such as --robotraconteur-tcp-port, are passed on.
"""
import argparse
import collections
import datetime
import json
import sys
import threading
import time

import drekar_launch_process
import numpy as np
import RobotRaconteur as RR
from reynard_the_robot.reynard import Reynard
from reynard_the_robot.robotraconteur import ReynardRobotRaconteurService

_diagnostics_robdef = """
## Diagnostics for testing with Reynard the Robot without a person at the web page. Not part of
## Reynard itself. It can send chat messages as if typed in the web page, and keeps a log of what
## Reynard was asked to do, with ISO 8601 UTC times on the wall clock that event times use.
service experimental.reynard_diagnostics

stdver 0.10

## One thing Reynard was asked to do, or a chat message
struct LogEntry
    ## When, as an ISO 8601 UTC time with milliseconds, such as 2026-11-13T06:59:17.712Z, the form
    ## event times are given in
    field string time
    ## say, color, teleport, set_arm_position, drive_robot, drive_arm, or message
    field string kind
    ## The text said, or the chat message
    field string text
    ## The values in the units of the reynard service: color [r, g, b], teleport [x, y] in m,
    ## set_arm_position [q1, q2, q3] in rad, drive_robot [vel_x, vel_y, timeout, wait] in m/s and s,
    ## drive_arm [q1, q2, q3, timeout, wait] in rad/s and s, with wait 1 or 0
    field double[] values
end

## Diagnostics for Reynard the Robot
object Diagnostics
    ## Send a chat message to Reynard now, as if a person typed it in the web page.
    ## Reynard's new_message event fires with it.
    function void send_message(string message)

    ## Send a chat message delay seconds after this call arrives, without waiting for it. Use it to
    ## have a message arrive while a sequence runs.
    function void send_message_after(string message, double delay)

    ## Cancel the messages scheduled with send_message_after that have not been sent yet
    function void cancel_scheduled_messages()

    ## The log from an ISO 8601 time on, such as a sequence's started time, oldest first. An empty
    ## string gives all of it. The log keeps the last 1000 entries.
    function LogEntry{list} read_log(string since)

    ## Empty the log
    function void clear_log()
end
"""

_LOG_SIZE = 1000


def _parse_iso(text):
    """Seconds since 1970 from an ISO 8601 time. A time without a zone is taken as UTC"""
    try:
        t = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise RR.InvalidArgumentException(f"since must be an ISO 8601 time, such as 2026-11-13T06:59:17.712Z, or an empty string, not {text!r}")
    if t.tzinfo is None:
        t = t.replace(tzinfo=datetime.timezone.utc)
    return t.timestamp()


class _Log:
    def __init__(self):
        self._lock = threading.Lock()
        self._entries = collections.deque(maxlen=_LOG_SIZE)

    def add(self, kind, text="", values=()):
        now = time.time()
        iso = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self._lock:
            self._entries.append((now, iso, kind, text, [float(v) for v in values]))

    def since(self, since):
        t = _parse_iso(since) if since else 0.0
        with self._lock:
            return [e for e in self._entries if e[0] >= t]

    def clear(self):
        with self._lock:
            self._entries.clear()


class InstrumentedReynard(Reynard):
    """Reynard, logging each request in the units of the reynard service: m, rad, and seconds"""

    def __init__(self, log, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._log = log
        # Logs chat messages from the web page and from send_message alike
        self.new_message.connect(self._log_message)

    def _log_message(self, _, message):
        self._log.add("message", message)

    def teleport(self, x, y):
        self._log.add("teleport", values=(x * 1e-3, y * 1e-3))
        super().teleport(x, y)

    def say(self, message):
        self._log.add("say", message)
        super().say(message)

    def set_arm_position(self, q1, q2, q3):
        self._log.add("set_arm_position", values=np.deg2rad((q1, q2, q3)))
        super().set_arm_position(q1, q2, q3)

    def drive_robot(self, vel_x, vel_y, timeout=-1, wait=False):
        self._log.add("drive_robot", values=(vel_x * 1e-3, vel_y * 1e-3, timeout, 1 if wait else 0))
        super().drive_robot(vel_x, vel_y, timeout, wait)

    def drive_arm(self, q1, q2, q3, timeout=-1, wait=False):
        self._log.add("drive_arm", values=(*np.deg2rad((q1, q2, q3)), timeout, 1 if wait else 0))
        super().drive_arm(q1, q2, q3, timeout, wait)

    @property
    def color(self):
        return self._color

    @color.setter
    def color(self, color):
        self._log.add("color", values=color)
        Reynard.color.fset(self, color)


class DiagnosticsImpl:
    def __init__(self, reynard, log, node):
        self._reynard = reynard
        self._log = log
        self._entry_type = node.GetStructureType("experimental.reynard_diagnostics.LogEntry")
        self._lock = threading.Lock()
        self._timers = set()

    def send_message(self, message):
        # The same signal the web page's chat box sends
        self._reynard.new_message.send(None, message=message)

    def send_message_after(self, message, delay):
        if not np.isfinite(delay) or delay < 0 or delay > 3600:
            raise RR.InvalidArgumentException("delay must be from 0 to 3600 seconds")

        def send():
            with self._lock:
                self._timers.discard(timer)
            self.send_message(message)

        timer = threading.Timer(delay, send)
        timer.daemon = True
        with self._lock:
            self._timers.add(timer)
        timer.start()

    def cancel_scheduled_messages(self):
        with self._lock:
            timers = list(self._timers)
            self._timers.clear()
        for t in timers:
            t.cancel()

    def read_log(self, since):
        out = []
        for _, iso, kind, text, values in self._log.since(since):
            e = self._entry_type()
            e.time = iso
            e.kind = kind
            e.text = text
            e.values = np.array(values, dtype=np.float64)
            out.append(e)
        return out

    def clear_log(self):
        self._log.clear()


def main():
    parser = argparse.ArgumentParser("instrumented_reynard")
    parser.add_argument("--http-port", type=int, default=29201, help="Port for the web page")
    args, _ = parser.parse_known_args()

    log = _Log()
    reynard = InstrumentedReynard(log, "localhost", args.http_port)
    reynard.start()
    rr_server = None
    try:
        rr_server = ReynardRobotRaconteurService(reynard, sys.argv)
        # A second service on Reynard's node
        node = rr_server._node
        node.RegisterServiceType(_diagnostics_robdef)
        node.RegisterService("reynard_diagnostics", "experimental.reynard_diagnostics.Diagnostics", DiagnosticsImpl(reynard, log, node))
        print(f"Reynard the Robot with diagnostics started on http://localhost:{args.http_port}", flush=True)
        rr_server.print_info()
        drekar_launch_process.wait_exit()
    finally:
        reynard.close()
        if rr_server is not None:
            rr_server.close()


if __name__ == "__main__":
    main()
