# One line per stage, the way a build tool reports. Nothing scrolls unless it
# failed, and then the failure says what to try.

import sys
import time

_t0 = time.monotonic()


def stage(name, detail=""):
    t = time.monotonic() - _t0
    line = f"[{t:6.0f}s] {name}"
    if detail:
        line += f"  {detail}"
    print(line, flush=True)


def fail(message, hint=None):
    print(f"\nfpvreal-scene: {message}", file=sys.stderr)
    if hint:
        print(f"  try: {hint}", file=sys.stderr)
    sys.exit(1)
