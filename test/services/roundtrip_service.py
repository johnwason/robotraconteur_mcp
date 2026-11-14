#!/usr/bin/env python3
"""A service that makes and checks arbitrary large data, for testing the scratchpad.

It stands in for cameras and joint sequences without simulating either: make_frame gives an image
sized struct of pseudo-random bytes, and digest says what arrived, so a test can tell that a value
went from one call to another unchanged. It runs until its stdin closes."""
import argparse
import hashlib
import sys
import threading

import numpy as np
import RobotRaconteur as RR

RRN = RR.RobotRaconteurNode.s

_robdef = """
service experimental.roundtrip

stdver 0.10

struct Frame
    field uint32 width
    field uint32 height
    field string encoding
    field uint8[] data
end

object RoundTrip
    property Frame frame
    function Frame make_frame(uint32 n, uint32 seed)
    function string digest(Frame f)
    function string digest_of(uint32 n, uint32 seed)
    function double[]{list} make_waypoints(uint32 count, uint32 joints)
    function string digest_waypoints(double[]{list} w)
    function double[]{generator} stream_waypoints(uint32 count, uint32 joints)
end
"""


def _bytes(n, seed):
    return np.random.default_rng(seed).integers(0, 256, n, dtype=np.uint8)


def _digest(width, height, encoding, data):
    return f"{width}x{height} {encoding} {hashlib.sha256(np.asarray(data, dtype=np.uint8).tobytes()).hexdigest()}"


def _waypoints(count, joints):
    """Small joint positions that alternate in sign, within the test robot's limits"""
    return [np.array([(i + 1) * 0.05 * (1 if j % 2 == 0 else -1) for j in range(joints)], dtype=np.float64) for i in range(count)]


class _WaypointGenerator:
    def __init__(self, waypoints):
        self._waypoints = list(waypoints)
        self._lock = threading.Lock()

    def Next(self):
        with self._lock:
            if not self._waypoints:
                raise RR.StopIterationException("")
            return self._waypoints.pop(0)

    def Close(self):
        with self._lock:
            self._waypoints = []

    def Abort(self):
        self.Close()


class RoundTripImpl:
    def __init__(self):
        self._frame_type = RRN.GetStructureType("experimental.roundtrip.Frame")
        self.frame = self._frame_type()
        self.frame.encoding = ""
        self.frame.data = np.zeros((0,), dtype=np.uint8)

    def make_frame(self, n, seed):
        f = self._frame_type()
        f.width = n
        f.height = 1
        f.encoding = "mono8"
        f.data = _bytes(n, seed)
        return f

    def digest(self, f):
        return _digest(f.width, f.height, f.encoding, f.data)

    def digest_of(self, n, seed):
        return _digest(n, 1, "mono8", _bytes(n, seed))

    def make_waypoints(self, count, joints):
        return _waypoints(count, joints)

    def digest_waypoints(self, w):
        h = hashlib.sha256()
        for x in w:
            h.update(np.asarray(x, dtype=np.float64).tobytes())
        return f"{len(w)} {h.hexdigest()}"

    def stream_waypoints(self, count, joints):
        return _WaypointGenerator(_waypoints(count, joints))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=52710)
    args, _ = parser.parse_known_args()
    with RR.ServerNodeSetup("roundtrip", args.port, argv=[sys.argv[0]]):
        RRN.RegisterServiceType(_robdef)
        RRN.RegisterService("roundtrip", "experimental.roundtrip.RoundTrip", RoundTripImpl())
        print(f"PORT {args.port}", flush=True)
        sys.stdin.read()


if __name__ == "__main__":
    main()
