#!/usr/bin/env python3
"""A trajectory planner that makes long joint trajectories for the loopback robot.

plan_trajectory takes the robot's current joint position and a duration, and returns a JointTrajectory
with waypoints 50 ms apart that can be passed to Robot execute_trajectory. Each joint swings away from
its current position and back several times, so the trajectory starts and ends at the current position
with zero velocity. It runs until its stdin closes."""
import argparse
import os
import sys

import numpy as np
import RobotRaconteur as RR
import RobotRaconteurCompanion as RRC

RRN = RR.RobotRaconteurNode.s

_robdef = """
service experimental.trajectory_planner

stdver 0.10

import com.robotraconteur.robotics.trajectory

using com.robotraconteur.robotics.trajectory.JointTrajectory

## Plans long joint trajectories for the simulated robots, for testing
object TrajectoryPlanner
    ## The time between waypoints, in seconds
    property double waypoint_period [readonly]
    ## The longest trajectory that can be planned, in seconds
    property double max_duration [readonly]
    ## Plan a trajectory of the given duration in seconds, starting and ending at current_position,
    ## the robot's joint positions in radians. Each joint swings up to 0.3 rad away and back. The
    ## duration is rounded to a whole number of waypoint periods. Pass the result to the robot's
    ## execute_trajectory in trajectory command mode
    function JointTrajectory plan_trajectory(double[] current_position, double duration)
end
"""

_WAYPOINT_PERIOD = 0.05
_MAX_DURATION = 600.0
# How far each joint swings from its current position, in radians
_AMPLITUDE = 0.3
# The time for one swing out and back, in seconds
_SWING_PERIOD = 4.0


class TrajectoryPlannerImpl:
    def __init__(self, robot_info):
        self.waypoint_period = _WAYPOINT_PERIOD
        self.max_duration = _MAX_DURATION
        joints = robot_info.joint_info
        self._joint_names = [j.joint_identifier.name for j in joints]
        self._lower = np.array([j.joint_limits.lower for j in joints])
        self._upper = np.array([j.joint_limits.upper for j in joints])
        self._vel_max = np.array([j.joint_limits.velocity for j in joints])
        self._traj_type = RRN.GetStructureType("com.robotraconteur.robotics.trajectory.JointTrajectory")
        self._waypoint_type = RRN.GetStructureType("com.robotraconteur.robotics.trajectory.JointTrajectoryWaypoint")
        self._radian = RRN.GetConstants("com.robotraconteur.robotics.joints")["JointPositionUnits"]["radian"]

    def plan_trajectory(self, current_position, duration):
        q0 = np.asarray(current_position, dtype=np.float64).flatten()
        n_joints = len(self._joint_names)
        if len(q0) != n_joints:
            raise RR.InvalidArgumentException(f"current_position must have {n_joints} joints, not {len(q0)}")
        if np.any(q0 < self._lower) or np.any(q0 > self._upper):
            raise RR.InvalidArgumentException("current_position exceeds joint limits")
        if not np.isfinite(duration) or duration <= 0 or duration > _MAX_DURATION:
            raise RR.InvalidArgumentException(f"duration must be greater than zero and at most {_MAX_DURATION} seconds")
        n_periods = int(round(duration / _WAYPOINT_PERIOD))
        # The robot needs at least five waypoints
        if n_periods < 4:
            raise RR.InvalidArgumentException(f"duration must be at least {4 * _WAYPOINT_PERIOD} seconds")

        # Swing each joint toward the side of its range with more room, by at most _AMPLITUDE
        room_up = self._upper - q0
        room_down = q0 - self._lower
        direction = np.where(room_up >= room_down, 1.0, -1.0)
        amplitude = direction * np.minimum(_AMPLITUDE, 0.9 * np.maximum(room_up, room_down))

        total_time = n_periods * _WAYPOINT_PERIOD
        n_swings = max(1, int(round(total_time / _SWING_PERIOD)))
        # offset = A sin^2(pi k t / T), which starts and ends at zero with zero velocity
        w = np.pi * n_swings / total_time
        # Keep the peak velocity A w under half of each joint's limit
        amplitude = np.sign(amplitude) * np.minimum(np.abs(amplitude), 0.5 * self._vel_max / w)

        traj = self._traj_type()
        traj.joint_names = list(self._joint_names)
        traj.joint_units = [self._radian] * n_joints
        traj.waypoints = []
        for i in range(n_periods + 1):
            t = i * _WAYPOINT_PERIOD
            s = np.sin(w * t)
            wp = self._waypoint_type()
            wp.joint_position = q0 + amplitude * s * s
            wp.joint_velocity = amplitude * 2.0 * s * np.cos(w * t) * w
            wp.position_tolerance = np.zeros((0,))
            wp.velocity_tolerance = np.zeros((0,))
            wp.time_from_start = t
            traj.waypoints.append(wp)
        # End exactly where it started
        traj.waypoints[-1].joint_position = np.copy(q0)
        traj.waypoints[-1].joint_velocity = np.zeros((n_joints,))
        return traj


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--nodename", default="trajectory_planner")
    parser.add_argument("--port", type=int, default=52720)
    parser.add_argument("--robot-info", default=None,
                        help="The robot's info file, by default the loopback robot's ABB 1200 config")
    args, _ = parser.parse_known_args()

    RRC.RegisterStdRobDefServiceTypes(RRN)
    config = args.robot_info or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                             "abb_1200_5_90_robot_default_config.yml")
    with open(config) as f:
        robot_info = RRC.InfoParser(node=RRN).ParseInfoString(f.read(), "com.robotraconteur.robotics.robot.RobotInfo")

    with RR.ServerNodeSetup(args.nodename, args.port, argv=[sys.argv[0]]):
        RRN.RegisterServiceType(_robdef)
        RRN.RegisterService("planner", "experimental.trajectory_planner.TrajectoryPlanner",
                            TrajectoryPlannerImpl(robot_info))
        print(f"PORT {args.port}", flush=True)
        sys.stdin.read()


if __name__ == "__main__":
    main()
