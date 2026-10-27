"""Offline tests for the investigator loop and the /api/generate stream, with a scripted fake
Anthropic client (no API key or network to Anthropic needed). probe_http is stubbed too."""

import json
import os
import threading
import unittest
import urllib.request
from pathlib import Path
from types import SimpleNamespace as NS
from unittest import mock

from agent import investigator
from agent.validate import validate_guide

ROOT = Path(__file__).resolve().parent.parent
GOOD = json.loads((ROOT / "data" / "guides" / "notion.json").read_text())


def block(**kw):
    return NS(**kw)


class FakeStream:
    def __init__(self, content, stop_reason):
        self.msg = NS(content=content, stop_reason=stop_reason)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        for i, _ in enumerate(self.msg.content):
            yield NS(type="content_block_stop", index=i)

    @property
    def current_message_snapshot(self):
        return self.msg

    def get_final_message(self):
        return self.msg


def scripted_client(rounds, calls):
    def stream(**kwargs):
        calls.append({**kwargs, "messages": list(kwargs["messages"])})  # snapshot: the loop keeps appending
        return FakeStream(*rounds.pop(0))
    return NS(beta=NS(messages=NS(stream=stream)))


def script():
    bad = dict(GOOD)
    bad.pop("handoff")
    return [
        ([block(type="thinking", thinking="Look for Acme's developer docs first."),
          block(type="server_tool_use", name="web_search", input={"query": "Acme OAuth app review"}),
          block(type="server_tool_use", name="web_fetch", input={"url": "https://developers.acme.test/oauth"})], "pause_turn"),
        ([block(type="text", text="Checking the authorize endpoint."),
          block(type="tool_use", id="t1", name="probe_http", input={"method": "GET", "url": "https://acme.test/oauth/authorize?client_id=x"})], "tool_use"),
        ([block(type="tool_use", id="t2", name="submit_guide", input={"guide": bad})], "tool_use"),
        ([block(type="tool_use", id="t3", name="submit_guide", input={"guide": dict(GOOD, id="acme")})], "tool_use"),
    ]


class InvestigatorLoop(unittest.TestCase):
    def test_full_loop(self):
        calls, events = [], []
        with mock.patch.object(investigator.anthropic, "Anthropic", return_value=scripted_client(script(), calls)), \
             mock.patch.object(investigator, "probe_http", return_value={"status": 400, "location": None}):
            guide = investigator.investigate("Acme", events.append)

        self.assertEqual(guide["id"], "acme")
        self.assertEqual(guide["meta"]["mode"], "live")
        self.assertEqual(validate_guide(guide), [])
        types = [e["type"] for e in events]
        for t in ("status", "thought", "search", "fetch", "note", "probe", "probe_result"):
            self.assertIn(t, types)
        self.assertEqual(len(calls), 4)
        # pause_turn resumes with no extra user message: the last message is the assistant turn
        self.assertEqual(calls[1]["messages"][-1]["role"], "assistant")
        # the invalid submission produced an error tool_result that names the problem
        err = calls[3]["messages"][-1]["content"][0]
        self.assertTrue(err["is_error"])
        self.assertIn("handoff", err["content"])
        self.assertEqual(calls[0]["model"], "claude-opus-5-5")

    def test_probe_refuses_private_hosts(self):
        self.assertIn("error", investigator.probe_http("GET", "http://127.0.0.1/"))
        self.assertIn("error", investigator.probe_http("DELETE", "https://example.com/"))
        self.assertIn("error", investigator.probe_http("GET", "file:///etc/passwd"))


class ServerStream(unittest.TestCase):
    def test_generate_streams_events_and_saves(self):
        import server
        from http.server import ThreadingHTTPServer

        out_dir = ROOT / "data" / "generated"
        target = out_dir / "acme.json"
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        calls = []
        try:
            with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test"}), \
                 mock.patch.object(investigator.anthropic, "Anthropic", return_value=scripted_client(script(), calls)), \
                 mock.patch.object(investigator, "probe_http", return_value={"status": 400}):
                req = urllib.request.Request(f"http://127.0.0.1:{httpd.server_port}/api/generate",
                                             data=json.dumps({"app": "Acme"}).encode(), method="POST",
                                             headers={"Content-Type": "application/json"})
                body = urllib.request.urlopen(req, timeout=10).read().decode()
            events = [json.loads(line[6:]) for line in body.split("\n\n") if line.startswith("data: ")]
            self.assertEqual(events[-1]["type"], "done")
            self.assertEqual(events[-1]["id"], "acme")
            self.assertTrue(target.exists())
            listed = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_port}/api/guides").read())
            self.assertIn("acme", [g["id"] for g in listed])
        finally:
            httpd.shutdown()
            if target.exists():
                target.unlink()


if __name__ == "__main__":
    unittest.main()
