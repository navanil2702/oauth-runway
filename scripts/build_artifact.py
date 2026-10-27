"""Bundle the web app + library guides into one HTML file for publishing as a claude.ai Artifact.

  python scripts/build_artifact.py [--url https://claude.ai/artifact/...]
  python scripts/build_artifact.py --static        # public library-only site in docs/ (GitHub Pages)

In artifact mode, live generation runs on the viewer's own Claude (the `sample` capability)
and researches with the Claude desktop app's browser when available (`mcp` host:claude_browser).
"""

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="", help="Published artifact URL, used for share links")
    ap.add_argument("--out", default=None)
    ap.add_argument("--static", action="store_true", help="Public library-only site (full HTML document, e.g. for GitHub Pages)")
    args = ap.parse_args()

    guides = []
    for folder, collection in (("guides", "library"), ("generated", "generated")):
        for p in sorted((ROOT / "data" / folder).glob("*.json")):
            g = json.loads(p.read_text())
            g.setdefault("meta", {})["collection"] = collection
            guides.append(g)
    embed = {
        "guides": guides,
        "prompt": (ROOT / "agent" / "research_prompt.md").read_text(),
        "schema": json.dumps(json.loads((ROOT / "agent" / "guide.schema.json").read_text()), separators=(",", ":")),
        "artifactUrl": args.url,
        "static": args.static,
    }
    index = (WEB / "index.html").read_text()
    head = re.search(r"<head>(.*?)</head>", index, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", index, re.S).group(1)
    head = re.sub(r'<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*', "", head)
    head = head.replace('<link rel="stylesheet" href="styles.css">', f"<style>\n{(WEB / 'styles.css').read_text()}</style>")
    data = json.dumps(embed, ensure_ascii=False).replace("</", "<\\/")
    body = body.replace(
        '<script src="app.js"></script>',
        f"<script>window.__RUNWAY__ = {data};</script>\n<script>\n{(WEB / 'app.js').read_text()}</script>",
    )
    out = Path(args.out or (ROOT / "docs" / "index.html" if args.static else ROOT / "dist" / "oauth-runway.html"))
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.static:  # a normal web page: restore the document skeleton the artifact host would add
        page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
                f"{head.strip()}\n</head>\n<body>\n{body.strip()}\n</body>\n</html>\n")
    else:
        page = head.strip() + "\n" + body.strip() + "\n"
    out.write_text(page)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(guides)} guides)")


if __name__ == "__main__":
    main()
