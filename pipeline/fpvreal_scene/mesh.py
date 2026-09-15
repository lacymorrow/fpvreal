# Stage 5: something to crash into. A splat is a cloud of fuzzy blobs with no
# surface, and Rapier wants triangles. Every blob near the flown path pays
# its opacity into a voxel grid, so a wall of faint splats adds up to a wall
# and a lone floater does not. Small islands are dropped, the grid is
# smoothed and a surface is pulled out with marching cubes, then decimated to
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


def build(ply_path, transform, path, *, voxel=0.25, margin=15.0, opacity_min=0.05, solid=0.15,
          blob_max_m=1.5, min_blob_voxels=12, max_faces=250_000):
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

    occ = remove_small_objects(weight >= solid, max_size=min_blob_voxels - 1)
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
