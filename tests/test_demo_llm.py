"""demo.py build --llm, end to end, once per provider, against a local mock that answers in each provider's shape.

Proves the wiring rather than the adapter alone: the provider named by LLM_PROVIDER is the one called, the cache
records provider and model, every uncategorised merchant gets an entry, and the ledger is byte-identical to a build
without the model (suggestions stay advisory). The repo's own docs/llm-cache.json is never touched.
"""
import contextlib
import http.server
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import demo  # noqa: E402


def user_text(provider_path, body):
    if provider_path.endswith("/messages"):
        return body["messages"][0]["content"]
    if provider_path.endswith("/chat/completions"):
        return next(m["content"] for m in body["messages"] if m["role"] == "user")
    return body["contents"][0]["parts"][0]["text"]


class EchoMock(http.server.BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
        EchoMock.calls.append(self.path)
        asked = json.loads(user_text(self.path, body))
        answer = json.dumps([{"merchant": x["merchant"], "category": "Supplies", "confidence": 0.5, "reason": "mock"} for x in asked])
        reply = "Sure — here is the JSON:\n```json\n" + answer + "\n```"
        if self.path.endswith("/messages"):
            obj = {"model": "claude-mock", "content": [{"type": "text", "text": reply}]}
        elif self.path.endswith("/chat/completions"):
            obj = {"model": "openai-mock", "choices": [{"message": {"content": reply}}]}
        else:
            obj = {"modelVersion": "gemini-mock", "candidates": [{"content": {"parts": [{"text": reply}]}}]}
        raw = json.dumps(obj).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)


class TestBuildWithEachProvider(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), EchoMock)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.tmp = tempfile.mkdtemp(prefix="bb-llm-")
        demo.build(os.path.join(cls.tmp, "plain"))
        with open(os.path.join(cls.tmp, "plain", "ledger.json"), "rb") as f:
            cls.plain_ledger = f.read()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_provider(self, provider, env, expect_path, expect_model):
        out = os.path.join(self.tmp, provider)
        cache = os.path.join(self.tmp, f"cache-{provider}.json")
        EchoMock.calls.clear()
        full_env = {"LLM_PROVIDER": provider, "LLM_BASE_URL": self.base, **env}
        with mock.patch.dict(os.environ, full_env, clear=False), mock.patch.object(demo, "LLM_CACHE", demo.Path(cache)):
            for var in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "LLM_API_KEY", "LLM_MODEL"):
                if var not in full_env:
                    os.environ.pop(var, None)
            demo.build(out, use_llm=True)
        self.assertEqual(len(EchoMock.calls), 1, "exactly one model call")
        self.assertTrue(EchoMock.calls[0].endswith(expect_path), EchoMock.calls[0])
        with open(cache, encoding="utf-8") as f:
            c = json.load(f)
        demo.validate_cache(c)
        self.assertEqual((c["provider"], c["model"]), (provider, expect_model))
        with open(os.path.join(out, "llm-suggestions.json"), encoding="utf-8") as f:
            sug = json.load(f)
        self.assertTrue(sug["suggestions"], "at least one uncategorised merchant got a suggestion")
        self.assertTrue(all(v and v["category"] == "Supplies" for v in sug["suggestions"].values()))
        self.assertEqual(sug["provider"], provider)
        with open(os.path.join(out, "ledger.json"), "rb") as f:
            self.assertEqual(f.read(), self.plain_ledger, "the model must not change the ledger")

    def test_anthropic(self):
        self.run_provider("anthropic", {"ANTHROPIC_API_KEY": "k"}, "/messages", "claude-mock")

    def test_openai(self):
        self.run_provider("openai", {"OPENAI_API_KEY": "k", "LLM_MODEL": "any-openai-model"}, "/chat/completions", "openai-mock")

    def test_gemini(self):
        self.run_provider("gemini", {"GEMINI_API_KEY": "k", "LLM_MODEL": "any-gemini-model"}, ":generateContent", "gemini-mock")

    def test_openai_compatible(self):
        self.run_provider("openai-compatible", {"LLM_MODEL": "llama-local"}, "/chat/completions", "openai-mock")

    def test_second_build_is_offline(self):
        """A cache that already covers every uncategorised merchant means no call and no key — what the README promises."""
        cache = os.path.join(self.tmp, "cache-offline.json")
        env = {"LLM_PROVIDER": "anthropic", "LLM_BASE_URL": self.base, "ANTHROPIC_API_KEY": "k"}
        EchoMock.calls.clear()
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(demo, "LLM_CACHE", demo.Path(cache)):
            first = io.StringIO()
            with contextlib.redirect_stdout(first):
                demo.build(os.path.join(self.tmp, "offline-1"), use_llm=True)
        self.assertEqual(len(EchoMock.calls), 1, "the first build fills the cache from the model")
        self.assertIn("asked of the model", first.getvalue())

        EchoMock.calls.clear()
        offline = {k: v for k, v in env.items() if k != "ANTHROPIC_API_KEY"}
        with mock.patch.dict(os.environ, offline, clear=False), mock.patch.object(demo, "LLM_CACHE", demo.Path(cache)):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            second = io.StringIO()
            with contextlib.redirect_stdout(second):
                demo.build(os.path.join(self.tmp, "offline-2"), use_llm=True)
        self.assertEqual(EchoMock.calls, [], "nothing may be sent when the cache already answers")
        self.assertIn("all from the cache, no call made", second.getvalue())
        with open(os.path.join(self.tmp, "offline-2", "llm-suggestions.json"), encoding="utf-8") as f:
            self.assertTrue(json.load(f)["suggestions"], "and the suggestions are still written")

    def test_repo_cache_untouched(self):
        self.assertFalse(os.path.exists(os.path.join(ROOT, "docs", "llm-cache.json")) and
                         json.load(open(os.path.join(ROOT, "docs", "llm-cache.json"))).get("model") in
                         ("claude-mock", "openai-mock", "gemini-mock"))


if __name__ == "__main__":
    unittest.main()
