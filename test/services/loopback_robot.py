#!/usr/bin/env python3
"""A simulated robot using the standard Robot type, whose joints follow their commands exactly."""
import argparse
import json
import os
import sys
import time

import numpy as np
import RobotRaconteur as RR
import RobotRaconteurCompanion as RRC
from robotraconteur_abstract_robot import AbstractRobot

RRN = RR.RobotRaconteurNode.s


class LoopbackRobot(AbstractRobot):
    def __init__(self, robot_info):
        super().__init__(robot_info, 6)
        self._uses_homing = False
        self._has_position_command = True
        self._has_velocity_command = False
        self._update_period = 0.01
        self._base_set_controller_state = True
        self._base_set_operational_mode = True
        self._simulated_position = np.zeros((6,))

    def _run_timestep(self, now):
        stamp = self._stopwatch_ellapsed_s()
        self._last_joint_state = stamp
        self._last_endpoint_state = stamp
        self._last_robot_state = stamp
        self._enabled = True
        self._ready = True
        self._joint_position = np.copy(self._simulated_position)
        pose = np.zeros((1,), dtype=self._pose_dtype)
        pose[0]["orientation"]["w"] = 1.0
        self._endpoint_pose = pose
        super()._run_timestep(now)

    def _send_robot_command(self, now, joint_pos_cmd, joint_vel_cmd):
        if joint_pos_cmd is not None:
            self._simulated_position = np.copy(joint_pos_cmd)

    def _send_disable(self, handler):
        handler(None)

    def _send_enable(self, handler):
        handler(None)

    def _send_reset_errors(self, handler):
        handler(None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--nodename", default="loopback_robot")
    parser.add_argument("--port", type=int, default=52700)
    parser.add_argument("--attributes", default="{}")
    args, _ = parser.parse_known_args()

    RRC.RegisterStdRobDefServiceTypes(RRN)
    config = os.path.join(os.path.dirname(os.path.abspath(__file__)), "abb_1200_5_90_robot_default_config.yml")
    with open(config) as f:
        robot_info = RRC.InfoParser(node=RRN).ParseInfoString(f.read(), "com.robotraconteur.robotics.robot.RobotInfo")

    robot = LoopbackRobot(robot_info)
    robot._start_robot()
    time.sleep(0.5)
    with RR.ServerNodeSetup(args.nodename, args.port, argv=[sys.argv[0]]):
        context = RRN.RegisterService("robot", "com.robotraconteur.robotics.robot.Robot", robot)
        attributes = {k: RR.VarValue(v, "string") for k, v in json.loads(args.attributes).items()}
        context.SetServiceAttributes(attributes)
        print(f"PORT {args.port}", flush=True)
        sys.stdin.read()
        robot._close()


if __name__ == "__main__":
    main()
