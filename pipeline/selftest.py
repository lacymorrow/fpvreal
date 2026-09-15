# The alignment, checked against a flight we made up: a camera flown around
# a bando in a frame that is tilted, rolled and scaled on purpose, then
# recovered. Run: uv run python selftest.py

import math
import sys

import numpy as np

from fpvreal_scene import align, colmap

FAILED = 0


def ok(cond, name):
    global FAILED
    print(f"  {'ok ' if cond else 'FAIL'} {name}")
    if not cond:
        FAILED += 1


def rot(axis, deg):
    axis = np.asarray(axis, float)
    axis /= np.linalg.norm(axis)
    a = math.radians(deg)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K


def synthetic_flight(*, tilt=25, speed=8.0, fps=4, seconds=40, world_rot=None, unit_per_m=0.37, flips=0):
    """A pilot cruising a loop at `speed`, yawing all the way round, camera
    tilted up by `tilt`, in a reconstruction frame rotated by `world_rot` and
    scaled so one metre is `unit_per_m` units. Returns poses + times."""
    world_rot = np.eye(3) if world_rot is None else world_rot
    poses, times = [], {}
    n = int(seconds * fps)
    radius = speed * seconds / (2 * math.pi)
    up_true = np.array([0.0, 1.0, 0.0])
    for k in range(n):
        t = k / fps
        a = 2 * math.pi * t / seconds
        centre_m = np.array([radius * math.sin(a), 2.0 + 0.5 * math.sin(3 * a), -radius * math.cos(a)])
        fwd = np.array([math.cos(a), 0.0, math.sin(a)])  # tangent
        right = np.cross(fwd, up_true)
        # Camera tilt: pitch the forward vector up about the right axis.
        Rt = rot(right, tilt)
        fwd_c = Rt @ fwd
        down_c = np.cross(fwd_c, right)
        if flips and k % (n // flips) < 3:
            # A roll: the right vector leaves the horizontal for three frames.
            Rr = rot(fwd_c, 70)
            right_c, down_c = Rr @ right, Rr @ down_c
        else:
            right_c = right
        name = f"frame_{k:06d}.jpg"
        poses.append({
            "name": name,
            "centre": world_rot @ centre_m * unit_per_m,
            "right": world_rot @ right_c, "down": world_rot @ down_c, "forward": world_rot @ fwd_c,
        })
        times[name] = t
    return poses, times


print("align")
W = rot([0.3, 0.2, 0.9], 130)  # an arbitrary reconstruction frame
poses, times = synthetic_flight(world_rot=W, unit_per_m=0.37)
res = align.align(poses, times, assumed_speed=8.0)
R, s, t = res["R"], res["s"], res["t"]
up_rec = R @ (W @ [0, 1, 0])
ok(abs(up_rec[1] - 1) < 1e-3, f"the flight's up maps to +Y (got {np.round(up_rec, 4)})")
ok(abs(s * 0.37 - 1) < 0.02, f"scale recovers a metre from an assumed 8 m/s ({s * 0.37:.3f})")
ok(abs(res['tilt_deg'] - 25) < 1.0, f"camera tilt reads 25 deg ({res['tilt_deg']:.1f})")
p0 = np.array(res["path"][0][1:])
ok(np.linalg.norm(p0) < 1e-6, "the first frame sits at the origin")
f0 = R @ poses[0]["forward"]
ok(f0[2] < 0 and abs(f0[0]) < 0.05, f"the first frame looks along -Z ({np.round(f0, 3)})")
ok(abs(np.linalg.det(R) - 1) < 1e-6, "the transform is a proper rotation")
q = res["quaternion"]
ok(abs(sum(v * v for v in q) - 1) < 1e-6, "the quaternion is unit")
# The same rotation through the quaternion, Three.js order x y z w.
x, y, z, w = q
Rq = np.array([
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
])
ok(np.abs(Rq - R).max() < 1e-6, "the quaternion rebuilds the matrix")

poses_f, times_f = synthetic_flight(world_rot=W, unit_per_m=0.37, flips=4)
res_f = align.align(poses_f, times_f, assumed_speed=8.0)
up_f = res_f["R"] @ (W @ [0, 1, 0])
ok(abs(up_f[1] - 1) < 5e-3, f"four rolls in the flight do not tip the up vector ({up_f[1]:.4f})")

print("colmap quaternion")
Rc = colmap.qvec_to_rot([1, 0, 0, 0])
ok(np.allclose(Rc, np.eye(3)), "identity qvec is the identity")
ang = math.radians(90)
Rc = colmap.qvec_to_rot([math.cos(ang / 2), 0, math.sin(ang / 2), 0])
ok(np.allclose(Rc @ [0, 0, 1], [1, 0, 0], atol=1e-9), "90 deg about y takes +z to +x")

print("mesh")
from fpvreal_scene import mesh as meshmod
import tempfile, pathlib
from plyfile import PlyData, PlyElement
# A floor of solid splats 20 m by 20 m at y = 0 and a wall along x = 5.
pts = []
for i in range(-40, 41):
    for j in range(-40, 41):
        pts.append((i * 0.25, 0.0, j * 0.25))
for i in range(0, 12):
    for j in range(-20, 21):
        pts.append((5.0, i * 0.25, j * 0.25))
arr = np.zeros(len(pts), dtype=[("x", "f4"), ("y", "f4"), ("z", "f4"), ("opacity", "f4"),
                                ("scale_0", "f4"), ("scale_1", "f4"), ("scale_2", "f4")])
for k, (x, y, z) in enumerate(pts):
    arr[k] = (x, y, z, 4.0, math.log(0.1), math.log(0.1), math.log(0.1))
with tempfile.TemporaryDirectory() as d:
    ply = pathlib.Path(d) / "s.ply"
    PlyData([PlyElement.describe(arr, "vertex")]).write(str(ply))
    transform = {"R": np.eye(3), "s": 1.0, "t": np.zeros(3)}
    path = [[0, -3.0, 1.5, 0.0], [1, 3.0, 1.5, 0.0]]
    verts, faces, bounds = meshmod.build(ply, transform, path, voxel=0.25, margin=8.0)
    ok(len(faces) > 100, f"a floor and a wall give a mesh ({len(faces)} triangles)")
    ys = verts[:, 1]
    ok(ys.min() < -0.5 and (np.abs(ys - 0.0) < 0.4).sum() > 1000, "the floor is at y = 0 and the net is below it")
    ok((np.abs(verts[:, 0] - 5.0) < 0.4).sum() > 200, "the wall stands at x = 5")
    # Space carving: cameras at x = -8 saw points at x = 9, straight through
    # the wall, so the wall must go; the floor, which no sightline crosses, stays.
    # Two cameras per target, so every crossed voxel gets the two votes it needs.
    ys, zs = np.arange(-1.0, 4.6, 0.25), np.arange(-5.0, 5.01, 0.25)
    cams = np.array([[cx, 1.5, zz] for zz in zs for yy in ys for cx in (-8.0, -7.0)])
    tgts = np.array([[9.0, yy, zz] for zz in zs for yy in ys for cx in (-8.0, -7.0)])
    verts2, faces2, _ = meshmod.build(ply, transform, path, voxel=0.25, margin=8.0, sightlines=(cams, tgts))
    ok((np.abs(verts2[:, 0] - 5.0) < 0.4).sum() < (np.abs(verts[:, 0] - 5.0) < 0.4).sum() * 0.3, "sightlines through the wall carve it away")
    ok((np.abs(verts2[:, 1] - 0.0) < 0.4).sum() > 1000, "the floor survives the carving")
    # The flown path: a tube through a wall is open.
    path2 = [[0, 5.0, 1.5, -3.0], [1, 5.0, 1.5, 3.0]]
    verts3, faces3, _ = meshmod.build(ply, transform, path2, voxel=0.25, margin=8.0)
    on_line = lambda v: ((np.abs(v[:, 0] - 5.0) < 0.3) & (np.abs(v[:, 1] - 1.5) < 0.4) & (np.abs(v[:, 2]) < 2.5)).sum()
    ok(on_line(verts3) < on_line(verts) * 0.1, f"the path tube is carved through the wall ({on_line(verts3)} verts left on the line, {on_line(verts)} before)")

print(f"{'FAILED ' + str(FAILED) if FAILED else 'all ok'}")
sys.exit(1 if FAILED else 0)
