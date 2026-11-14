#!/usr/bin/env python3
"""A trajectory planner that makes joint trajectories for the loopback robot.

It plans as the Tesseract Robot Raconteur service's TaskExecutor run does: each function returns a
generator of PlanStatus, which reports running while it plans, then complete with the plan in its
data_storage, under "trajectory", as a varvalue JointTrajectory with waypoints 50 ms apart that can be
passed to Robot execute_trajectory. plan_move moves smoothly from one joint position to another, and
plan_trajectory swings each joint away from its current position and back several times. It runs
until its stdin closes."""
import argparse
import os
import sys
import threading
import time

import numpy as np
import RobotRaconteur as RR
import RobotRaconteurCompanion as RRC

RRN = RR.RobotRaconteurNode.s

_robdef = """
service experimental.trajectory_planner

stdver 0.10

import com.robotraconteur.action
import com.robotraconteur.robotics.trajectory

using com.robotraconteur.action.ActionStatusCode
using com.robotraconteur.robotics.trajectory.JointTrajectory

## The progress of a plan, as the Tesseract service's TaskExecutorStatus gives it
struct PlanStatus
    ## running while planning, then complete
    field ActionStatusCode action_status
    ## Once complete, the plan under "trajectory", a varvalue JointTrajectory
    field varvalue{string} data_storage
    field varvalue{string} extended
end

## Plans joint trajectories for the simulated robots, for testing. Each function returns a generator
## of PlanStatus: call next until it ends; the last status, complete, carries the plan in
## data_storage under "trajectory"
object TrajectoryPlanner
    ## The time between waypoints, in seconds
    property double waypoint_period [readonly]
    ## The longest trajectory that can be planned, in seconds
    property double max_duration [readonly]
    ## Plan a trajectory of the given duration in seconds, starting and ending at current_position,
    ## the robot's joint positions in radians. Each joint swings up to 0.3 rad away and back. The
    ## duration is rounded to a whole number of waypoint periods. Pass the plan to the robot's
    ## execute_trajectory in trajectory command mode
    function PlanStatus{generator} plan_trajectory(double[] current_position, double duration)
    ## Plan a smooth move from current_position to target_position, the robot's joint positions in
    ## radians, taking duration seconds, starting and ending at rest. The target must be within the
    ## joint limits, and the move slow enough for the joint velocity limits. Pass the plan to the
    ## robot's execute_trajectory in trajectory command mode
    function PlanStatus{generator} plan_move(double[] current_position, double[] target_position, double duration)
end
"""

_WAYPOINT_PERIOD = 0.05
_MAX_DURATION = 600.0
# How far each joint swings from its current position, in radians
_AMPLITUDE = 0.3
# The time for one swing out and back, in seconds
_SWING_PERIOD = 4.0
# How long planning takes, so that a running status comes before the plan, as from a real planner
_PLANNING_S = 0.3


class _PlanGenerator:
    """Gives running, then complete with the plan, then ends, as a Tesseract task's generator does"""

    def __init__(self, planner, trajectory):
        self._planner = planner
        self._trajectory = trajectory
        self._step = 0
        self._lock = threading.Lock()

    def Next(self):
        with self._lock:
            step = self._step
            self._step += 1
        if step == 0:
            time.sleep(_PLANNING_S)
            return self._planner._status("running")
        if step == 1:
            return self._planner._status("complete", self._trajectory)
        raise RR.StopIterationException("")

    def Close(self):
        with self._lock:
            self._step = 2

    def Abort(self):
        with self._lock:
            self._step = 2


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
        self._status_type = RRN.GetStructureType("experimental.trajectory_planner.PlanStatus")
        self._action_status = RRN.GetConstants("com.robotraconteur.action")["ActionStatusCode"]

    def _status(self, action_status, trajectory=None):
        s = self._status_type()
        s.action_status = self._action_status[action_status]
        s.data_storage = {}
        if trajectory is not None:
            s.data_storage["trajectory"] = RR.VarValue(trajectory, "com.robotraconteur.robotics.trajectory.JointTrajectory")
        s.extended = {}
        return s

    def _trajectory(self, positions, velocities, times):
        traj = self._traj_type()
        traj.joint_names = list(self._joint_names)
        traj.joint_units = [self._radian] * len(self._joint_names)
        traj.waypoints = []
        for q, v, t in zip(positions, velocities, times):
            wp = self._waypoint_type()
            wp.joint_position = q
            wp.joint_velocity = v
            wp.position_tolerance = np.zeros((0,))
            wp.velocity_tolerance = np.zeros((0,))
            wp.time_from_start = t
            traj.waypoints.append(wp)
        return traj

    def _check_position(self, q, name):
        n_joints = len(self._joint_names)
        if len(q) != n_joints:
            raise RR.InvalidArgumentException(f"{name} must have {n_joints} joints, not {len(q)}")
        for i in range(n_joints):
            if not (self._lower[i] <= q[i] <= self._upper[i]):
                raise RR.InvalidArgumentException(f"{name} joint {i} ({self._joint_names[i]}) is {q[i]}, outside its limits of {self._lower[i]} to {self._upper[i]}")

    def plan_move(self, current_position, target_position, duration):
        q0 = np.asarray(current_position, dtype=np.float64).flatten()
        q1 = np.asarray(target_position, dtype=np.float64).flatten()
        self._check_position(q0, "current_position")
        self._check_position(q1, "target_position")
        if not np.isfinite(duration) or duration <= 0 or duration > _MAX_DURATION:
            raise RR.InvalidArgumentException(f"duration must be greater than zero and at most {_MAX_DURATION} seconds")
        n_periods = max(4, int(np.ceil(duration / _WAYPOINT_PERIOD)))
        total_time = n_periods * _WAYPOINT_PERIOD
        # blend = (1 - cos(pi t / T)) / 2, which starts and ends at rest, with peak velocity pi / (2 T) times the distance
        delta = q1 - q0
        peak = np.abs(delta) * np.pi / (2 * total_time)
        too_fast = np.nonzero(peak > self._vel_max)[0]
        if len(too_fast) > 0:
            i = int(too_fast[0])
            needed = np.abs(delta[i]) * np.pi / (2 * self._vel_max[i])
            raise RR.InvalidArgumentException(f"joint {i} ({self._joint_names[i]}) would move at {peak[i]:.3f} rad/s, over its limit of {self._vel_max[i]:.3f}. Use a duration of at least {needed:.2f} seconds")
        times = [i * _WAYPOINT_PERIOD for i in range(n_periods + 1)]
        positions = [q0 + delta * (1 - np.cos(np.pi * t / total_time)) / 2 for t in times]
        velocities = [delta * np.pi / (2 * total_time) * np.sin(np.pi * t / total_time) for t in times]
        positions[-1] = np.copy(q1)
        velocities[-1] = np.zeros(len(q0))
        return _PlanGenerator(self, self._trajectory(positions, velocities, times))

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
        return _PlanGenerator(self, traj)


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
