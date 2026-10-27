"""Fill the library by running the investigator over a list of apps (one per line).

  ANTHROPIC_API_KEY=... python -m scripts.build_library scripts/apps.txt [--parallel 4] [--refresh]

Existing guides are skipped unless --refresh. Each guide is validated before it is written.
This is how the library would grow to 100 apps; see README "Scaling to 100".
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from agent.investigator import investigate
from agent.validate import validate_guide
from server import slugify

OUT = Path(__file__).resolve().parent.parent / "data" / "guides"


def run(app: str, refresh: bool) -> str:
    path = OUT / f"{slugify(app)}.json"
    if path.exists() and not refresh:
        return f"skip  {app}"
    log = lambda e: print(f"  [{app}] {e['type']}: {e.get('text', '')[:100]}", file=sys.stderr)
    try:
        guide = investigate(app, log, mode="library")
    except Exception as e:  # keep the batch going
        return f"FAIL  {app}: {e}"
    guide["id"] = slugify(app)
    errors = validate_guide(guide)
    if errors:
        return f"FAIL  {app}: {errors[:3]}"
    path.write_text(json.dumps(guide, indent=2, ensure_ascii=False))
    return f"ok    {app} -> {path.name} (difficulty {guide['verdict']['difficulty']})"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("apps_file")
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    apps = [l.strip() for l in Path(args.apps_file).read_text().splitlines() if l.strip() and not l.startswith("#")]
    with ThreadPoolExecutor(args.parallel) as pool:
        for line in pool.map(lambda a: run(a, args.refresh), apps):
            print(line)


if __name__ == "__main__":
    main()
