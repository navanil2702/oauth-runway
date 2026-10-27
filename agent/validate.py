"""Dependency-free checks for guide objects (the parts of guide.schema.json the UI relies on,
plus evidence hygiene: every source id referenced must exist)."""

import json
from pathlib import Path
from typing import List

EVIDENCE = {"tested", "official", "community", "inferred"}
OWNERS = {"agent", "you", "provider", "agent+you"}
IMPACTS = {"blocker", "delay", "nuance"}
REQUIRED = json.loads((Path(__file__).parent / "guide.schema.json").read_text())["required"]


def validate_guide(g) -> List[str]:
    if not isinstance(g, dict):
        return ["guide must be an object"]
    errors = [f"missing required field '{k}'" for k in REQUIRED if k not in g]
    if errors:
        return errors

    source_ids = {s.get("id") for s in g.get("sources", []) if isinstance(s, dict)}
    for s in g.get("sources", []):
        if not (isinstance(s, dict) and s.get("id") and s.get("url") is not None and s.get("kind") in {"official", "community", "test"}):
            errors.append(f"source needs id, url and kind official|community|test: {str(s)[:80]}")

    def check_refs(where: str, item: dict, need_evidence: bool = True) -> None:
        ev = item.get("evidence")
        if need_evidence and ev not in EVIDENCE:
            errors.append(f"{where}: evidence must be one of {sorted(EVIDENCE)} (got {ev!r})")
        for sid in item.get("source_ids", []) or []:
            if sid not in source_ids:
                errors.append(f"{where}: source id {sid!r} is not in sources")

    v = g["verdict"]
    if not isinstance(v.get("difficulty"), int) or not 1 <= v["difficulty"] <= 5:
        errors.append("verdict.difficulty must be an integer 1-5")
    for k in ("label", "headline"):
        if not v.get(k):
            errors.append(f"verdict.{k} is required")
    for k in ("first_connection", "production", "hands_on_effort", "first_connection_short", "production_short", "hands_on_short"):
        if not g["timeline"].get(k):
            errors.append(f"timeline.{k} is required")
    if not isinstance(g["approval"].get("needed_for_production"), bool):
        errors.append("approval.needed_for_production must be true/false")
    check_refs("approval", g["approval"], need_evidence=False)

    if not g["phases"]:
        errors.append("phases must not be empty")
    for pi, phase in enumerate(g["phases"]):
        if not phase.get("steps"):
            errors.append(f"phases[{pi}] has no steps")
        for si, step in enumerate(phase.get("steps", [])):
            where = f"phases[{pi}].steps[{si}]"
            if not step.get("title"):
                errors.append(f"{where}: title is required")
            if step.get("owner") not in OWNERS:
                errors.append(f"{where}: owner must be one of {sorted(OWNERS)}")
            check_refs(where, step)

    for i, gt in enumerate(g["gotchas"]):
        if gt.get("impact") not in IMPACTS:
            errors.append(f"gotchas[{i}]: impact must be one of {sorted(IMPACTS)}")
        check_refs(f"gotchas[{i}]", gt)
    for i, b in enumerate(g.get("blockers", [])):
        check_refs(f"blockers[{i}]", b, need_evidence=False)
    check_refs("config", g["config"], need_evidence=False)

    for k in ("agent_can", "you_must"):
        if not g["handoff"].get(k):
            errors.append(f"handoff.{k} must list at least one item")
    return errors


if __name__ == "__main__":
    import sys

    bad = 0
    for path in sys.argv[1:]:
        errs = validate_guide(json.loads(Path(path).read_text()))
        print(f"{'OK ' if not errs else 'BAD'} {path}" + "".join(f"\n    - {e}" for e in errs))
        bad += bool(errs)
    sys.exit(1 if bad else 0)
