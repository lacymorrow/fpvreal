# Stage 5: something to crash into. A splat is a cloud of fuzzy blobs with no
# surface, and Rapier wants triangles. Every blob near the flown path pays
# its opacity into a voxel grid, so a wall of faint splats adds up to a wall.
# But a splat also fills free air with haze, and inside a bando the haze the
# pilot flew through is as dense as the floor, so density alone cannot tell
# them apart. Two things can. Every reconstructed point was seen from its
# cameras, so the line from each camera to each of its points is empty
# space; and the flown path is a tube the quad demonstrably fitted through.
# Both are carved out of the grid. Then small islands are dropped, the grid
# is smoothed and a surface is pulled out with marching cubes, decimated to
# a count a browser physics engine is happy with. A safety-net floor sits
# under all of it, so a hole in the reconstruction is a bump, not a fall.

import itertools

import numpy as np
from plyfile import PlyData
from scipy.ndimage import gaussian_filter
from skimage.measure import marching_cubes
from skimage.morphology import remove_small_objects

from .log import stage


def load_splats(ply_path):
    v = PlyData.read(str(ply_path))["vertex"]
    xyz = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float64)
    opacity = 1 / (1 + np.exp(-np.asarray(v["opacity"], dtype=np.float64)))
    scale = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], axis=1).astype(np.float64))
    return xyz, opacity, scale


# A voxel crossed by this many camera-to-point sightlines is free air.
FREE_VOTES = 2
# The flown path is carved as a tube of this radius, in metres.
PATH_TUBE_M = 0.75


def _carve_segments(free, a, b, lo, voxel, dims, chunk=20000):
    """Counts, per voxel, the segments a[i] to b[i] that cross it."""
    step = voxel / 2
    for i in range(0, len(a), chunk):
        aa, bb = a[i:i + chunk], b[i:i + chunk]
        length = np.linalg.norm(bb - aa, axis=1)
        n = int(np.ceil(length.max() / step)) + 1 if len(length) else 0
        if n == 0:
            continue
        ts = np.linspace(0.0, 1.0, n)[None, :, None]
        # Stop one voxel short of the point: the point itself is surface.
        end = aa + (bb - aa) * np.clip(1 - voxel / np.maximum(length, 1e-6), 0, 1)[:, None]
        pts = aa[:, None, :] + (end - aa)[:, None, :] * ts
        idx = np.floor((pts.reshape(-1, 3) - lo) / voxel).astype(int)
        ok = np.all((idx >= 0) & (idx < dims), axis=1)
        idx = idx[ok]
        # One vote per segment per voxel: dedupe within the chunk's samples.
        seg = np.repeat(np.arange(len(aa)), n)[ok]
        key = np.unique(np.stack([seg, idx[:, 0], idx[:, 1], idx[:, 2]], axis=1), axis=0)
        np.add.at(free, (key[:, 1], key[:, 2], key[:, 3]), 1)


def build(ply_path, transform, path, *, voxel=0.25, margin=15.0, opacity_min=0.05, solid=0.15,
          blob_max_m=1.5, min_blob_voxels=12, max_faces=250_000, sightlines=None):
    xyz, opacity, scale = load_splats(ply_path)
    R, s, t = transform["R"], transform["s"], transform["t"]
    p = xyz @ R.T * s + t
    ext = scale.max(axis=1) * s

    pts = np.array([q[1:] for q in path])
    lo = pts.min(axis=0) - margin
    hi = pts.max(axis=0) + margin
    inside = np.all((p >= lo) & (p < hi), axis=1)
    keep = (opacity >= opacity_min) & (ext < blob_max_m) & inside
    p, ext, opacity = p[keep], ext[keep], opacity[keep]
    stage("mesh", f"{keep.sum()} of {len(keep)} splats are near the path")

    dims = np.ceil((hi - lo) / voxel).astype(int) + 1
    weight = np.zeros(dims, dtype=np.float32)
    idx = np.floor((p - lo) / voxel).astype(int)
    radius = np.clip(np.round(ext / voxel), 0, 2).astype(int)
    for r in range(3):
        sel = radius == r
        if not sel.any():
            continue
        cells = list(itertools.product(range(-r, r + 1), repeat=3))
        share = opacity[sel] / len(cells)
        for off in cells:
            q = idx[sel] + np.array(off)
            ok = np.all((q >= 0) & (q < dims), axis=1)
            np.add.at(weight, (q[ok, 0], q[ok, 1], q[ok, 2]), share[ok])

    occ = weight >= solid
    before = int(occ.sum())

    # Space carving: what the cameras looked through is air.
    if sightlines is not None and len(sightlines[0]) > 0:
        free = np.zeros(dims, dtype=np.int32)
        a = np.asarray(sightlines[0], dtype=np.float64) @ R.T * s + t
        b = np.asarray(sightlines[1], dtype=np.float64) @ R.T * s + t
        _carve_segments(free, a, b, lo, voxel, dims)
        occ &= free < FREE_VOTES
        stage("mesh", f"{len(a)} sightlines carved {before - int(occ.sum())} of {before} solid voxels")

    # The flown path: a tube the quad fitted through.
    tube = np.zeros(dims, dtype=bool)
    r = int(np.ceil(PATH_TUBE_M / voxel))
    # The path is resampled so the tube is continuous between frames.
    dense = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(np.ceil(np.linalg.norm(b - a) / (voxel / 2))))
        dense.extend(a + (b - a) * (k / n) for k in range(1, n + 1))
    pidx = np.floor((np.array(dense) - lo) / voxel).astype(int)
    for off in itertools.product(range(-r, r + 1), repeat=3):
        if np.linalg.norm(off) * voxel > PATH_TUBE_M:
            continue
        q = pidx + np.array(off)
        q = q[np.all((q >= 0) & (q < dims), axis=1)]
        tube[q[:, 0], q[:, 1], q[:, 2]] = True
    occ &= ~tube

    occ = remove_small_objects(occ, max_size=min_blob_voxels - 1)
    filled = int(occ.sum())
    if filled == 0:
        raise RuntimeError("no solid splats near the flown path; the splat is empty or the alignment is off")

    field = gaussian_filter(np.pad(occ, 1).astype(np.float32), sigma=0.7)
    verts, faces, _, _ = marching_cubes(field, level=0.35)
    verts = (verts - 1.0) * voxel + lo
    stage("mesh", f"{filled} voxels at {voxel} m, {len(faces)} triangles before decimation")

    if len(faces) > max_faces:
        import fast_simplification
        verts, faces = fast_simplification.simplify(verts.astype(np.float32), faces.astype(np.int64), target_count=max_faces)
        stage("mesh", f"{len(faces)} triangles after decimation")

    # The safety net: a floor under everything, wide enough to catch a
    # wide line, at the bottom of the searched box.
    y = float(lo[1])
    x0, x1 = float(lo[0]) - 60, float(hi[0]) + 60
    z0, z1 = float(lo[2]) - 60, float(hi[2]) + 60
    n = len(verts)
    net = np.array([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], dtype=np.float32)
    net_faces = np.array([[n, n + 1, n + 2], [n, n + 2, n + 3]], dtype=np.int64)
    verts = np.vstack([verts.astype(np.float32), net])
    faces = np.vstack([faces.astype(np.int64), net_faces])
    return verts, faces, {"lo": lo.tolist(), "hi": hi.tolist(), "voxel": voxel}
