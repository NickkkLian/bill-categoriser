"""llm.py against a local mock of each provider's documented request/response shape.

What this proves: the adapter sends the method, path, headers and body fields each API documents, keeps keys out of
URLs, and reads each reply shape. What it does not prove: that a live service accepts the call today — that needs a
real key, and the README's compatibility table says which combinations were actually run.

    python3 -m unittest discover -s tests -v
"""
import http.server
import json
import os
import sys
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import llm  # noqa: E402

REPLY = '[{"merchant": "Northwind Paper", "category": "Supplies", "confidence": 0.9, "reason": "paper"}]'


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        self.server.seen = {"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                            "body": json.loads(body or b"{}")}
        if self.path.startswith("/fail"):
            return self.reply(401, {"error": {"message": "invalid key"}})
        if self.path.startswith("/garbage"):
            self.send_response(200); self.end_headers(); self.wfile.write(b"<html>not json</html>"); return
        if self.path.endswith("/messages"):
            return self.reply(200, {"model": "claude-test-1", "content": [{"type": "text", "text": REPLY}]})
        if self.path.endswith("/chat/completions"):
            return self.reply(200, {"model": "gpt-test-1", "choices": [{"message": {"role": "assistant", "content": REPLY}}]})
        if ":generateContent" in self.path:
            return self.reply(200, {"modelVersion": "gemini-test-1",
                                    "candidates": [{"content": {"parts": [{"text": REPLY[:20]}, {"text": REPLY[20:]}]}}]})
        self.reply(404, {"error": "no route"})

    def reply(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)


class TestAgainstMock(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def cfg(self, provider, **env):
        e = {"LLM_PROVIDER": provider, "LLM_BASE_URL": self.base + env.pop("path", ""), **env}
        return llm.config_from_env(e)

    def test_anthropic(self):
        c = self.cfg("anthropic", ANTHROPIC_API_KEY="sk-ant-test")
        text, model = llm.complete(c, "SYS", "USER", max_tokens=321)
        s = self.srv.seen
        self.assertEqual(s["path"], "/messages")
        self.assertEqual((s["headers"]["x-api-key"], s["headers"]["anthropic-version"]), ("sk-ant-test", "2023-06-01"))
        self.assertEqual(s["body"], {"model": "claude-sonnet-5", "max_tokens": 321, "system": "SYS",
                                     "messages": [{"role": "user", "content": "USER"}]})
        self.assertEqual((json.loads(text)[0]["category"], model), ("Supplies", "claude-test-1"))

    def test_openai(self):
        c = self.cfg("openai", OPENAI_API_KEY="sk-oa-test", LLM_MODEL="some-openai-model")
        text, model = llm.complete(c, "SYS", "USER", max_tokens=222)
        s = self.srv.seen
        self.assertEqual(s["path"], "/chat/completions")
        self.assertEqual(s["headers"]["authorization"], "Bearer sk-oa-test")
        self.assertEqual(s["body"]["messages"], [{"role": "system", "content": "SYS"}, {"role": "user", "content": "USER"}])
        self.assertEqual(s["body"]["max_completion_tokens"], 222)
        self.assertNotIn("max_tokens", s["body"])
        self.assertNotIn("temperature", s["body"])
        self.assertEqual(model, "gpt-test-1")
        self.assertEqual(llm.extract_json(text)[0]["merchant"], "Northwind Paper")

    def test_gemini_key_in_header_never_in_url(self):
        c = self.cfg("gemini", GEMINI_API_KEY="AIza-test", LLM_MODEL="models/gemini-some-model")
        text, model = llm.complete(c, "SYS", "USER", max_tokens=111)
        s = self.srv.seen
        self.assertEqual(s["path"], "/models/gemini-some-model:generateContent")
        self.assertNotIn("AIza-test", s["path"])
        self.assertEqual(s["headers"]["x-goog-api-key"], "AIza-test")
        self.assertEqual(s["body"], {"systemInstruction": {"parts": [{"text": "SYS"}]},
                                     "contents": [{"role": "user", "parts": [{"text": "USER"}]}],
                                     "generationConfig": {"maxOutputTokens": 111}})
        self.assertEqual((text, model), (REPLY, "gemini-test-1"))

    def test_openai_compatible_without_a_key(self):
        c = self.cfg("openai-compatible", LLM_MODEL="llama-local")
        llm.complete(c, "SYS", "USER", max_tokens=99)
        s = self.srv.seen
        self.assertNotIn("authorization", s["headers"])
        self.assertEqual(s["body"]["max_tokens"], 99)
        self.assertNotIn("max_completion_tokens", s["body"])

    def test_keys_never_appear_in_any_url(self):
        for provider, env in (("anthropic", {"ANTHROPIC_API_KEY": "K1"}), ("openai", {"OPENAI_API_KEY": "K2", "LLM_MODEL": "m"}),
                              ("gemini", {"GEMINI_API_KEY": "K3", "LLM_MODEL": "m"}),
                              ("openai-compatible", {"LLM_API_KEY": "K4", "LLM_MODEL": "m", "LLM_BASE_URL": "http://h/v1"})):
            c = llm.config_from_env({"LLM_PROVIDER": provider, **env})
            url, headers, _ = llm.build_request(c, "s", "u")
            with self.subTest(provider=provider):
                self.assertNotIn(env[llm.KEY_ENV[provider]], url)
                self.assertIn(env[llm.KEY_ENV[provider]], " ".join(headers.values()))

    def test_http_error_and_non_json_become_provider_errors(self):
        c = self.cfg("anthropic", ANTHROPIC_API_KEY="bad", path="/fail")
        with self.assertRaises(llm.ProviderError) as e:
            llm.complete(c, "s", "u")
        self.assertIn("HTTP 401", str(e.exception))
        c = self.cfg("anthropic", ANTHROPIC_API_KEY="k", path="/garbage")
        with self.assertRaises(llm.ProviderError):
            llm.complete(c, "s", "u")

    def test_unexpected_shape_is_an_error_not_an_empty_answer(self):
        with self.assertRaises(llm.ProviderError):
            llm.parse_response({"provider": "openai", "model": "m"}, {"choices": []})


class TestConfig(unittest.TestCase):
    def test_defaults_to_claude(self):
        c = llm.config_from_env({"ANTHROPIC_API_KEY": "k"})
        self.assertEqual((c["provider"], c["model"], c["base_url"]), ("anthropic", "claude-sonnet-5", "https://api.anthropic.com/v1"))

    def test_errors_name_the_variable_to_set(self):
        cases = [({}, "ANTHROPIC_API_KEY"), ({"LLM_PROVIDER": "openai", "OPENAI_API_KEY": "k"}, "LLM_MODEL"),
                 ({"LLM_PROVIDER": "gemini", "LLM_MODEL": "m"}, "GEMINI_API_KEY"),
                 ({"LLM_PROVIDER": "openai-compatible", "LLM_MODEL": "m"}, "LLM_BASE_URL"),
                 ({"LLM_PROVIDER": "mistral"}, "LLM_PROVIDER")]
        for env, var in cases:
            with self.subTest(env=env):
                with self.assertRaises(llm.ConfigError) as e:
                    llm.config_from_env(env)
                self.assertIn(var, str(e.exception))

    def test_describe_is_key_free(self):
        c = llm.config_from_env({"LLM_PROVIDER": "openai-compatible", "LLM_MODEL": "m", "LLM_BASE_URL": "http://localhost:11434/v1",
                                 "LLM_API_KEY": "secret-value"})
        self.assertEqual(llm.describe(c), "openai-compatible · m @ http://localhost:11434/v1")
        self.assertNotIn("secret", llm.describe(c))


class TestExtractJson(unittest.TestCase):
    def test_tolerates_fences_prose_and_brackets_in_strings(self):
        self.assertEqual(llm.extract_json("Here you go:\n```json\n[{\"a\": \"b]\"}]\n```"), [{"a": "b]"}])
        self.assertEqual(llm.extract_json('see [note] then [{"m": "say \\"hi\\" ]"}]'), [{"m": 'say "hi" ]'}])
        self.assertEqual(llm.extract_json('x {"k": {"v": "}"}} y', kind="object"), {"k": {"v": "}"}})
        # an escaped quote followed by a bracket: mishandling the escape cuts the array at the wrong "]"
        self.assertEqual(llm.extract_json('[{"m": "a \\" ] b"}]'), [{"m": 'a " ] b'}])
        # a model asked for an array sometimes wraps it in an object; the scan finds it there too
        self.assertEqual(llm.extract_json('Sure! {"results": [{"merchant": "A"}]}'), [{"merchant": "A"}])
        self.assertEqual(llm.extract_json('```json\n{"rows": [{"merchant": "B"}]}\n```'), [{"merchant": "B"}])
        # first wins: two arrays in one reply have nothing to choose between them, and position is predictable
        self.assertEqual(llm.extract_json('{"a": [1], "b": [2]}'), [1])

    def test_no_json_raises(self):
        with self.assertRaises(ValueError):
            llm.extract_json("I cannot help with that.")

    def test_a_reply_cut_off_mid_array_says_so(self):
        """The real 2026-09-22 failure: thirty merchants in one call, the array cut mid-string by the output limit.

        Saying 'no JSON array' for this points the reader at the parser, which is not where the fix is."""
        cut = ('[ {"merchant": "Northwind Office Supplies", "category": "Supplies", "confidence": 0.9, '
               '"reason": "Name explicitly says office supplies"}, {"merchant": "Paperclip Stationers Ltd", '
               '"category": "Suppl')
        with self.assertRaises(ValueError) as caught:
            llm.extract_json(cut)
        message = str(caught.exception)
        self.assertIn("never closes it", message)
        self.assertIn("cut off by the output limit", message)
        self.assertIn(str(len(cut)), message)          # the length is how you tell truncation from a refusal
        # the same array, closed, parses — so it is the truncation and not the spacing or the newlines
        self.assertEqual(len(llm.extract_json(cut[:cut.index(', {"merchant": "Paperclip')] + ' ]')), 1)

    def test_a_refusal_with_a_bracket_in_it_is_not_a_truncation(self):
        """A refusal often carries a bracket, and a bracket is not an unclosed array.

        The first version of the truncation branch asked whether the reply contained an opener at all, so it
        answered a 37-character refusal with "almost certainly cut off by the output limit" — which is the one
        message guaranteed to send the reader to the wrong place."""
        for reply in ("I cannot help [see policy] with that.",
                      "Sorry, the answer is [redacted].",
                      "Categories are [Supplies, Utilities]; I will not guess."):
            with self.assertRaises(ValueError) as caught:
                llm.extract_json(reply)
            message = str(caught.exception)
            self.assertIn("no JSON array", message, reply)
            self.assertNotIn("cut off", message, reply)
        # and something genuinely left open still reads as truncated
        with self.assertRaises(ValueError) as caught:
            llm.extract_json("Here it is: [oops")
        self.assertIn("never closes it", str(caught.exception))

    def test_a_failed_extraction_says_what_came_back_instead(self):
        """The reply is the evidence: without it the only way to learn what the model said is another paid call."""
        with self.assertRaises(ValueError) as caught:
            llm.extract_json("I cannot help with that.")
        self.assertIn("I cannot help with that.", str(caught.exception))
        with self.assertRaises(ValueError) as caught:
            llm.extract_json("no json here, key ghp_ABCDEF1234 quoted back")
        # deliberately too short to be a real token: the privacy gate flags ghp_ only from twenty characters,
        # and a fixture that trips it would leave that gate red for this repository for ever
        self.assertIn("ghp_…", str(caught.exception))
        self.assertNotIn("ABCDEF1234", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
