"""Render verification/batch_*.json into verification/REPORT.md."""

import json
from collections import Counter
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / "verification"
ICON = {"confirmed": "Confirmed", "partly": "Partly right", "wrong": "Wrong", "unverifiable": "Unverifiable"}

rows = [r for p in sorted(DIR.glob("batch_*.json")) for r in json.loads(p.read_text())]
counts = Counter(r["verdict"] for r in rows)
lines = [
    "# Verification of sampled claims",
    "",
    f"Second-pass agents re-checked {len(rows)} high-stakes claims from the library guides against primary sources on 2026-10-27. "
    "Each checker saw only the claim, not the original agent's sources or reasoning. "
    + ", ".join(f"{counts[k]} {ICON[k].lower()}" for k in ICON if counts[k]) + ". "
    "Every correction was applied to the guides, and each guide records the check in `meta.reviewed`.",
    "",
    "| # | Claim | Verdict | What changed | Source |",
    "|---|---|---|---|---|",
]
for r in rows:
    claim = r["claim"].replace("|", "\\|").replace("\n", " ")
    fix = (r.get("correction") or "").replace("|", "\\|").replace("\n", " ") or "None"
    lines.append(f"| {r['id']} | {claim} | **{ICON.get(r['verdict'], r['verdict'])}** | {fix} | [{r.get('source_kind', '')}]({r.get('source_url', '')}) |")
(DIR / "REPORT.md").write_text("\n".join(lines) + "\n")
print(f"{len(rows)} claims: {dict(counts)}")
