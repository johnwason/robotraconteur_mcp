#!/usr/bin/env python3
"""A simulated robot using the standard Robot type, whose joints follow their commands exactly.

It runs until its stdin closes. To run it in the background, keep stdin open, such as with
`tail -f /dev/null | python3 loopback_robot.py`."""
import argparse
import json
import os
import sys
import threading
import time

import numpy as np
import RobotRaconteur as RR
import RobotRaconteurCompanion as RRC
import general_robotics_toolbox as rox
from RobotRaconteurCompanion.Util.GeometryUtil import GeometryUtil
from RobotRaconteurCompanion.Util.RobotUtil import RobotUtil
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
        # The kinematics from robot_info, so that the endpoint pose follows the joints
        self._rox_robot = RobotUtil(node=RRN).robot_info_to_rox_robot(robot_info, 0)
        self._geom = GeometryUtil(node=RRN)

    def _run_timestep(self, now):
        stamp = self._stopwatch_ellapsed_s()
        self._last_joint_state = stamp
        self._last_endpoint_state = stamp
        self._last_robot_state = stamp
        self._enabled = True
        self._ready = True
        self._joint_position = np.copy(self._simulated_position)
        # One pose per chain, each a one-element array, as the abstract robot's tool transform expects
        self._endpoint_pose = [self._geom.rox_transform_to_pose(rox.fwdkin(self._rox_robot, self._joint_position)).reshape((1,))]
        super()._run_timestep(now)

    def _send_robot_command(self, now, joint_pos_cmd, joint_vel_cmd):
        if joint_pos_cmd is not None:
            self._simulated_position = np.copy(joint_pos_cmd)

    def tool_detached(self, chain, tool_name):
        # The abstract robot 0.2.3 reads the attached tool's name from the list of tools rather than
        # from the chain's entry, so detaching a tool by its name always fails. Check the name here,
        # then let it detach the tool without one
        if tool_name:
            with self._lock:
                tool = self._current_tool[chain] if 0 <= chain < len(self._current_tool) else None
                device_info = tool.device_info if tool is not None else None
                name = device_info.device.name if device_info is not None and device_info.device is not None else ""
            if tool is not None and name != tool_name:
                raise RR.InvalidArgumentException(f"Invalid tool name to detach from kinematic chain {chain}")
        super().tool_detached(chain, "")

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
    # Stop the driver's update loop after this many seconds, so its wires stop updating while its
    # properties still answer, as a driver whose loop has died does
    parser.add_argument("--freeze-after", type=float, default=None)
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
        # On a timer, so the robot still runs until its stdin closes, as it does without the option
        if args.freeze_after is not None:
            freeze = threading.Timer(args.freeze_after, lambda: setattr(robot, "_keep_going", False))
            freeze.daemon = True
            freeze.start()
        sys.stdin.read()
        robot._close()


if __name__ == "__main__":
    main()
