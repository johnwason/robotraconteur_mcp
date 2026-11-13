#!/usr/bin/env python3
"""Run the Core Python test services using the configuration from Core's own pytest fixture.

Copied from robotraconteur_typescript test/server. RR_CORE_TEST is the test folder of a checkout of
Robot Raconteur Core, which the development image and CI provide."""
import os
import sys

core = os.environ["RR_CORE_TEST"]
os.environ["ROBOTRACONTEUR_ROBDEF_PATH"] = os.path.join(core, "robdef")
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(core, "python"))

from RobotRaconteurTest.service_test_util import TestServerNodeConfig  # noqa: E402

config = TestServerNodeConfig("rr_ts_test_server")
print(f"PORT {config.node_setup.tcp_transport.GetListenPort()}", flush=True)
sys.stdin.read()
config.shutdown()
