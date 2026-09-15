# Stage 3: the splat. Brush (Arthur Brussee, Apache-2.0) trains a Gaussian
# splat on Metal, Vulkan or DX12 through wgpu, which is why it is the trainer
# here: it runs on the Mac this was built on, with no CUDA anywhere.

import shutil
import subprocess
import time
from pathlib import Path

from .log import fail, stage


def find_brush(explicit=None):
    for c in ([explicit] if explicit else []) + ["brush_app", "brush"]:
        p = shutil.which(c) if c and not Path(c).exists() else c
        if p:
            return p
    fail("Brush is not installed",
         "download brush-app-aarch64-apple-darwin.tar.xz from https://github.com/ArthurBrussee/brush/releases and put brush_app on your PATH")


def train(dataset, work, *, steps, max_splats, max_resolution, brush=None, exports=5):
    """Trains on a COLMAP folder (images/ + sparse/). Returns the .ply.
    Brush prints nothing while it trains, so it is asked to export a few
    times along the way and each export becomes the progress line. A run
    that dies leaves the last export behind, which is a scene, if a rough one."""
    out = work / "splat"
    done = out / "splat.ply"
    if done.exists():
        stage("brush", "cached")
        return done
    out.mkdir(parents=True, exist_ok=True)
    exe = find_brush(brush)
    every = max(500, steps // max(1, exports))
    stage("brush", f"{steps} steps, up to {max_splats} splats, {max_resolution} px, an export every {every} steps")
    log = work / "brush.log"
    cmd = [
        exe, str(dataset),
        "--total-steps", str(steps),
        "--max-splats", str(max_splats),
        "--max-resolution", str(max_resolution),
        "--export-every", str(every),
        "--export-path", str(out),
        "--export-name", "export_{iter}.ply",
        "--eval-every", str(steps + 1),
    ]
    seen = set()
    t0 = time.monotonic()
    with open(log, "wb") as f:
        f.write(("$ " + " ".join(cmd) + "\n").encode())
        f.flush()
        proc = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT)
        while proc.poll() is None:
            time.sleep(15)
            for e in _exports(out):
                if e in seen:
                    continue
                seen.add(e)
                it = int(e.stem.split("_")[1])
                rate = it / max(1, time.monotonic() - t0)
                left = (steps - it) / rate if rate > 0 else 0
                stage("brush", f"step {it} of {steps}, {e.stat().st_size / 1e6:.0f} MB, about {left / 60:.0f} min left")
    exports_found = _exports(out)
    if proc.returncode != 0 or not exports_found:
        fail(f"Brush did not produce a splat (exit {proc.returncode}), see {log}")
    exports_found[-1].rename(done)
    for p in exports_found[:-1]:
        p.unlink()
    stage("brush", f"{done.stat().st_size / 1e6:.0f} MB splat")
    return done


def _exports(out):
    return sorted(out.glob("export_*.ply"), key=lambda p: int(p.stem.split("_")[1]))
