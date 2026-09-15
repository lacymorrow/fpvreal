# Stage 6: the scene folder the sim opens. Three files: scene.json (what it
# is, where it came from, the transform, the flown path), splat.ply (the
# picture) and collision.bin (the triangles: float32 xyz then uint32 indices).

import json
import shutil
from pathlib import Path

import numpy as np

from .log import stage

FORMAT = "fpvreal-scene/1"


def write(out, *, name, source, splat_ply, verts, faces, transform, bounds, assumed_speed, frames, registered):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    splat_out = out / "splat.ply"
    if splat_ply.resolve() != splat_out.resolve():
        shutil.copyfile(splat_ply, splat_out)

    with open(out / "collision.bin", "wb") as f:
        f.write(np.ascontiguousarray(verts, dtype=np.float32).tobytes())
        f.write(np.ascontiguousarray(faces, dtype=np.uint32).tobytes())

    credit = source.get("title") or name
    if source.get("uploader"):
        credit += f", by {source['uploader']}"
    scene = {
        "format": FORMAT,
        "name": name,
        "credit": credit,
        "source": {k: source.get(k) for k in ("title", "uploader", "webpage_url", "id")},
        "splat": "splat.ply",
        "splatTransform": {
            "quaternion": [round(v, 9) for v in transform["quaternion"]],
            "scale": round(float(transform["s"]), 9),
            "position": [round(float(v), 6) for v in transform["t"]],
        },
        "scale": {
            "metresPerUnit": round(float(transform["s"]), 9),
            "method": "median-speed",
            "assumedSpeedMps": assumed_speed,
            "cameraTiltDeg": round(float(transform["tilt_deg"]), 1),
        },
        "collision": {"file": "collision.bin", "vertices": int(len(verts)), "triangles": int(len(faces))},
        "bounds": bounds,
        "path": transform["path"],
        "frames": {"extracted": frames, "registered": registered},
    }
    (out / "scene.json").write_text(json.dumps(scene, indent=1))
    size = sum(p.stat().st_size for p in out.iterdir()) / 1e6
    stage("package", f"{out} ({size:.0f} MB)")
    return out
