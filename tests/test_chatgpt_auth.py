"""Continue with ChatGPT (chatgpt_auth.py + the chatgpt provider in llm.py) against a local mock of OpenAI.

The mock plays the three OpenAI parts of the documented flow on 127.0.0.1: the OAuth server (discovery, JWKS,
authorize, token, revoke), the browser (a fake that follows the authorize redirect to the loopback callback), and the
Responses API (a scripted event stream). The ID token is signed with a real 2048-bit RSA key generated per run.

What this proves: the request parameters, checks, storage and stream handling follow the docs this code was written
from (developers.openai.com/siwc/token-sharing-open-source). What it cannot prove: that OpenAI's live servers answer
the same way today; that needs a real ChatGPT Plus/Pro sign-in (see the README).

    python -m unittest tests.test_chatgpt_auth -v        (or: python -m pytest tests/test_chatgpt_auth.py)
"""
import base64
import hashlib
import http.server
import io
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from contextlib import redirect_stderr, redirect_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
try:                                           # package layout (src/)
    from src import chatgpt_auth as ca, llm    # noqa: E402
    PKG = "src."
except ImportError:                            # flat layout
    import chatgpt_auth as ca                  # noqa: E402
    import llm                                 # noqa: E402
    PKG = ""

ISSUED = "oaiapp_test123"


# --- a real RSA key, pure Python, so the signature check is exercised for real ------------------------------------

def _is_prime(n, rounds=40):
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        x = pow(secrets.randbelow(n - 3) + 2, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits):
    while True:
        c = secrets.randbits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if _is_prime(c):
            return c


def make_key(kid):
    e = 65537
    while True:
        p, q = _prime(1024), _prime(1024)
        phi = (p - 1) * (q - 1)
        if p != q and phi % e:
            break
    n = p * q
    return {"kid": kid, "n": n, "e": e, "d": pow(e, -1, phi)}


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jwk(key):
    k = (key["n"].bit_length() + 7) // 8
    return {"kty": "RSA", "kid": key["kid"], "use": "sig", "alg": "RS256",
            "n": b64u(key["n"].to_bytes(k, "big")), "e": b64u(key["e"].to_bytes(3, "big"))}


def sign(claims, key, alg="RS256", kid=None):
    h = b64u(json.dumps({"alg": alg, "kid": kid or key["kid"], "typ": "JWT"}).encode())
    p = b64u(json.dumps(claims).encode())
    k = (key["n"].bit_length() + 7) // 8
    t = ca.SHA256_DIGEST_INFO + hashlib.sha256(f"{h}.{p}".encode()).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return f"{h}.{p}.{b64u(pow(int.from_bytes(em, 'big'), key['d'], key['n']).to_bytes(k, 'big'))}"


KEY = make_key("key-1")
OTHER = make_key("key-1")          # same kid, different key: a forged token


# --- the mock ---------------------------------------------------------------------------------------------------------

def sse(*events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def good_stream(text='[{"ok": true}]', model="gpt-mock"):
    half = len(text) // 2
    return sse({"type": "response.created", "response": {"id": "resp_1"}},
               {"type": "response.output_text.delta", "delta": text[:half]},
               {"type": "response.output_text.delta", "delta": text[half:]},
               {"type": "response.completed", "response": {"id": "resp_1", "model": model,
                                                           "usage": {"input_tokens": 3, "output_tokens": 4}}})


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj, headers=None):
        raw = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        s, base = self.server, self.server.base
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/.well-known/openid-configuration":
            return self._json(200, {"issuer": base, "authorization_endpoint": base + "/api/accounts/authorize",
                                    "token_endpoint": base + "/api/accounts/oauth/token",
                                    "revocation_endpoint": base + "/api/accounts/oauth/revoke",
                                    "jwks_uri": base + "/.well-known/jwks.json"})
        if u.path == "/.well-known/jwks.json":
            return self._json(200, {"keys": [jwk(KEY)]})
        if u.path == "/api/accounts/authorize":
            q = dict(urllib.parse.parse_qsl(u.query))
            s.authorize_log.append(q)
            back = {"state": "not-the-state" if s.knobs.get("bad_state") else q["state"]}
            if s.knobs.get("deny"):
                back["error"] = "access_denied"
            else:
                code = secrets.token_urlsafe(8)
                issued = ISSUED if q["client_id"] == ca.DYNAMIC_CLIENT else q["client_id"]
                s.codes[code] = dict(q, issued=issued)
                back["code"] = code
                back["scope"] = s.knobs.get("scope", ca.SCOPES)
                if "callback_client_id" in s.knobs:
                    if s.knobs["callback_client_id"]:
                        back["client_id"] = s.knobs["callback_client_id"]
                elif q["client_id"] == ca.DYNAMIC_CLIENT:
                    back["client_id"] = issued
            self.send_response(302)
            self.send_header("location", q["redirect_uri"] + "?" + urllib.parse.urlencode(back))
            self.end_headers()
            return
        if u.path == "/v1/models":
            s.models_log.append(self.headers.get("authorization"))
            return self._json(200, {"models": [{"slug": "gpt-a", "display_name": "GPT A", "visibility": "list"},
                                               {"slug": "gpt-hidden", "display_name": "H", "visibility": "hide"}]})
        self._json(404, {"error": "no route"})

    def do_POST(self):
        s = self.server
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path == "/api/accounts/oauth/token":
            f = dict(urllib.parse.parse_qsl(raw.decode()))
            s.token_log.append(f)
            if f.get("grant_type") == "authorization_code":
                pending = s.codes.pop(f.get("code"), None)
                ok = (pending and "client_secret" not in f and f.get("client_id") == pending["issued"]
                      and f.get("redirect_uri") == pending["redirect_uri"] and f.get("resource") == ca.RESOURCE
                      and b64u(hashlib.sha256(f.get("code_verifier", "").encode()).digest())
                      == pending["code_challenge"])
                if not ok:
                    return self._json(400, {"error": "invalid_grant"})
                return self._json(200, s.issue(pending["issued"], pending["nonce"]))
            if f.get("grant_type") == "refresh_token":
                time.sleep(s.knobs.get("refresh_delay", 0))
                if s.knobs.get("refresh_status"):
                    return self._json(s.knobs["refresh_status"], s.knobs.get("refresh_body", {}))
                if (f.get("refresh_token") not in s.live_refresh or f.get("client_id") != ISSUED
                        or f.get("resource") != ca.RESOURCE or "scope" in f):
                    return self._json(400, {"error": "invalid_grant"})
                s.live_refresh.discard(f["refresh_token"])          # rotating: the old one is spent
                out = s.issue(ISSUED, None)
                out.pop("id_token")
                return self._json(200, out)
            return self._json(400, {"error": "unsupported_grant_type"})
        if self.path == "/api/accounts/oauth/revoke":
            s.revoke_log.append(dict(urllib.parse.parse_qsl(raw.decode())))
            code = s.knobs.get("revoke_status", 200)
            self.send_response(code)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        if self.path == "/v1/responses":
            s.responses_log.append({"headers": {k.lower(): v for k, v in self.headers.items()},
                                    "body": json.loads(raw or b"{}")})
            status, body = s.knobs.get("responses", (200, good_stream()))
            self.send_response(status)
            self.send_header("content-type", "text/event-stream" if status == 200 else "application/json")
            self.send_header("x-request-id", "req_mock_1")
            self.end_headers()
            self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())
            return
        self._json(404, {"error": "no route"})


class MockServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def reset(self):
        self.knobs, self.codes, self.live_refresh, self.n = {}, {}, set(), 0
        self.authorize_log, self.token_log, self.revoke_log, self.responses_log, self.models_log = [], [], [], [], []

    def issue(self, client_id, nonce):
        self.n += 1
        rt = f"rt-{self.n}-{secrets.token_hex(4)}"
        self.live_refresh.add(rt)
        now = int(time.time())
        claims = {"iss": self.base, "aud": client_id, "sub": self.knobs.get("sub", "user-sub-1"),
                  "email": "someone@example.com", "iat": now, "exp": now + 3600}
        if nonce is not None:
            claims["nonce"] = nonce
        return {"access_token": f"at-{self.n}-{secrets.token_hex(4)}", "refresh_token": rt,
                "id_token": sign(claims, self.knobs.get("sign_with", KEY)), "token_type": "Bearer",
                "expires_in": 3600, "scope": self.knobs.get("scope", ca.SCOPES), "earliest_refresh_at": None}


def browser(url):
    """The user's browser: follow the authorize redirect back to the loopback callback."""
    threading.Thread(target=lambda: urllib.request.urlopen(url, timeout=10).read(), daemon=True).start()
    return True


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = MockServer(("127.0.0.1", 0), Mock)
        cls.srv.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        cls.srv.reset()
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.srv.reset()
        self.dir = tempfile.mkdtemp(prefix="chatgpt-auth-test-")
        self.said = []
        self.addCleanup(shutil.rmtree, self.dir, True)

    def login(self, **kw):
        return ca.login(d=self.dir, issuer=self.srv.base, open_browser=browser, port=0, timeout=10,
                        out=self.said.append, **kw)

    def record(self):
        return ca.load_active(self.dir)

    def env(self, **extra):
        return {"LLM_PROVIDER": "chatgpt", "LLM_MODEL": "gpt-mock", "LLM_BASE_URL": self.srv.base + "/v1",
                "CHATGPT_AUTH_DIR": self.dir, **extra}


# --- sign-in ----------------------------------------------------------------------------------------------------------

class TestSignIn(Base):
    def test_first_sign_in_registers_with_the_documented_parameters(self):
        rec = self.login()
        q = self.srv.authorize_log[0]
        self.assertEqual(q["client_id"], "dynamic_agent_client")
        self.assertEqual(q["agent_name_hint"], ca.APP_NAME)
        self.assertRegex(q["ext_agent_host_id"], r"^urn:uuid:[0-9a-f-]{36}$")
        self.assertEqual(q["scope"].split(), ["openid", "profile", "email", "offline_access", "resource.invoke",
                                              "chatgpt.tokens.use.direct"])
        self.assertEqual((q["response_type"], q["resource"], q["code_challenge_method"]),
                         ("code", "https://api.openai.com/v1", "S256"))
        self.assertRegex(q["redirect_uri"], r"^http://127\.0\.0\.1:\d+/auth/callback$")
        self.assertNotIn("id_token_hint", q)
        self.assertTrue(q["state"] and q["nonce"] and q["state"] != q["nonce"])
        # the exchange used the issued id, the same redirect_uri, the resource, a verifier matching the challenge
        ex = self.srv.token_log[0]
        self.assertEqual((ex["client_id"], ex["redirect_uri"], ex["resource"]), (ISSUED, q["redirect_uri"],
                                                                               ca.RESOURCE))
        self.assertEqual(b64u(hashlib.sha256(ex["code_verifier"].encode()).digest()), q["code_challenge"])
        self.assertTrue(43 <= len(ex["code_verifier"]) <= 128)
        self.assertNotIn("client_secret", ex)
        self.assertEqual(rec["client_id"], ISSUED)
        self.assertEqual(rec["subject"], "user-sub-1")
        self.assertIn("chatgpt.tokens.use.direct", rec["scopes"])
        for k in ("email", "issuer", "subject", "client_id", "ext_agent_host_id", "id_token", "access_token",
                  "refresh_token", "token_type", "expires_in", "scopes", "saved_at"):
            self.assertIn(k, rec)

    def test_credentials_are_private_files_outside_the_repo(self):
        self.login()
        path = os.path.join(self.dir, "accounts", ISSUED + ".json")
        self.assertTrue(os.path.isfile(path))
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.dir, "host.json")).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.dir, "accounts")).st_mode), 0o700)
        default = ca.auth_dir({})
        self.assertTrue(default.startswith(os.path.join(os.path.expanduser("~"), ".config", ca.APP_DIR)))
        self.assertFalse(os.path.abspath(default).startswith(ROOT + os.sep))

    def test_widened_file_mode_is_put_back(self):
        if os.name != "posix":
            self.skipTest("file modes are a Unix concept")
        self.login()
        path = os.path.join(self.dir, "accounts", ISSUED + ".json")
        os.chmod(path, 0o644)
        ca.load_active(self.dir)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_returning_sign_in_reuses_the_issued_client_and_host(self):
        first = self.login()
        self.login()
        q1, q2 = self.srv.authorize_log
        self.assertEqual(q2["client_id"], ISSUED)
        self.assertNotIn("agent_name_hint", q2)
        self.assertEqual(q2["ext_agent_host_id"], q1["ext_agent_host_id"])
        self.assertEqual(q2["id_token_hint"], first["id_token"])
        self.assertEqual(q2["login_hint"], "someone@example.com")
        self.assertNotEqual(q2["state"], q1["state"])
        self.assertNotIn("prompt", q2)
        self.assertFalse(any(first["id_token"] in m for m in self.said), "the id_token hint was printed unredacted")

    def test_state_mismatch_saves_nothing(self):
        self.srv.knobs["bad_state"] = True
        with self.assertRaisesRegex(ca.LoginError, "state"):
            self.login()
        self.assertIsNone(self.record())
        self.assertEqual(self.srv.token_log, [])

    def test_declined_consent_stops_before_any_exchange(self):
        self.srv.knobs["deny"] = True
        with self.assertRaises(ca.PlanNotEnabled) as cm:
            self.login()
        self.assertEqual(cm.exception.code, "access_denied")
        self.assertEqual(self.srv.token_log, [])
        self.assertIn("another provider", str(cm.exception))

    def test_new_registration_without_an_issued_client_id_is_incomplete(self):
        self.srv.knobs["callback_client_id"] = None
        with self.assertRaisesRegex(ca.LoginError, "issued client id"):
            self.login()
        self.assertIsNone(self.record())

    def test_new_registration_never_saves_dynamic_agent_client(self):
        self.srv.knobs["callback_client_id"] = "dynamic_agent_client"
        with self.assertRaises(ca.LoginError):
            self.login()
        self.assertFalse(os.path.exists(os.path.join(self.dir, "accounts", "dynamic_agent_client.json")))

    def test_reauth_callback_with_a_different_client_id_is_rejected(self):
        before = self.login()
        self.srv.knobs["callback_client_id"] = "oaiapp_someone_else"
        with self.assertRaisesRegex(ca.LoginError, "different client id"):
            self.login()
        self.assertEqual(self.record()["access_token"], before["access_token"])

    def test_reauth_as_a_different_account_replaces_nothing(self):
        before = self.login()
        self.srv.knobs["sub"] = "another-user"
        with self.assertRaisesRegex(ca.LoginError, "different ChatGPT account"):
            self.login()
        self.assertEqual(self.record()["access_token"], before["access_token"])

    def test_forged_id_token_is_rejected_and_nothing_saved(self):
        self.srv.knobs["sign_with"] = OTHER
        with self.assertRaisesRegex(ca.LoginError, "signature"):
            self.login()
        self.assertIsNone(self.record())

    def test_grant_without_plan_scope_signs_in_but_plan_stays_off(self):
        self.srv.knobs["scope"] = "openid profile email offline_access"
        rec = self.login()
        self.assertNotIn("chatgpt.tokens.use.direct", rec["scopes"])
        with self.assertRaises(ca.PlanNotEnabled):
            ca.check_ready(self.dir)
        with self.assertRaisesRegex(llm.ConfigError, "not enabled"):
            llm.config_from_env(self.env())
        self.srv.knobs.pop("scope")
        self.login()                                            # the user chose to enable it: ask for consent again
        self.assertEqual(self.srv.authorize_log[-1]["prompt"], "consent")
        self.assertIn("chatgpt.tokens.use.direct", self.srv.authorize_log[-1]["scope"].split())
        ca.check_ready(self.dir)


class TestIdToken(unittest.TestCase):
    JWKS = {"keys": [jwk(KEY)]}

    def claims(self, **over):
        now = int(time.time())
        c = {"iss": "https://auth.openai.com", "aud": ISSUED, "sub": "s", "iat": now, "exp": now + 60, "nonce": "N"}
        c.update(over)
        return c

    def verify(self, token, nonce="N"):
        return ca.verify_id_token(token, self.JWKS, "https://auth.openai.com", ISSUED, nonce)

    def test_valid_token(self):
        self.assertEqual(self.verify(sign(self.claims(), KEY))["sub"], "s")

    def test_rejections(self):
        good = sign(self.claims(), KEY)
        h, p, s = good.split(".")
        tampered = f"{h}.{b64u(json.dumps(self.claims(sub='x')).encode())}.{s}"
        cases = {
            "tampered payload": tampered,
            "wrong key": sign(self.claims(), OTHER),
            "alg HS256": sign(self.claims(), KEY, alg="HS256"),
            "unknown kid": sign(self.claims(), KEY, kid="nope"),
            "wrong issuer": sign(self.claims(iss="https://evil.example"), KEY),
            "wrong audience": sign(self.claims(aud="oaiapp_other"), KEY),
            "expired": sign(self.claims(exp=int(time.time()) - 60), KEY),
            "no subject": sign(self.claims(sub=""), KEY),
            "not a jwt": "abc",
        }
        for name, tok in cases.items():
            with self.subTest(name), self.assertRaises(ca.LoginError):
                self.verify(tok)
        with self.assertRaisesRegex(ca.LoginError, "nonce"):
            self.verify(good, nonce="other")


# --- sessions ---------------------------------------------------------------------------------------------------------

class TestSession(Base):
    def age(self, seconds_left):
        rec = self.record()
        rec["saved_at"] = ca._utc_now_iso(time.time() - 3600 + seconds_left)
        ca.save_account(self.dir, rec)
        return rec

    def token(self):
        return ca.access_token(self.dir, issuer=self.srv.base)

    def test_fresh_token_is_used_without_refreshing(self):
        rec = self.login()
        self.assertEqual(self.token(), rec["access_token"])
        self.assertEqual(len(self.srv.token_log), 1)

    def test_refresh_near_expiry_follows_the_docs_and_rotates(self):
        self.login()
        old = self.age(60)
        new = self.token()
        f = self.srv.token_log[-1]
        self.assertEqual(f, {"grant_type": "refresh_token", "client_id": ISSUED,
                             "refresh_token": old["refresh_token"], "resource": "https://api.openai.com/v1"})
        rec = self.record()
        self.assertNotEqual(new, old["access_token"])
        self.assertEqual(rec["access_token"], new)
        self.assertNotEqual(rec["refresh_token"], old["refresh_token"])
        self.assertEqual(rec["id_token"], old["id_token"])
        self.assertGreater(ca.expires_at(rec) - time.time(), 3000)
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.dir, "accounts", ISSUED + ".json")).st_mode),
                             0o600)
        self.age(60)
        self.token()                                    # the replacement refresh token works the next time too
        self.assertEqual(sum(1 for f in self.srv.token_log if f["grant_type"] == "refresh_token"), 2)

    def test_concurrent_refreshes_are_serialized(self):
        self.login()
        self.age(60)
        self.srv.knobs["refresh_delay"] = 0.3
        got, errors = [], []

        def run():
            try:
                got.append(self.token())
            except Exception as e:      # noqa: BLE001 - reported below
                errors.append(e)
        threads = [threading.Thread(target=run) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(sum(1 for f in self.srv.token_log if f["grant_type"] == "refresh_token"), 1)
        self.assertEqual(len(set(got)), 1)

    def test_unusable_refresh_token_clears_tokens_and_asks_to_sign_in(self):
        for code in sorted(ca.UNUSABLE_REFRESH):
            with self.subTest(code):
                self.srv.reset()
                self.login()
                self.age(60)
                self.srv.knobs.update(refresh_status=400, refresh_body={"error": code})
                with self.assertRaises(ca.NeedsSignIn):
                    self.token()
                rec = self.record()
                self.assertIsNone(rec["access_token"])
                self.assertIsNone(rec["refresh_token"])
                self.assertEqual(rec["client_id"], ISSUED)       # the registration is kept for the next sign-in

    def test_temporary_refresh_failure_keeps_the_credentials(self):
        before = self.login()
        self.age(60)
        self.srv.knobs.update(refresh_status=503, refresh_body={})
        with self.assertRaises(ca.ChatGPTError) as cm:
            self.token()
        self.assertNotIsInstance(cm.exception, ca.NeedsSignIn)
        self.assertEqual(self.record()["refresh_token"], before["refresh_token"])

    def test_logout_revokes_then_clears_and_keeps_the_registration(self):
        rec = self.login()
        host = rec["ext_agent_host_id"]
        self.assertTrue(ca.logout(self.dir, issuer=self.srv.base, out=self.said.append))
        self.assertEqual(self.srv.revoke_log, [{"token": rec["refresh_token"], "token_type_hint": "refresh_token",
                                                "client_id": ISSUED}])
        after = self.record()
        self.assertEqual((after["access_token"], after["refresh_token"], after["id_token"]), (None, None, None))
        self.assertEqual((after["client_id"], after["ext_agent_host_id"]), (ISSUED, host))
        with self.assertRaises(ca.NeedsSignIn):
            ca.check_ready(self.dir)
        self.login()
        self.assertEqual(self.srv.authorize_log[-1]["client_id"], ISSUED)
        self.assertNotIn("id_token_hint", self.srv.authorize_log[-1])

    def test_logout_without_confirmation_still_clears_and_says_so(self):
        self.login()
        self.srv.knobs["revoke_status"] = 503
        self.assertFalse(ca.logout(self.dir, issuer=self.srv.base, out=self.said.append, sleep=lambda s: None))
        self.assertEqual(len(self.srv.revoke_log), 3)
        self.assertIsNone(self.record()["refresh_token"])
        self.assertIn("did not confirm", self.said[-1])

    def test_no_token_is_ever_printed(self):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            rec = self.login()
            self.age(60)
            new = self.token()
            ca.logout(self.dir, issuer=self.srv.base, out=self.said.append)
        text = buf.getvalue() + "\n".join(self.said)
        for secret in (rec["access_token"], rec["refresh_token"], rec["id_token"], new):
            self.assertNotIn(secret, text)

    def test_model_list_keeps_only_listed_models(self):
        rec = self.login()
        self.assertEqual(ca.list_models(self.srv.base + "/v1", rec["access_token"]), [("gpt-a", "GPT A")])
        self.assertEqual(self.srv.models_log, ["Bearer " + rec["access_token"]])


# --- inference through llm.py -----------------------------------------------------------------------------------------

class TestResponses(Base):
    def setUp(self):
        super().setUp()
        self.rec = self.login()
        self.cfg = llm.config_from_env(self.env())

    def test_streamed_request_follows_the_preview_limits(self):
        text, model = llm.complete(self.cfg, "SYS", "USER", max_tokens=999)
        self.assertEqual((text, model), ('[{"ok": true}]', "gpt-mock"))
        seen = self.srv.responses_log[0]
        self.assertEqual(seen["headers"]["authorization"], "Bearer " + self.rec["access_token"])
        self.assertEqual(seen["body"], {"model": "gpt-mock", "instructions": "SYS",
                                        "input": [{"role": "user", "content": "USER"}],
                                        "store": False, "stream": True})
        self.assertNotIn(self.rec["access_token"], llm.describe(self.cfg))
        self.assertEqual(self.cfg["api_key"], "")        # the token is fetched per call, never kept in the config

    def test_text_is_read_from_the_final_output_when_no_deltas_came(self):
        self.srv.knobs["responses"] = (200, sse({"type": "response.completed", "response": {
            "model": "gpt-mock", "output": [{"content": [{"type": "output_text", "text": "whole"}]}]}}))
        self.assertEqual(llm.complete(self.cfg, "s", "u")[0], "whole")

    def test_stream_without_completed_is_an_error_not_a_partial_answer(self):
        self.srv.knobs["responses"] = (200, sse({"type": "response.output_text.delta", "delta": "[{\"half"}))
        with self.assertRaisesRegex(llm.ProviderError, "without response.completed"):
            llm.complete(self.cfg, "s", "u")

    def test_usage_limit_after_streaming_began(self):
        self.srv.knobs["responses"] = (200, sse(
            {"type": "response.output_text.delta", "delta": "par"},
            {"type": "response.failed", "response": {"error": {"code": "subscription_sharing_usage_limit_exceeded",
                                                               "message": "limit"}}}))
        with self.assertRaises(llm.ProviderError) as cm:
            llm.complete(self.cfg, "s", "u")
        self.assertEqual(cm.exception.code, "subscription_sharing_usage_limit_exceeded")
        self.assertIn("chatgpt.com/settings/usage", str(cm.exception))

    def test_incomplete_response_is_an_error(self):
        self.srv.knobs["responses"] = (200, sse({"type": "response.incomplete",
                                                 "response": {"incomplete_details": {"reason": "content_filter"}}}))
        with self.assertRaisesRegex(llm.ProviderError, "content_filter"):
            llm.complete(self.cfg, "s", "u")

    def test_not_eligible_account_gets_a_clear_error_once(self):
        self.srv.knobs["responses"] = (403, {"error": {"code": "subscription_sharing_user_not_eligible",
                                                       "message": "not eligible", "param": None}})
        with self.assertRaises(llm.ProviderError) as cm:
            llm.complete(self.cfg, "s", "u")
        msg = str(cm.exception)
        self.assertEqual(cm.exception.code, "subscription_sharing_user_not_eligible")
        self.assertIn("Plus or Pro", msg)
        self.assertIn("req_mock_1", msg)
        self.assertIn("LLM_PROVIDER=anthropic", msg)
        self.assertEqual(len(self.srv.responses_log), 1)             # not retried
        self.assertEqual(len(self.srv.authorize_log), 1)             # no OAuth loop
        self.assertIsNotNone(self.record()["refresh_token"])         # credentials kept

    def test_unsupported_capability_names_the_param(self):
        self.srv.knobs["responses"] = (400, {"error": {"code": "subscription_sharing_unsupported_capability",
                                                       "message": "x", "param": "tools[0]"}})
        with self.assertRaisesRegex(llm.ProviderError, r"tools\[0\]"):
            llm.complete(self.cfg, "s", "u")

    def test_admission_error_with_detail_body(self):
        self.srv.knobs["responses"] = (401, {"detail": "signed identity missing"})
        with self.assertRaisesRegex(llm.ProviderError, "signed identity missing.*HTTP 401"):
            llm.complete(self.cfg, "s", "u")

    def test_sse_parser_edges(self):
        lines = [b": comment\n", b"data: {\"type\":\n", b"data: \"x\"}\n", b"\n", b"data: [DONE]\n", b"\n"]
        self.assertEqual(list(ca.iter_sse(lines)), [{"type": "x"}])


class TestProviders(Base):
    def test_not_signed_in_names_the_other_providers(self):
        with self.assertRaises(llm.ConfigError) as cm:
            llm.config_from_env(self.env())
        msg = str(cm.exception)
        self.assertIn("login", msg)
        self.assertIn("LLM_PROVIDER=anthropic|openai|gemini|openai-compatible", msg)

    def test_model_is_required(self):
        self.login()
        with self.assertRaisesRegex(llm.ConfigError, "LLM_MODEL is required for chatgpt"):
            llm.config_from_env({k: v for k, v in self.env().items() if k != "LLM_MODEL"})

    def test_token_cannot_be_sent_to_another_host(self):
        self.login()
        with self.assertRaisesRegex(llm.ConfigError, "cannot be changed"):
            llm.config_from_env(self.env(LLM_BASE_URL="https://gateway.example/v1"))
        self.assertEqual(llm.config_from_env({**self.env(), "LLM_BASE_URL": ""})["base_url"],
                         "https://api.openai.com/v1")

    def test_other_providers_are_untouched_and_never_load_chatgpt_auth(self):
        self.login()                                    # a signed-in ChatGPT session exists on this machine
        code = ("import json, sys; sys.path.insert(0, sys.argv[1]); "
                f"from {PKG.rstrip('.') or 'importlib'} import {'llm' if PKG else 'import_module'} as m; "
                + ("llm = m; " if PKG else "llm = m('llm'); ")
                + "c = llm.config_from_env({'LLM_PROVIDER': 'openai', 'OPENAI_API_KEY': 'k', 'LLM_MODEL': 'x', "
                  "'CHATGPT_AUTH_DIR': sys.argv[2]}); "
                  "print(json.dumps([c['provider'], c['base_url'], c['api_key'], "
                  f"any(n.endswith('chatgpt_auth') for n in sys.modules)]))")
        out = subprocess.run([sys.executable, "-c", code, ROOT, self.dir], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), ["openai", "https://api.openai.com/v1", "k", False])
        self.assertIn("chatgpt", llm.PROVIDERS)
        for p in ("anthropic", "openai", "gemini", "openai-compatible"):
            self.assertIn(p, llm.PROVIDERS)


if __name__ == "__main__":
    unittest.main()
