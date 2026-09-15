# Stage 1: the video becomes a folder of still frames.
#
# A fixed frame rate keeps the timestamps honest (frame k is at k / fps
# seconds after the trim point), which is what the scale estimate later
# leans on. Motion blur is the enemy of feature matching, so the blurriest
# frames are dropped by a Laplacian-variance test against the clip's own
# median: a bando flight is blurry everywhere, so an absolute threshold
# would keep nothing.

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

from .log import fail, stage

FRAME_NAME = "frame_{:06d}.jpg"


def fetch(source, work):
    """A YouTube URL is downloaded with yt-dlp; a path is used as it is."""
    src = str(source)
    if src.startswith("http://") or src.startswith("https://"):
        out = work / "source.mp4"
        info = work / "source.info.json"
        if out.exists() and info.exists():
            stage("fetch", f"cached {out.name}")
            return out, json.loads(info.read_text())
        ytdlp = shutil.which("yt-dlp")
        if not ytdlp:
            fail("yt-dlp is not installed", "uv tool install yt-dlp")
        stage("fetch", src)
        cmd = [
            ytdlp, "--no-warnings", "-q",
            "-f", "bv*[height<=1080][ext=mp4]/b[height<=1080]",
            "--write-info-json", "-o", str(work / "source.%(ext)s"), src,
        ]
        r = subprocess.run(cmd)
        if r.returncode != 0 or not out.exists():
            fail("the download failed", "update yt-dlp (uv tool upgrade yt-dlp), or download the file yourself and pass the path")
        meta = json.loads(info.read_text())
        return out, {k: meta.get(k) for k in ("id", "title", "uploader", "channel", "webpage_url", "duration")}
    p = Path(src)
    if not p.exists():
        fail(f"no such file: {p}")
    return p, {"title": p.stem, "webpage_url": None}


def _laplacian_var(path):
    im = np.asarray(Image.open(path).convert("L").resize((480, 270)), dtype=np.float32)
    lap = -4 * im[1:-1, 1:-1] + im[:-2, 1:-1] + im[2:, 1:-1] + im[1:-1, :-2] + im[1:-1, 2:]
    return float(lap.var())


def extract(video, frames_dir, *, fps, width, start, end, blur_keep=0.35):
    """Frames at a fixed rate into frames_dir. Returns {name: seconds}.
    Different settings mean different frames, so the cache remembers them
    and everything downstream of a re-extraction is thrown away."""
    params = {"fps": fps, "width": width, "start": start, "end": end, "blur_keep": blur_keep}
    meta = frames_dir / "times.json"
    if meta.exists():
        saved = json.loads(meta.read_text())
        if saved.get("params") == params:
            stage("frames", f"cached, {len(saved['times'])} frames")
            return saved["times"]
        stage("frames", "settings changed, extracting again")
        shutil.rmtree(frames_dir)
        for stale in ("colmap.db", "sparse", "undistorted", "splat", "colmap.log", "brush.log"):
            q = frames_dir.parent / stale
            if q.is_dir():
                shutil.rmtree(q)
            elif q.exists():
                q.unlink()
    frames_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        fail("ffmpeg is not installed", "brew install ffmpeg")
    stage("frames", f"{fps} fps, {width} px wide, {start:.0f}s to {end if end else 'end'}")
    cmd = [ffmpeg, "-v", "error", "-y", "-ss", f"{start:.3f}"]
    if end:
        cmd += ["-to", f"{end:.3f}"]
    cmd += [
        "-i", str(video),
        "-vf", f"fps={fps},scale={width}:-2",
        "-q:v", "2", "-start_number", "0",
        str(frames_dir / FRAME_NAME.replace("{:06d}", "%06d")),
    ]
    r = subprocess.run(cmd)
    if r.returncode != 0:
        fail("ffmpeg could not read the video")
    files = sorted(frames_dir.glob("frame_*.jpg"))
    if len(files) < 20:
        fail(f"only {len(files)} frames came out; the clip is too short", "pass a longer range with --from/--to, or a higher --fps")

    sharp = np.array([_laplacian_var(f) for f in files])
    floor = np.median(sharp) * blur_keep
    dropped = 0
    times = {}
    for k, f in enumerate(files):
        if sharp[k] < floor:
            f.unlink()
            dropped += 1
            continue
        times[f.name] = k / fps
    meta.write_text(json.dumps({"params": params, "times": times}))
    stage("frames", f"{len(times)} kept, {dropped} blurred frames dropped")
    return times
