"""chatgpt_auth.py — "Continue with ChatGPT": run this tool on your own ChatGPT Plus or Pro plan, no API key.

This is OpenAI's official Sign in with ChatGPT flow for open-source, locally hosted apps ("ChatGPT plan usage"),
implemented from https://developers.openai.com/siwc/token-sharing-open-source and its sub-pages
(sign-in, profiles-and-sessions, models-and-inference, errors-and-recovery, preview-limitations, token-reference).
Standard library only.
Status: tested against a local mock of the documented flow only; not yet signed in against the live service.

    python chatgpt_auth.py login           # opens your browser; first time registers this tool with your account
    python chatgpt_auth.py status          # who is signed in, whether plan usage is enabled (never prints a token)
    python chatgpt_auth.py models          # model ids your plan can use; put one in LLM_MODEL
    python chatgpt_auth.py logout          # revokes the session at OpenAI, then clears the local tokens

What the flow does, step by step (doc section in brackets):
  - First sign-in uses client_id=dynamic_agent_client with agent_name_hint and ext_agent_host_id; the callback returns
    the issued client_id (oaiapp_...), which is saved and used for every later sign-in and refresh. [sign-in §2-3]
  - The browser returns to an HTTP loopback listener on 127.0.0.1 at /auth/callback (port 1455, or any free port if
    1455 is busy). The same redirect_uri goes into the code exchange. No client secret. [sign-in §2]
  - Fresh state, OIDC nonce and PKCE (S256) per attempt; state is checked before anything else. [sign-in §2-3]
  - The ID token's RS256 signature is checked against OpenAI's published JWKS, then issuer, audience (the issued
    client_id), expiry and nonce. [sign-in §4]
  - Plan usage is on only if the token response grants chatgpt.tokens.use.direct. [sign-in §4, errors §1]
  - Tokens are stored in one local file per issued client_id, written atomically with mode 0600, under
    ~/.config/<tool>/chatgpt/ (override: CHATGPT_AUTH_DIR). Never in the repo, never logged. [sign-in §5]
  - Refresh near expiry with grant_type=refresh_token, the issued client_id, resource, no scope; the rotating refresh
    token is replaced together with the access token; refreshes are serialized with a lock file. [sessions]
  - Inference: POST /v1/responses with the access token as Bearer, store:false, stream:true, input as an array,
    system prompt as `instructions`; success only on response.completed. [models-and-inference, preview limits]

Design choice to know about: the docs recommend "a maintained JWT library when possible". This project has no
third-party dependencies, so RS256 verification is done here with the standard library (PKCS#1 v1.5 encoding
comparison, which is how RFC 8017 §8.2.2 specifies verification). tests/test_chatgpt_auth.py signs real tokens
with a generated 2048-bit key and checks that a tampered token, a wrong key and a wrong algorithm are rejected.
"""
import base64
import datetime
import hashlib
import hmac
import http.server
import json
import os
import secrets
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

# --- per-project settings (the only lines that differ between the projects that carry this file) -------------------
APP_NAME = "Bill Bench"                         # agent_name_hint: the app's actual name, the same on every install
APP_DIR = "bill-bench"                          # ~/.config/<APP_DIR>/chatgpt/
LOGIN_COMMAND = "python chatgpt_auth.py login"  # what error messages tell the user to run
OTHER_PROVIDERS = "LLM_PROVIDER=anthropic|openai|gemini|openai-compatible with that provider's key"
# ---------------------------------------------------------------------------------------------------------------------

ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
API_BASE = "https://api.openai.com/v1"
DYNAMIC_CLIENT = "dynamic_agent_client"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SCOPES = "openid profile email offline_access resource.invoke " + PLAN_SCOPE
CALLBACK_PATH = "/auth/callback"
DEFAULT_PORT = 1455
REFRESH_MARGIN = 300          # refresh when the access token has less than 5 minutes left
CLOCK_SKEW = 5                # seconds of tolerance on exp, as in the docs' example
USAGE_URL = "https://chatgpt.com/settings/usage"
# Refresh errors that mean the refresh token is unusable: clear tokens and sign in again. [errors-and-recovery]
UNUSABLE_REFRESH = {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
                    "refresh_token_invalidated", "refresh_token_reused"}
SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


class ChatGPTError(RuntimeError):
    """Base class. `code` is the machine-readable code from OpenAI when there was one."""
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


class NeedsSignIn(ChatGPTError):
    """No usable session: never signed in, signed out, or the refresh token is no longer valid."""


class PlanNotEnabled(ChatGPTError):
    """Signed in, but the grant lacks chatgpt.tokens.use.direct (consent declined or not given)."""


class NotEligible(ChatGPTError):
    """subscription_sharing_user_not_eligible: this account, workspace or policy cannot spend its plan here."""


class LoginError(ChatGPTError):
    """The sign-in attempt failed or returned something that must not be trusted."""


# --- storage -----------------------------------------------------------------------------------------------------------

def auth_dir(env=None):
    env = os.environ if env is None else env
    return env.get("CHATGPT_AUTH_DIR") or os.path.join(os.path.expanduser("~"), ".config", APP_DIR, "chatgpt")


def _mkdir_private(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    if os.name == "posix":
        os.chmod(path, 0o700)


def write_private(path, obj):
    """Atomic write, owner-only (0600 on Unix): temp file in the same directory, fsync, then rename over."""
    _mkdir_private(os.path.dirname(path))
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".json")
    try:
        if os.name == "posix":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    if os.name == "posix" and os.stat(path).st_mode & 0o077:
        os.chmod(path, 0o600)   # someone widened it; put it back rather than keep a readable token file
    return data


def _account_path(d, client_id):
    safe = "".join(ch for ch in client_id if ch.isalnum() or ch in "-_.")
    if not safe or safe != client_id:
        raise LoginError(f"refusing to store an unexpected client id {client_id!r}")
    return os.path.join(d, "accounts", safe + ".json")


def host_id(d):
    """This host's stable, opaque ext_agent_host_id (urn:uuid:<UUIDv4>), created once before the first sign-in."""
    path = os.path.join(d, "host.json")
    rec = read_json(path)
    if rec and str(rec.get("ext_agent_host_id", "")).startswith("urn:uuid:"):
        return rec["ext_agent_host_id"]
    value = "urn:uuid:" + str(uuid.uuid4())
    write_private(path, {"ext_agent_host_id": value})
    return value


def load_active(d):
    """The selected account's credential record, or None."""
    pointer = read_json(os.path.join(d, "active.json"))
    if not pointer or not pointer.get("client_id"):
        return None
    return read_json(_account_path(d, pointer["client_id"]))


def save_account(d, record, make_active=True):
    write_private(_account_path(d, record["client_id"]), record)
    if make_active:
        write_private(os.path.join(d, "active.json"), {"client_id": record["client_id"]})


def _utc_now_iso(now):
    return datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_to_epoch(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()


def expires_at(record):
    try:
        return _iso_to_epoch(record["saved_at"]) + float(record["expires_in"])
    except (KeyError, TypeError, ValueError):
        return 0.0


# --- HTTP helpers ------------------------------------------------------------------------------------------------------

def _http(req, opener, timeout):
    """Returns (status, headers, body_bytes); HTTP errors come back as values, network errors raise."""
    open_ = opener or urllib.request.urlopen
    try:
        with open_(req, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, (e.read() if hasattr(e, "read") else b"")


def _get_json(url, opener=None, timeout=30):
    status, _h, body = _http(urllib.request.Request(url, headers={"accept": "application/json"}), opener, timeout)
    if status != 200:
        raise ChatGPTError(f"GET {url} answered HTTP {status}")
    return json.loads(body.decode("utf-8"))


def _post_form(url, fields, opener=None, timeout=30):
    data = urllib.parse.urlencode(fields).encode("ascii")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"content-type": "application/x-www-form-urlencoded",
                                          "accept": "application/json"})
    status, _h, body = _http(req, opener, timeout)
    try:
        parsed = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeDecodeError):
        parsed = {}
    return status, parsed


def discover(issuer=ISSUER, opener=None):
    """OpenAI's OIDC discovery document; its issuer must equal the one asked for."""
    doc = _get_json(issuer.rstrip("/") + "/.well-known/openid-configuration", opener)
    if doc.get("issuer") != issuer:
        raise LoginError(f"discovery issuer {doc.get('issuer')!r} does not match {issuer!r}")
    return doc


# --- ID token (RS256) --------------------------------------------------------------------------------------------------

def _b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def rs256_verify(n, e, message, signature):
    """RSASSA-PKCS1-v1_5 with SHA-256 (RFC 8017 §8.2.2): rebuild the expected encoding and compare it whole."""
    k = (n.bit_length() + 7) // 8
    if n.bit_length() < 2048 or len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    t = SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(em, expected)


def verify_id_token(id_token, jwks, issuer, client_id, nonce, now=None):
    """Signature against the JWKS, then iss, aud, exp, iat, nonce, sub. Returns the claims."""
    now = time.time() if now is None else now
    try:
        h64, p64, s64 = id_token.split(".")
        header, claims, sig = json.loads(_b64d(h64)), json.loads(_b64d(p64)), _b64d(s64)
    except (ValueError, AttributeError):
        raise LoginError("the ID token is not a well-formed JWT") from None
    if header.get("alg") != "RS256":
        raise LoginError(f"unexpected ID token algorithm {header.get('alg')!r} (OpenAI signs with RS256)")
    keys = [k for k in jwks.get("keys", []) if k.get("kty") == "RSA" and k.get("kid") == header.get("kid")]
    if not keys:
        raise LoginError("the ID token's signing key is not in OpenAI's JWKS")
    key = keys[0]
    n, e = int.from_bytes(_b64d(key["n"]), "big"), int.from_bytes(_b64d(key["e"]), "big")
    if not rs256_verify(n, e, (h64 + "." + p64).encode("ascii"), sig):
        raise LoginError("the ID token signature does not verify against OpenAI's JWKS")
    if claims.get("iss") != issuer:
        raise LoginError(f"ID token issuer {claims.get('iss')!r} is not {issuer!r}")
    aud = claims.get("aud")
    if not (aud == client_id or (isinstance(aud, list) and client_id in aud)):
        raise LoginError("ID token audience is not this tool's issued client id")
    if not isinstance(claims.get("exp"), (int, float)) or claims["exp"] < now - CLOCK_SKEW:
        raise LoginError("the ID token has expired")
    if not isinstance(claims.get("iat"), (int, float)):
        raise LoginError("the ID token has no issued-at time")
    if not isinstance(claims.get("nonce"), str) or not hmac.compare_digest(claims["nonce"], nonce):
        raise LoginError("the ID token nonce does not match this sign-in attempt")
    if not isinstance(claims.get("sub"), str) or not claims["sub"]:
        raise LoginError("the ID token has no subject")
    return claims


def _jwks_for(doc, kid_hint, opener):
    """Fetch the JWKS (once more if the token's kid is unfamiliar, as the docs advise)."""
    jwks = _get_json(doc["jwks_uri"], opener)
    if kid_hint and not any(k.get("kid") == kid_hint for k in jwks.get("keys", [])):
        jwks = _get_json(doc["jwks_uri"], opener)
    return jwks


# --- sign-in -----------------------------------------------------------------------------------------------------------

def pkce_pair():
    verifier = secrets.token_urlsafe(64)[:86]           # 43-128 characters, unreserved alphabet (RFC 7636 §4.1)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode()
    return verifier, challenge


class _Callback(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):   # the query string holds the code: keep it out of stderr
        pass

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != CALLBACK_PATH:
            self.send_response(404); self.end_headers(); return
        self.server.result = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        page = (b"<!doctype html><meta charset=utf-8><title>Signed in</title>"
                b"<p style='font:16px system-ui;margin:3em'>You can close this tab and return to the terminal.</p>")
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)
        self.server.done.set()


def _listen(port):
    """Loopback listener on 127.0.0.1 (never `localhost`). Falls back to any free port if the preferred one is busy."""
    for p in (port, 0) if port else (0,):
        try:
            srv = http.server.HTTPServer(("127.0.0.1", p), _Callback)
            break
        except OSError:
            continue
    else:
        raise LoginError("could not open a loopback port on 127.0.0.1 for the sign-in callback")
    srv.result, srv.done = None, threading.Event()
    return srv


def _redact(url):
    parts = urllib.parse.urlsplit(url)
    q = [(k, "<redacted>" if k == "id_token_hint" else v) for k, v in urllib.parse.parse_qsl(parts.query)]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(q)))


def login(new_account=False, d=None, issuer=ISSUER, open_browser=None, port=DEFAULT_PORT, timeout=300,
          opener=None, now=None, out=None):
    """Run one browser sign-in and save the result. Returns the saved credential record."""
    d = d or auth_dir()
    out = out or (lambda msg: print(msg, file=sys.stderr))
    doc = discover(issuer, opener)
    host = host_id(d)                                   # persisted before the first sign-in
    previous = None if new_account else load_active(d)
    client_id = previous["client_id"] if previous else DYNAMIC_CLIENT
    srv = _listen(port)
    try:
        redirect_uri = f"http://127.0.0.1:{srv.server_address[1]}{CALLBACK_PATH}"
        state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        verifier, challenge = pkce_pair()
        params = {"client_id": client_id, "response_type": "code", "redirect_uri": redirect_uri, "scope": SCOPES,
                  "resource": RESOURCE, "state": state, "nonce": nonce, "code_challenge_method": "S256",
                  "code_challenge": challenge, "ext_agent_host_id": host}
        if client_id == DYNAMIC_CLIENT:
            params["agent_name_hint"] = APP_NAME
        else:
            if previous.get("id_token"):
                params["id_token_hint"] = previous["id_token"]
            if previous.get("email"):
                params["login_hint"] = previous["email"]
            if PLAN_SCOPE not in (previous.get("scopes") or []):
                params["prompt"] = "consent"            # asking again for plan usage after an earlier decline
        url = doc["authorization_endpoint"] + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        out(f"Opening your browser to Continue with ChatGPT ({'new registration' if client_id == DYNAMIC_CLIENT else 'saved account'}).")
        out(f"If no browser opens, visit: {_redact(url) if 'id_token_hint' in params else url}")
        if not (open_browser or webbrowser.open)(url) and "id_token_hint" in params:
            # the printed link above is redacted; this terminal is the only place the full one goes (never a log)
            out("No browser could be opened. Open this link yourself; it carries your account hint, so do not "
                f"paste it anywhere else:\n{url}")
        if not srv.done.wait(timeout):
            raise LoginError(f"no answer from the browser within {timeout} seconds")
        cb = srv.result or {}
    finally:
        srv.shutdown()
        srv.server_close()

    if not hmac.compare_digest(cb.get("state", ""), state):
        raise LoginError("the callback's state does not match this sign-in attempt; nothing was saved")
    if cb.get("error"):
        if cb["error"] == "access_denied":
            raise PlanNotEnabled("sign-in was declined in the browser. Run the login again to allow ChatGPT plan "
                                 f"usage, or use another provider ({OTHER_PROVIDERS}).", code="access_denied")
        raise LoginError(f"sign-in failed: {cb['error']} {cb.get('error_description', '')}".strip(), code=cb["error"])
    returned = cb.get("client_id")
    if client_id == DYNAMIC_CLIENT:
        if not returned or returned == DYNAMIC_CLIENT:
            raise LoginError("registration is incomplete: the callback did not include an issued client id")
        client_id = returned
    elif returned and returned != client_id:
        raise LoginError("the callback returned a different client id than the selected account's; not replacing it")
    if not cb.get("code"):
        raise LoginError("the callback did not include an authorization code")

    status, tok = _post_form(doc["token_endpoint"], {
        "grant_type": "authorization_code", "client_id": client_id, "code": cb["code"],
        "code_verifier": verifier, "redirect_uri": redirect_uri, "resource": RESOURCE}, opener)
    if status != 200 or not tok.get("access_token"):
        code = tok.get("error")
        hint = " Run the login again." if code == "invalid_grant" else ""
        raise LoginError(f"code exchange failed (HTTP {status}, {code or 'no error code'}).{hint}", code=code)

    try:
        kid = json.loads(_b64d(tok["id_token"].split(".")[0])).get("kid")
    except (KeyError, ValueError, AttributeError, IndexError):
        raise LoginError("the token response did not include a readable ID token") from None
    claims = verify_id_token(tok["id_token"], _jwks_for(doc, kid, opener), doc["issuer"], client_id, nonce, now)
    if previous and previous.get("subject") and claims["sub"] != previous["subject"]:
        raise LoginError("signed in as a different ChatGPT account than the saved one; nothing was replaced. "
                         "Use `login --new-account` to add another account.")
    t = time.time() if now is None else now
    record = {"email": claims.get("email"), "issuer": doc["issuer"], "subject": claims["sub"], "client_id": client_id,
              "ext_agent_host_id": host, "id_token": tok["id_token"], "access_token": tok["access_token"],
              "refresh_token": tok.get("refresh_token"), "token_type": tok.get("token_type", "Bearer"),
              "expires_in": tok.get("expires_in", 3600), "scopes": sorted(str(tok.get("scope", "")).split()),
              "earliest_refresh_at": tok.get("earliest_refresh_at"), "saved_at": _utc_now_iso(t)}
    save_account(d, record)
    if PLAN_SCOPE in record["scopes"]:
        out(f"Signed in as {record['email'] or record['subject']}. ChatGPT plan usage is enabled.")
    else:
        out(f"Signed in as {record['email'] or record['subject']}, but ChatGPT plan usage was not granted. "
            f"Run the login again to allow it, or use another provider ({OTHER_PROVIDERS}).")
    return record


# --- session -----------------------------------------------------------------------------------------------------------

def check_ready(d=None):
    """Raise unless a signed-in account with plan usage is selected. No network."""
    rec = load_active(d or auth_dir())
    if not rec or not rec.get("refresh_token") and not rec.get("access_token"):
        raise NeedsSignIn(f"not signed in with ChatGPT. Run `{LOGIN_COMMAND}`, or use another provider "
                          f"({OTHER_PROVIDERS}).")
    if PLAN_SCOPE not in (rec.get("scopes") or []):
        raise PlanNotEnabled(f"signed in, but ChatGPT plan usage is not enabled for this account. Run "
                             f"`{LOGIN_COMMAND}` and allow it, or use another provider ({OTHER_PROVIDERS}).")
    return rec


class _Lock:
    """Cross-process lock file (O_EXCL), so two processes never race a rotating refresh token."""
    def __init__(self, path, wait=30.0, stale=120.0):
        self.path, self.wait, self.stale = path, wait, stale

    def __enter__(self):
        deadline = time.time() + self.wait
        while True:
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
                return self
            except FileExistsError:
                try:
                    if time.time() - os.stat(self.path).st_mtime > self.stale:
                        os.remove(self.path)
                        continue
                except FileNotFoundError:
                    continue
                if time.time() > deadline:
                    raise ChatGPTError(f"another process holds {self.path}; try again")
                time.sleep(0.1)

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except FileNotFoundError:
            pass


def _clear_tokens(rec):
    for k in ("access_token", "refresh_token"):
        rec[k] = None
    return rec


def refresh(d, rec, issuer=ISSUER, opener=None, now=None):
    """grant_type=refresh_token with the issued client id, the saved refresh token and resource; no scope."""
    if not rec.get("refresh_token"):
        raise NeedsSignIn(f"the ChatGPT session has no refresh token. Run `{LOGIN_COMMAND}`.")
    doc = discover(issuer, opener)
    status, tok = _post_form(doc["token_endpoint"], {
        "grant_type": "refresh_token", "client_id": rec["client_id"], "refresh_token": rec["refresh_token"],
        "resource": RESOURCE}, opener)
    if status == 200 and tok.get("access_token"):
        t = time.time() if now is None else now
        rec.update({"access_token": tok["access_token"],
                    "refresh_token": tok.get("refresh_token") or rec["refresh_token"],
                    "expires_in": tok.get("expires_in", 3600),
                    "scopes": sorted(str(tok["scope"]).split()) if tok.get("scope") else rec.get("scopes", []),
                    "earliest_refresh_at": tok.get("earliest_refresh_at"),
                    "token_type": tok.get("token_type", rec.get("token_type", "Bearer")),
                    "saved_at": _utc_now_iso(t)})
        save_account(d, rec, make_active=False)
        return rec
    code = tok.get("error")
    if code in UNUSABLE_REFRESH:
        save_account(d, _clear_tokens(rec), make_active=False)
        raise NeedsSignIn(f"the ChatGPT session ended ({code}). Run `{LOGIN_COMMAND}` to sign in again.", code=code)
    if code == "invalid_client":
        raise ChatGPTError("OpenAI rejected this tool's client id (invalid_client). Run "
                           f"`{LOGIN_COMMAND.replace(' login', ' login --new-account')}`.", code=code)
    # network trouble, 5xx, anything else: keep the credentials, report, let the user retry
    raise ChatGPTError(f"token refresh failed (HTTP {status}, {code or 'no error code'}); credentials kept, try again",
                       code=code)


def access_token(d=None, issuer=ISSUER, opener=None, now=None):
    """A current access token for the selected account, refreshing it first when it is close to expiry."""
    d = d or auth_dir()
    rec = check_ready(d)
    t = time.time() if now is None else now
    if rec.get("access_token") and expires_at(rec) - t > REFRESH_MARGIN:
        return rec["access_token"]
    with _Lock(_account_path(d, rec["client_id"]) + ".lock"):
        rec = check_ready(d)                            # another process may have refreshed while we waited
        if rec.get("access_token") and expires_at(rec) - t > REFRESH_MARGIN:
            return rec["access_token"]
        early = rec.get("earliest_refresh_at")
        if rec.get("access_token") and isinstance(early, (int, float)) and t < early and expires_at(rec) > t:
            return rec["access_token"]              # the server said not to refresh yet and the token still works
        return refresh(d, rec, issuer, opener, now)["access_token"]


def logout(d=None, issuer=ISSUER, opener=None, out=None, retries=3, sleep=time.sleep):
    """Revoke the refresh token at OpenAI, then clear the local tokens. Keeps the client id and host id."""
    d = d or auth_dir()
    out = out or (lambda msg: print(msg, file=sys.stderr))
    rec = load_active(d)
    if not rec:
        out("Not signed in.")
        return True
    confirmed = not rec.get("refresh_token")
    if rec.get("refresh_token"):
        doc = discover(issuer, opener)
        for attempt in range(retries):
            try:
                status, _ = _post_form(doc["revocation_endpoint"], {
                    "token": rec["refresh_token"], "token_type_hint": "refresh_token",
                    "client_id": rec["client_id"]}, opener)
            except (urllib.error.URLError, OSError):
                status = None
            if status == 200:
                confirmed = True
                break
            if status is not None and status < 500:
                break
            sleep(2 ** attempt)
    rec = _clear_tokens(rec)
    rec["id_token"] = None
    save_account(d, rec, make_active=False)
    out("Signed out. Local tokens cleared." if confirmed else
        "Signed out locally, but OpenAI did not confirm the revocation. To be sure, disconnect the app in "
        "ChatGPT Settings.")
    return confirmed


# --- inference (Responses API, streaming) ------------------------------------------------------------------------------

def responses_body(model, system, user):
    """The preview limits: store false, stream true, input as an array, system prompt via `instructions`.
    No max_output_tokens / temperature / metadata etc. (unsupported fields in this flow)."""
    return {"model": model, "instructions": system, "input": [{"role": "user", "content": user}],
            "store": False, "stream": True}


ERROR_HELP = {
    "subscription_sharing_user_not_eligible":
        "ChatGPT plan usage is not available for this account, workspace or policy (it needs an eligible "
        f"ChatGPT Plus or Pro plan). Use another provider ({OTHER_PROVIDERS}).",
    "subscription_sharing_usage_limit_exceeded":
        f"your ChatGPT plan's usage limit for this app was reached. See {USAGE_URL}.",
    "subscription_sharing_usage_unavailable": "usage availability could not be checked; try again later.",
    "subscription_sharing_unsupported_capability": "the request used something this flow does not support",
    "subscription_sharing_route_not_supported": "this endpoint is not supported for ChatGPT plan usage.",
    "subscription_sharing_invalid_user": f"the ChatGPT session could not be validated. Run `{LOGIN_COMMAND}`.",
    "chatpass_v2_scope_not_authorized": "the granted permissions do not cover this request.",
    "chatpass_v2_invalid_authorization_context": "the granted permissions do not cover this request.",
    "subscription_sharing_user_unavailable": "account information is temporarily unavailable; try again later.",
}


def _error_for(code, message, param=None, status=None, request_id=None):
    parts = [ERROR_HELP.get(code) or message or "request failed"]
    if code == "subscription_sharing_unsupported_capability" and param:
        parts.append(f"(param: {param})")
    tail = ", ".join(x for x in (f"HTTP {status}" if status else "", code or "", f"request {request_id}"
                                 if request_id else "") if x)
    text = " ".join(parts) + (f" [{tail}]" if tail else "")
    cls = NotEligible if code == "subscription_sharing_user_not_eligible" else ChatGPTError
    return cls(text, code=code)


def http_error(status, headers, body):
    """An error that arrived before the stream opened: a Responses `error` object or a direct-admission `detail`."""
    request_id = headers.get("x-request-id") if headers else None
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        data = {}
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        return _error_for(err.get("code"), err.get("message"), err.get("param"), status, request_id)
    detail = data.get("detail") if isinstance(data, dict) else None
    admission = {401: "the signed identity or plan permission was not accepted; check the selected account "
                      f"(`{LOGIN_COMMAND.replace(' login', ' status')}`).",
                 403: "a policy or permission check (for example the serving region) refused the request.",
                 503: "direct routing is unavailable right now; try again later."}
    msg = admission.get(status, "request failed")
    return ChatGPTError(f"{msg}" + (f" ({str(detail)[:200]})" if detail else "")
                        + f" [HTTP {status}" + (f", request {request_id}" if request_id else "") + "]")


def iter_sse(lines):
    """Server-sent events -> dicts. Handles multi-line data fields and ignores comments and [DONE]."""
    data = []
    for raw in lines:
        line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        line = line.rstrip("\r\n")
        if not line:
            if data:
                joined = "\n".join(data)
                data = []
                if joined.strip() != "[DONE]":
                    yield json.loads(joined)
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if field == "data":
            data.append(value[1:] if value.startswith(" ") else value)
    if data and "\n".join(data).strip() != "[DONE]":
        yield json.loads("\n".join(data))


def read_stream(lines, request_id=None):
    """Consume a Responses stream to its terminal event. Returns (text, model, usage)."""
    text, completed = [], None
    for ev in iter_sse(lines):
        kind = ev.get("type")
        if kind == "response.output_text.delta":
            text.append(ev.get("delta", ""))
        elif kind == "response.completed":
            completed = ev.get("response") or {}
            break
        elif kind == "response.failed":
            err = (ev.get("response") or {}).get("error") or {}
            raise _error_for(err.get("code") or "unknown_error", err.get("message"), err.get("param"),
                             request_id=request_id)
        elif kind == "response.incomplete":
            reason = ((ev.get("response") or {}).get("incomplete_details") or {}).get("reason")
            raise ChatGPTError(f"the response stopped before it finished (response.incomplete: {reason})")
        elif kind == "error":
            err = ev.get("error") if isinstance(ev.get("error"), dict) else ev
            raise _error_for(err.get("code"), err.get("message"), err.get("param"), request_id=request_id)
    if completed is None:
        raise ChatGPTError("the stream ended without response.completed; the answer may be partial, not used")
    joined = "".join(text)
    if not joined:   # no deltas seen: read the final output instead
        joined = "".join(c.get("text", "") for item in completed.get("output", []) or []
                         for c in item.get("content", []) or [] if c.get("type") == "output_text")
    return joined, completed.get("model"), completed.get("usage")


def respond(base, token, model, system, user, opener=None, timeout=600):
    """One streamed Responses request on the user's plan. Returns (text, model, usage)."""
    req = urllib.request.Request(base.rstrip("/") + "/responses", method="POST",
                                 data=json.dumps(responses_body(model, system, user)).encode("utf-8"),
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json",
                                          "accept": "text/event-stream"})
    open_ = opener or urllib.request.urlopen
    try:
        with open_(req, timeout=timeout) as r:
            text, got_model, usage = read_stream(r, r.headers.get("x-request-id"))
    except urllib.error.HTTPError as e:
        raise http_error(e.code, e.headers, e.read() if hasattr(e, "read") else b"") from None
    return text, got_model or model, usage


def list_models(base, token, opener=None):
    """[(slug, display_name)] the selected account may use, server order, visibility == "list" only."""
    req = urllib.request.Request(base.rstrip("/") + "/models", headers={"authorization": f"Bearer {token}"})
    status, headers, body = _http(req, opener, 30)
    if status != 200:
        raise http_error(status, headers, body)
    data = json.loads(body.decode("utf-8"))
    return [(m.get("slug"), m.get("display_name")) for m in data.get("models", []) if m.get("visibility") == "list"]


# --- command line ------------------------------------------------------------------------------------------------------

def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description=f"Continue with ChatGPT for {APP_NAME}: use your ChatGPT Plus/Pro plan "
                                            "instead of an API key (OpenAI's official Sign in with ChatGPT flow).")
    sub = p.add_subparsers(dest="cmd", required=True)
    lg = sub.add_parser("login", help="sign in in your browser")
    lg.add_argument("--new-account", action="store_true", help="register another ChatGPT account or workspace")
    lg.add_argument("--port", type=int, default=DEFAULT_PORT, help="preferred loopback port (default 1455)")
    sub.add_parser("status", help="show the signed-in account (never prints tokens)")
    sub.add_parser("models", help="list model ids your plan can use (for LLM_MODEL)")
    sub.add_parser("logout", help="revoke the session and clear local tokens")
    a = p.parse_args(argv)
    d = auth_dir()
    try:
        if a.cmd == "login":
            login(new_account=a.new_account, d=d, port=a.port)
        elif a.cmd == "status":
            rec = load_active(d)
            if not rec:
                print(f"Not signed in. Run `{LOGIN_COMMAND}`.")
                return 1
            left = int((expires_at(rec) - time.time()) // 60)
            print(f"account: {rec.get('email') or rec.get('subject')}\n"
                  f"plan usage: {'enabled' if PLAN_SCOPE in (rec.get('scopes') or []) else 'not enabled'}\n"
                  f"session: {'active' if rec.get('refresh_token') else 'signed out'}"
                  + (f", access token valid for {left} more minutes" if rec.get('access_token') and left > 0 else "")
                  + f"\nstored in: {d} (mode 0600)\nusage: {USAGE_URL}")
        elif a.cmd == "models":
            token = access_token(d)
            for slug, name in list_models(API_BASE, token):
                print(f"{slug}\t{name or ''}")
        else:
            logout(d)
    except ChatGPTError as e:
        print(f"chatgpt: {e}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, OSError) as e:
        print(f"chatgpt: network error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
