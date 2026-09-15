# fpvreal-scene: one command, one video in, one scene folder out.

import argparse
import re
import sys
from pathlib import Path

from . import align, brush, colmap, frames, mesh, package
from .log import fail, stage


def parse(argv):
    p = argparse.ArgumentParser(
        prog="fpvreal-scene",
        description="Turn an FPV video into a scene FPV Real can fly: frames, COLMAP poses, a Brush splat, a collision mesh.",
    )
    p.add_argument("source", help="a YouTube URL or a video file")
    p.add_argument("--out", help="scene folder to write (default: scenes/<video id>)")
    p.add_argument("--name", help="scene name (default: the video title)")
    p.add_argument("--from", dest="start", type=float, default=0.0, help="start at this second of the video")
    p.add_argument("--to", dest="end", type=float, default=None, help="stop at this second of the video")
    p.add_argument("--fps", type=float, default=8.0, help="frames per second to extract (default 8; fast flying wants more)")
    p.add_argument("--overlap", type=int, default=16, help="how many neighbouring frames each frame is matched to (default 16)")
    p.add_argument("--min-registered", type=float, default=0.4, help="fraction of frames COLMAP must place before the scene is trusted (default 0.4)")
    p.add_argument("--width", type=int, default=1280, help="frame width in pixels (default 1280)")
    p.add_argument("--camera-model", default="OPENCV_FISHEYE", help="COLMAP camera model (OPENCV_FISHEYE for raw FPV cameras, OPENCV for dewarped footage)")
    p.add_argument("--focal", type=float, default=None, help="initial focal length as a fraction of frame width (default 0.5 for fisheye models, 0.8 otherwise)")
    p.add_argument("--speed", type=float, default=8.0, help="assumed median flying speed in m/s, sets the scale (default 8)")
    p.add_argument("--steps", type=int, default=15000, help="Brush training steps (default 15000)")
    p.add_argument("--max-splats", type=int, default=800_000, help="cap on splat count, which is the file size (default 800000)")
    p.add_argument("--max-resolution", type=int, default=1280, help="training image width (default 1280)")
    p.add_argument("--voxel", type=float, default=0.25, help="collision voxel size in metres (default 0.25)")
    p.add_argument("--brush", help="path to the brush_app binary")
    p.add_argument("--stop-after", choices=["frames", "colmap", "brush"], help="stop after a stage, for debugging")
    return p.parse_args(argv)


def slug(text):
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:48] or "scene"


def main(argv=None):
    a = parse(sys.argv[1:] if argv is None else argv)
    src = a.source
    ident = None
    m = re.search(r"(?:v=|youtu\.be/|shorts/)([A-Za-z0-9_-]{11})", src)
    if m:
        ident = m.group(1)
    elif not src.startswith("http"):
        ident = slug(Path(src).stem)
    out = Path(a.out) if a.out else Path("scenes") / (ident or "scene")
    work = out.parent / f"{out.name}.work"
    work.mkdir(parents=True, exist_ok=True)

    video, source = frames.fetch(src, work)
    times = frames.extract(video, work / "frames", fps=a.fps, width=a.width, start=a.start, end=a.end)
    if a.stop_after == "frames":
        return

    dataset = colmap.reconstruct(work / "frames", work, camera_model=a.camera_model, focal_fraction=a.focal,
                                 overlap=a.overlap, min_registered=a.min_registered)
    if a.stop_after == "colmap":
        return

    ply = brush.train(dataset, work, steps=a.steps, max_splats=a.max_splats, max_resolution=a.max_resolution, brush=a.brush)
    if a.stop_after == "brush":
        return

    images = colmap.read_images(dataset / "sparse" / "images.bin")
    poses = colmap.poses(images)
    points, _, seen = colmap.read_points(dataset / "sparse" / "points3D.bin", tracks=True)
    rays = colmap.sightlines(images, points, seen)
    try:
        transform = align.align(poses, times, assumed_speed=a.speed, points=points)
    except RuntimeError as e:
        fail(str(e))

    try:
        verts, faces, bounds = mesh.build(ply, transform, transform["path"], voxel=a.voxel, sightlines=rays)
    except RuntimeError as e:
        fail(str(e))

    name = a.name or source.get("title") or (ident or "scene")
    package.write(out, name=name, source=source, splat_ply=ply, verts=verts, faces=faces,
                  transform=transform, bounds=bounds, assumed_speed=a.speed,
                  frames=len(times), registered=len(poses))
    stage("done", f"copy {out} into sim/public/scenes/ and open http://localhost:5173/?scene=/scenes/{out.name}/")
    stage("done", f"scale is a guess from an assumed {a.speed} m/s; if the place feels too big or small, rerun with --speed")


if __name__ == "__main__":
    main()
