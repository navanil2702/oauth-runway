"""Live investigator: researches one app's OAuth app setup + approval path and returns a guide.

The same instructions (research_prompt.md) and schema (guide.schema.json) produced the
library guides, so live guides and library guides are directly comparable.

Tools given to the model:
  - web_search / web_fetch  (Anthropic server tools: research provider docs and community reports)
  - probe_http              (runs here: unauthenticated live checks such as discovery docs,
                             authorize endpoint with a dummy client_id, token endpoint error shape)
  - submit_guide            (runs here: validates the guide; validation errors go back to the model)
"""

import datetime
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Optional

import anthropic

from agent.validate import validate_guide

HERE = Path(__file__).parent
MODEL = "claude-opus-5-5"
MAX_ROUNDS = 40

Emit = Callable[[dict], None]


def build_system_prompt(app: str, mode: str) -> str:
    prompt = (HERE / "research_prompt.md").read_text()
    prompt = prompt.replace("{{APP}}", app).replace("{{MODE}}", mode)
    schema = (HERE / "guide.schema.json").read_text()
    today = datetime.date.today().isoformat()
    return (
        f"{prompt}\n\nToday is {today}.\n\n"
        "## How to work in this session\n"
        "- Start by identifying the provider's developer docs for OAuth / app registration and its app "
        "review or verification policy. Then look for developer reports of real review timelines.\n"
        "- Use `probe_http` for the live checks. It never sends credentials.\n"
        "- Budget: about 8 searches, 12 page fetches and 6 probes. Stop researching once the guide "
        "is well supported; list the rest as uncertainties.\n"
        "- If the input is not an app that supports OAuth for third-party developers, still submit a "
        "guide: say so in the summary, set difficulty 5 with label 'No public OAuth', and explain the "
        "alternatives (API keys, partner program, none).\n"
        "- Finish by calling `submit_guide` with the full guide object. If it returns validation "
        "errors, fix them and call it again.\n\n"
        f"## guide.schema.json\n```json\n{schema}\n```"
    )


# ---------- probe_http ----------

def _is_public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # report redirects instead of following them
        return None


def probe_http(method: str, url: str, form: Optional[dict] = None) -> dict:
    """Unauthenticated request to a public URL. Returns status, key headers and a body excerpt."""
    method = (method or "GET").upper()
    if method not in ("GET", "POST"):
        return {"error": "only GET and POST are allowed"}
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return {"error": "url must be http(s)"}
    if not _is_public_host(parsed.hostname):
        return {"error": "refusing to probe a private or unresolvable host"}
    data = urllib.parse.urlencode(form or {}).encode() if method == "POST" else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "User-Agent": "oauth-runway-probe/1.0 (unauthenticated documentation check)",
        "Accept": "application/json, text/html;q=0.9, */*;q=0.5",
    })
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        resp = opener.open(req, timeout=15)
        status, headers, body = resp.status, resp.headers, resp.read(200_000)
    except urllib.error.HTTPError as e:
        status, headers, body = e.code, e.headers, e.read(200_000)
    except Exception as e:  # network errors are results too
        return {"error": f"{type(e).__name__}: {e}"}
    text = body.decode("utf-8", "replace")
    if "html" in (headers.get("Content-Type") or ""):
        title = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
        text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = (f"[title: {title.group(1).strip()}] " if title else "") + re.sub(r"\s+", " ", text)
    return {
        "status": status,
        "location": headers.get("Location"),
        "content_type": headers.get("Content-Type"),
        "www_authenticate": headers.get("WWW-Authenticate"),
        "body_excerpt": text[:1500],
        "checked_at": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 10},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 15, "max_content_tokens": 30000},
    {
        "name": "probe_http",
        "description": (
            "Make one unauthenticated GET or POST request to a public URL and see the raw result "
            "(status, Location header, content type, WWW-Authenticate, first 1500 chars of body). "
            "Redirects are reported, not followed. Use it for live checks: OAuth/OIDC discovery "
            "documents, the authorize endpoint with a dummy client_id, the token endpoint with dummy "
            "credentials, and whether the developer console requires login. Never pass real credentials."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "method": {"type": "string", "enum": ["GET", "POST"]},
                "url": {"type": "string"},
                "form": {"type": "object", "description": "Form fields for POST (application/x-www-form-urlencoded)."},
            },
            "required": ["method", "url"],
        },
    },
    {
        "name": "submit_guide",
        "description": "Submit the finished guide. It is validated against guide.schema.json; fix any errors returned and resubmit.",
        "input_schema": {
            "type": "object",
            "properties": {"guide": {"type": "object", "description": "The complete guide object."}},
            "required": ["guide"],
        },
    },
]


def _describe_server_tool(block) -> Optional[dict]:
    inp = getattr(block, "input", None) or {}
    if block.name == "web_search":
        return {"type": "search", "text": inp.get("query", "")}
    if block.name == "web_fetch":
        return {"type": "fetch", "text": inp.get("url", "")}
    return None


def investigate(app: str, emit: Emit, mode: str = "live", model: str = MODEL) -> dict:
    """Run the agent until it submits a valid guide. Streams progress through `emit`."""
    client = anthropic.Anthropic()
    system = build_system_prompt(app, mode)
    messages = [{"role": "user", "content": f"Investigate: {app}"}]
    emit({"type": "status", "text": f"Starting investigation of {app}"})

    for _ in range(MAX_ROUNDS):
        with client.beta.messages.stream(
            model=model,
            max_tokens=64000,
            system=system,
            tools=TOOLS,
            messages=messages,
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": "high"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            for event in stream:
                if event.type != "content_block_stop":
                    continue
                block = stream.current_message_snapshot.content[event.index]
                if block.type == "server_tool_use":
                    described = _describe_server_tool(block)
                    if described:
                        emit(described)
                elif block.type == "thinking" and getattr(block, "thinking", ""):
                    emit({"type": "thought", "text": block.thinking[:600]})
                elif block.type == "text" and block.text.strip():
                    emit({"type": "note", "text": block.text.strip()[:600]})
            response = stream.get_final_message()

        if response.stop_reason == "refusal":
            raise RuntimeError("The model declined this request.")
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "pause_turn":
            continue  # server-side tool loop hit its limit; resend to resume
        if response.stop_reason == "max_tokens":
            messages.append({"role": "user", "content": "You ran out of output space. Submit the guide now with submit_guide, keeping it concise."})
            continue
        if response.stop_reason != "tool_use":
            messages.append({"role": "user", "content": "Call submit_guide with the finished guide."})
            continue

        results = []
        submitted = None
        for block in response.content:
            if block.type != "tool_use":
                continue
            if block.name == "probe_http":
                inp = block.input or {}
                emit({"type": "probe", "text": f"{inp.get('method', 'GET')} {inp.get('url', '')}"})
                out = probe_http(inp.get("method", "GET"), inp.get("url", ""), inp.get("form"))
                emit({"type": "probe_result", "text": f"{out.get('status', out.get('error'))} {out.get('location') or ''}".strip()})
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(out)})
            elif block.name == "submit_guide":
                guide = (block.input or {}).get("guide")
                errors = validate_guide(guide)
                if errors:
                    emit({"type": "status", "text": f"Guide failed validation ({len(errors)} issues); fixing"})
                    results.append({"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                                    "content": "Validation errors:\n- " + "\n- ".join(errors[:30])})
                else:
                    submitted = guide
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": "Accepted."})
            else:
                results.append({"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                                "content": f"Unknown tool {block.name}"})
        if submitted:
            submitted.setdefault("meta", {})
            submitted["meta"].update({
                "generated_at": datetime.date.today().isoformat(),
                "generated_by": f"OAuth Runway investigator ({model})",
                "mode": mode,
            })
            emit({"type": "status", "text": "Guide validated"})
            return submitted
        messages.append({"role": "user", "content": results})

    raise RuntimeError("Investigation did not finish within the round limit.")


if __name__ == "__main__":
    import sys

    def _print(event: dict) -> None:
        print(f"[{event['type']}] {event.get('text', '')}", file=sys.stderr)

    guide = investigate(" ".join(sys.argv[1:]) or "Dropbox", _print)
    print(json.dumps(guide, indent=2))
