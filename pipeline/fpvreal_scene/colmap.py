# Stage 2: camera poses. COLMAP, sequential matching, one shared camera.
#
# A video is a sequence, so every frame is matched to its neighbours rather
# than to every other frame: linear instead of quadratic, and it is what the
# footage is. One camera model for the whole clip, because it was one camera.
# The output is undistorted to a pinhole model, which is what the splat
# trainer expects to see.

import os
import shutil
import struct
import subprocess
from collections import namedtuple
from pathlib import Path

import numpy as np

from .log import fail, stage

Camera = namedtuple("Camera", "id model width height params")
Image = namedtuple("Image", "id qvec tvec camera_id name")

CAMERA_MODELS = {
    0: ("SIMPLE_PINHOLE", 3), 1: ("PINHOLE", 4), 2: ("SIMPLE_RADIAL", 4), 3: ("RADIAL", 5),
    4: ("OPENCV", 8), 5: ("OPENCV_FISHEYE", 8), 6: ("FULL_OPENCV", 12), 7: ("FOV", 5),
    8: ("SIMPLE_RADIAL_FISHEYE", 4), 9: ("RADIAL_FISHEYE", 5), 10: ("THIN_PRISM_FISHEYE", 12),
}


def _run(cmd, log, what):
    with open(log, "ab") as f:
        f.write(("\n$ " + " ".join(cmd) + "\n").encode())
        f.flush()
        r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        fail(f"colmap {what} failed (exit {r.returncode}), see {log}")


# A first guess at the focal length, as a fraction of the frame width. COLMAP
# 4 refuses to match fisheye pairs without one ("their focal length cannot be
# recovered from a fundamental matrix"), and its default guess of 1.2 times
# the width is a telephoto lens, not an FPV camera. Bundle adjustment refines
# it; it only has to be in the right neighbourhood.
FOCAL_FRACTION = {"OPENCV_FISHEYE": 0.5, "RADIAL_FISHEYE": 0.5, "SIMPLE_RADIAL_FISHEYE": 0.5}
FOCAL_FRACTION_DEFAULT = 0.8


def _camera_prior(frames_dir, camera_model, focal_fraction):
    from PIL import Image as PILImage
    first = sorted(frames_dir.glob("*.jpg"))[0]
    w, h = PILImage.open(first).size
    f = (focal_fraction or FOCAL_FRACTION.get(camera_model, FOCAL_FRACTION_DEFAULT)) * w
    cx, cy = w / 2, h / 2
    n = next(k for name, k in CAMERA_MODELS.values() if name == camera_model)
    if n == 3:
        params = [f, cx, cy]
    elif n == 4 and camera_model == "PINHOLE":
        params = [f, f, cx, cy]
    elif camera_model in ("OPENCV", "OPENCV_FISHEYE", "FULL_OPENCV", "THIN_PRISM_FISHEYE"):
        params = [f, f, cx, cy] + [0.0] * (n - 4)
    else:
        params = [f, cx, cy] + [0.0] * (n - 3)
    return ",".join(f"{v:.3f}" for v in params), f, w, h


def reconstruct(frames_dir, work, *, camera_model="OPENCV_FISHEYE", overlap=12, threads=None,
                focal_fraction=None, min_registered=0.4):
    """Runs the COLMAP chain. Returns the undistorted dataset folder."""
    undist = work / "undistorted"
    if (undist / "sparse" / "cameras.bin").exists():
        stage("colmap", "cached")
        return undist
    colmap = shutil.which("colmap")
    if not colmap:
        fail("colmap is not installed", "brew install colmap")
    db = work / "colmap.db"
    sparse = work / "sparse"
    log = work / "colmap.log"
    threads = str(threads or max(1, (os.cpu_count() or 4) - 1))
    if db.exists():
        db.unlink()
    sparse.mkdir(parents=True, exist_ok=True)

    params, f, w, h = _camera_prior(frames_dir, camera_model, focal_fraction)
    stage("colmap", f"features, {camera_model}, {w}x{h}, focal prior {f:.0f} px")
    _run([
        colmap, "feature_extractor",
        "--database_path", str(db), "--image_path", str(frames_dir),
        "--ImageReader.single_camera", "1",
        "--ImageReader.camera_model", camera_model,
        "--ImageReader.camera_params", params,
        "--FeatureExtraction.use_gpu", "0",
        "--FeatureExtraction.num_threads", threads,
        "--SiftExtraction.max_num_features", "6000",
    ], log, "feature_extractor")

    stage("colmap", f"matching, overlap {overlap}")
    _run([
        colmap, "sequential_matcher",
        "--database_path", str(db),
        "--SequentialMatching.overlap", str(overlap),
        "--SequentialMatching.quadratic_overlap", "1",
        "--SequentialMatching.loop_detection", "0",
        "--FeatureMatching.use_gpu", "0",
        "--FeatureMatching.num_threads", threads,
    ], log, "sequential_matcher")

    stage("colmap", "mapping (the slow one)")
    _run([
        colmap, "mapper",
        "--database_path", str(db), "--image_path", str(frames_dir),
        "--output_path", str(sparse),
        "--Mapper.num_threads", threads,
        "--Mapper.ba_global_function_tolerance", "1e-5",
        # FPV frames are blurry and fast. The defaults were set for photos.
        "--Mapper.min_num_matches", "10",
        "--Mapper.abs_pose_min_num_inliers", "15",
        "--Mapper.abs_pose_min_inlier_ratio", "0.15",
        "--Mapper.init_min_num_inliers", "50",
    ], log, "mapper")

    models = sorted([p for p in sparse.iterdir() if p.is_dir()], key=lambda p: _model_size(p), reverse=True)
    if not models:
        fail("COLMAP registered nothing", "a steadier section of the clip (--from/--to), more frames (--fps 6), or --camera-model OPENCV")
    best = models[0]
    n_images = _model_size(best)
    n_frames = len(list(frames_dir.glob("*.jpg")))
    stage("colmap", f"{n_images} of {n_frames} frames registered in the best of {len(models)} model(s)")
    if n_images < max(20, n_frames * min_registered):
        fail(f"only {n_images} of {n_frames} frames registered; the reconstruction is not trustworthy",
             "a steadier section (--from/--to), --fps 10 for more overlap, --camera-model OPENCV if the footage was already dewarped, or --min-registered 0.2 to fly the fragment")

    stage("colmap", "undistorting to pinhole")
    _run([
        colmap, "image_undistorter",
        "--image_path", str(frames_dir), "--input_path", str(best),
        "--output_path", str(undist), "--output_type", "COLMAP",
    ], log, "image_undistorter")
    return undist


def _model_size(model_dir):
    p = model_dir / "images.bin"
    if not p.exists():
        return 0
    with open(p, "rb") as f:
        return struct.unpack("<Q", f.read(8))[0]


# The three binary files, read the way COLMAP writes them.

def read_cameras(path):
    cams = {}
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            cid, model, w, h = struct.unpack("<iiQQ", f.read(24))
            name, k = CAMERA_MODELS[model]
            params = struct.unpack("<" + "d" * k, f.read(8 * k))
            cams[cid] = Camera(cid, name, w, h, np.array(params))
    return cams


def read_images(path):
    images = {}
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            iid = struct.unpack("<i", f.read(4))[0]
            q = np.array(struct.unpack("<dddd", f.read(32)))
            t = np.array(struct.unpack("<ddd", f.read(24)))
            cid = struct.unpack("<i", f.read(4))[0]
            name = b""
            while True:
                c = f.read(1)
                if c == b"\0":
                    break
                name += c
            n2 = struct.unpack("<Q", f.read(8))[0]
            f.seek(24 * n2, 1)
            images[iid] = Image(iid, q, t, cid, name.decode())
    return images


def read_points(path):
    xyz, rgb = [], []
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            f.read(8)
            xyz.append(struct.unpack("<ddd", f.read(24)))
            rgb.append(struct.unpack("<BBB", f.read(3)))
            f.read(8)
            tl = struct.unpack("<Q", f.read(8))[0]
            f.seek(8 * tl, 1)
    return np.array(xyz), np.array(rgb, dtype=np.uint8)


def qvec_to_rot(q):
    """COLMAP's (w, x, y, z) to a 3x3 world-to-camera rotation."""
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def poses(images):
    """Per image: centre and the camera axes in world, COLMAP convention
    (x right, y down, z forward). Sorted by file name, so by time."""
    out = []
    for im in sorted(images.values(), key=lambda i: i.name):
        R = qvec_to_rot(im.qvec)
        centre = -R.T @ im.tvec
        out.append({"name": im.name, "centre": centre, "right": R.T[:, 0], "down": R.T[:, 1], "forward": R.T[:, 2]})
    return out
