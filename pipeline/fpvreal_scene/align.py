# Stage 4: the reconstruction is in COLMAP's frame, up to scale, with no
# idea which way is down. This stage finds down, finds the scale, and builds
# the one transform that carries COLMAP units into the sim's metres: Y up, X
# east, Z south, the first camera at the origin, its nose along -Z.
#
# Down comes from the pilot. An FPV camera is bolted to the frame with a
# tilt and no roll, so over a flight the camera's right vector sweeps the
# horizontal plane while the pilot yaws. The normal of that plane is gravity.
# Frames flown rolled (a flip, a knife-edge) are outliers and are weighted
# down.
#
# Scale comes from the clock. The frames have timestamps, the poses have
# distances, and an FPV pilot cruising a bando moves at a known-ish speed. The
# guess is written into scene.json in the open so it can be corrected.

import math

import numpy as np

from .log import stage


def _rotation_to(a, b):
    """The rotation taking unit vector a onto unit vector b."""
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        axis = np.cross(a, [1, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def _rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def find_up(rights, downs):
    """Gravity's up direction in the reconstruction frame."""
    w = np.ones(len(rights))
    v = None
    for _ in range(5):
        M = (rights * w[:, None]).T @ rights
        eigval, eigvec = np.linalg.eigh(M)
        v = eigvec[:, 0]
        # The weight of a frame drops with how far its right vector leaves the plane.
        w = np.exp(-((rights @ v) ** 2) / 0.15)
    if float((-downs @ v).sum()) < 0:
        v = -v
    return v / np.linalg.norm(v)


def find_scale(poses, times, assumed_speed, max_gap_s=1.0):
    """Metres per reconstruction unit, from the median cruising speed."""
    speeds = []
    for a, b in zip(poses, poses[1:]):
        ta, tb = times.get(a["name"]), times.get(b["name"])
        if ta is None or tb is None or not (0 < tb - ta <= max_gap_s):
            continue
        speeds.append(float(np.linalg.norm(b["centre"] - a["centre"])) / (tb - ta))
    speeds = np.array(speeds)
    speeds = speeds[speeds > 0]
    if len(speeds) < 10:
        raise RuntimeError("too few consecutive registered frames to estimate a speed")
    median_units = float(np.median(speeds))
    return assumed_speed / median_units, median_units


def to_quaternion(R):
    """Three.js order: x, y, z, w."""
    t = np.trace(R)
    if t > 0:
        s = math.sqrt(t + 1) * 2
        return [(R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s, 0.25 * s]
    i = int(np.argmax(np.diag(R)))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = math.sqrt(1 + R[i, i] - R[j, j] - R[k, k]) * 2
    q = [0.0, 0.0, 0.0, 0.0]
    q[i] = 0.25 * s
    q[j] = (R[j, i] + R[i, j]) / s
    q[k] = (R[k, i] + R[i, k]) / s
    q[3] = (R[k, j] - R[j, k]) / s
    return q


def align(poses, times, *, assumed_speed):
    """Returns the transform p_sim = s R p + t, and the flown path in sim metres."""
    rights = np.array([p["right"] for p in poses])
    downs = np.array([p["down"] for p in poses])
    forwards = np.array([p["forward"] for p in poses])
    centres = np.array([p["centre"] for p in poses])

    up = find_up(rights, downs)
    tilt = math.degrees(math.asin(float(np.clip((forwards @ up).mean(), -1, 1))))
    R1 = _rotation_to(up, np.array([0.0, 1.0, 0.0]))

    # Yaw: the first frame looks along -Z.
    f0 = R1 @ forwards[0]
    f0[1] = 0
    f0 /= np.linalg.norm(f0) or 1
    yaw = math.atan2(f0[0], -f0[2])
    R2 = _rot_y(yaw)
    if np.linalg.norm(R2 @ f0 - [0, 0, -1]) > 1e-3:
        R2 = _rot_y(-yaw)
    R = R2 @ R1

    s, median_units = find_scale(poses, times, assumed_speed)
    c0 = centres[0]
    t = -(s * (R @ c0))

    path = []
    for p in poses:
        q = s * (R @ p["centre"]) + t
        path.append([round(float(times.get(p["name"], -1)), 3), *[round(float(v), 3) for v in q]])

    stage("align", f"camera tilt reads {tilt:.0f} deg, median speed {median_units:.3f} units/s, "
                   f"{s:.3f} m per unit at an assumed {assumed_speed} m/s")
    if not (5 <= tilt <= 60):
        stage("align", f"warning: a camera tilt of {tilt:.0f} deg is not an FPV camera; the up vector may be wrong")
    return {
        "R": R, "s": s, "t": t, "quaternion": to_quaternion(R),
        "tilt_deg": tilt, "median_speed_units": median_units, "path": path,
    }
