# Stage 3: the splat. Brush (Arthur Brussee, Apache-2.0) trains a Gaussian
# splat on Metal, Vulkan or DX12 through wgpu, which is why it is the trainer
# here: it runs on the Mac this was built on, with no CUDA anywhere.

import shutil
import subprocess
from pathlib import Path

from .log import fail, stage


def find_brush(explicit=None):
    for c in ([explicit] if explicit else []) + ["brush_app", "brush"]:
        p = shutil.which(c) if c and not Path(c).exists() else c
        if p:
            return p
    fail("Brush is not installed",
         "download brush-app-aarch64-apple-darwin.tar.xz from https://github.com/ArthurBrussee/brush/releases and put brush_app on your PATH")


def train(dataset, work, *, steps, max_splats, max_resolution, brush=None):
    """Trains on a COLMAP folder (images/ + sparse/). Returns the .ply."""
    out = work / "splat"
    done = out / "splat.ply"
    if done.exists():
        stage("brush", "cached")
        return done
    out.mkdir(parents=True, exist_ok=True)
    exe = find_brush(brush)
    stage("brush", f"{steps} steps, up to {max_splats} splats, {max_resolution} px")
    log = work / "brush.log"
    cmd = [
        exe, str(dataset),
        "--total-steps", str(steps),
        "--max-splats", str(max_splats),
        "--max-resolution", str(max_resolution),
        "--export-every", str(steps),
        "--export-path", str(out),
        "--export-name", "export_{iter}.ply",
        "--eval-every", str(steps + 1),
    ]
    with open(log, "wb") as f:
        f.write(("$ " + " ".join(cmd) + "\n").encode())
        f.flush()
        r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)
    exports = sorted(out.glob("export_*.ply"), key=lambda p: int(p.stem.split("_")[1]))
    if r.returncode != 0 or not exports:
        fail(f"Brush did not produce a splat (exit {r.returncode}), see {log}")
    exports[-1].rename(done)
    for p in exports[:-1]:
        p.unlink()
    stage("brush", f"{done.stat().st_size / 1e6:.0f} MB splat")
    return done
