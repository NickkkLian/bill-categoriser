"""chatgpt_mutants.py — break each Continue-with-ChatGPT rule once; the tests must go red every time.

    python tests/chatgpt_mutants.py            (about a minute; runs mutants in parallel)

Each mutant is one small edit to a disposable copy of the repository (the real files are never touched), followed by
the ChatGPT tests in that copy. A mutant is KILLED when the tests fail, SURVIVED when they still pass. A control copy
with no edit must pass first, so a broken test setup cannot make every mutant look killed.
Not collected by the test runners on purpose (the file name does not start with test_).
"""
import concurrent.futures
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.exists(os.path.join(ROOT, "src", "chatgpt_auth.py"))
FILES = {"auth": "src/chatgpt_auth.py" if PKG else "chatgpt_auth.py", "llm": "src/llm.py" if PKG else "llm.py"}
TESTS = ([sys.executable, "-B", "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider",
          "tests/test_chatgpt_auth.py", "tests/test_llm_providers.py"] if PKG else
         [sys.executable, "-B", "-m", "unittest", "tests.test_chatgpt_auth", "tests.test_demo_llm"])

# (rule, file, exact text, replacement). Each text must occur exactly once in the pristine file.
MUTANTS = [
    ("state is validated before the result is used", "auth",
     'if not hmac.compare_digest(cb.get("state", ""), state):', "if False:"),
    ("PKCE challenge is the S256 digest of the verifier", "auth",
     'challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest())',
     'challenge = base64.urlsafe_b64encode(verifier.encode("ascii"))'),
    ("redirect_uri is a 127.0.0.1 loopback, never localhost", "auth",
     'redirect_uri = f"http://127.0.0.1:{srv.server_address[1]}{CALLBACK_PATH}"',
     'redirect_uri = f"http://localhost:{srv.server_address[1]}{CALLBACK_PATH}"'),
    ("the code exchange sends the exact same redirect_uri", "auth",
     '"code_verifier": verifier, "redirect_uri": redirect_uri,',
     '"code_verifier": verifier, "redirect_uri": redirect_uri + "/",'),
    ("ext_agent_host_id is persisted and reused", "auth",
     'if rec and str(rec.get("ext_agent_host_id", "")).startswith("urn:uuid:"):', "if False:"),
    ("a new registration needs an issued client id (never dynamic_agent_client)", "auth",
     "if not returned or returned == DYNAMIC_CLIENT:", "if False:"),
    ("reauth rejects a callback with a different client id", "auth",
     "elif returned and returned != client_id:", "elif False:"),
    ("declined consent (access_denied) stops the attempt", "auth",
     'if cb["error"] == "access_denied":', "if False:"),
    ("ID token signature is verified against the JWKS", "auth",
     'if not rs256_verify(n, e, (h64 + "." + p64).encode("ascii"), sig):', "if False:"),
    ("ID token issuer is checked", "auth", 'if claims.get("iss") != issuer:', "if False:"),
    ("ID token audience is the issued client id", "auth",
     "if not (aud == client_id or (isinstance(aud, list) and client_id in aud)):", "if False:"),
    ("ID token expiry is checked", "auth", 'claims["exp"] < now - CLOCK_SKEW', 'claims["exp"] < now - 10**9'),
    ("ID token nonce is checked", "auth",
     'if not isinstance(claims.get("nonce"), str) or not hmac.compare_digest(claims["nonce"], nonce):', "if False:"),
    ("a returning sign-in must be the same account", "auth",
     'if previous and previous.get("subject") and claims["sub"] != previous["subject"]:', "if False:"),
    ("inference needs the chatgpt.tokens.use.direct grant", "auth",
     'if PLAN_SCOPE not in (rec.get("scopes") or []):\n        raise PlanNotEnabled(f"signed in',
     'if False:\n        raise PlanNotEnabled(f"signed in'),
    ("re-enabling plan usage asks for consent again", "auth", 'params["prompt"] = "consent"', "pass"),
    ("token files are written with mode 0600", "auth", "os.fchmod(fd, 0o600)", "os.fchmod(fd, 0o644)"),
    ("a widened token file is put back to 0600", "auth", "os.chmod(path, 0o600)   # someone widened",
     "pass   # someone widened"),
    ("tokens live under the user's config dir, not in the repo", "auth",
     'os.path.join(os.path.expanduser("~"), ".config", APP_DIR, "chatgpt")',
     'os.path.join(os.path.dirname(os.path.abspath(__file__)), ".chatgpt")'),
    ("no token is printed", "auth",
     "out(f\"Signed in as {record['email'] or record['subject']}. ChatGPT plan usage is enabled.\")",
     "out(f\"Signed in as {record['access_token']}. ChatGPT plan usage is enabled.\")"),
    ("the id_token hint is redacted from the printed link", "auth",
     "out(f\"If no browser opens, visit: {_redact(url) if 'id_token_hint' in params else url}\")",
     "out(f\"If no browser opens, visit: {url}\")"),
    ("refresh uses the issued client id", "auth",
     '"grant_type": "refresh_token", "client_id": rec["client_id"],',
     '"grant_type": "refresh_token", "client_id": DYNAMIC_CLIENT,'),
    ("refresh sends resource and omits scope", "auth",
     '"resource": RESOURCE}, opener)\n    if status == 200 and tok.get("access_token"):',
     '"resource": RESOURCE, "scope": SCOPES}, opener)\n    if status == 200 and tok.get("access_token"):'),
    ("the rotating refresh token is replaced", "auth",
     '"refresh_token": tok.get("refresh_token") or rec["refresh_token"],', '"refresh_token": rec["refresh_token"],'),
    ("an unusable refresh token is cleared", "auth",
     "save_account(d, _clear_tokens(rec), make_active=False)", "save_account(d, rec, make_active=False)"),
    ("a temporary refresh failure keeps the credentials", "auth",
     "if code in UNUSABLE_REFRESH:", "if code in UNUSABLE_REFRESH or status >= 500:"),
    ("refreshes are serialized across processes", "auth",
     'with _Lock(_account_path(d, rec["client_id"]) + ".lock"):', "with open(os.devnull):"),
    ("logout revokes the refresh token", "auth",
     '"token": rec["refresh_token"], "token_type_hint": "refresh_token",',
     '"token": rec["access_token"], "token_type_hint": "refresh_token",'),
    ("logout clears the ID token too", "auth", 'rec["id_token"] = None', "pass"),
    ("Responses requests set store: false", "auth", '"store": False, "stream": True}', '"store": True, "stream": True}'),
    ("Responses requests set stream: true", "auth", '"store": False, "stream": True}',
     '"store": False, "stream": False}'),
    ("no unsupported fields (max_output_tokens) are sent", "auth", '"store": False, "stream": True}',
     '"store": False, "stream": True, "max_output_tokens": 2048}'),
    ("the system prompt goes in instructions, not a system message", "auth",
     'return {"model": model, "instructions": system, "input": [{"role": "user", "content": user}],',
     'return {"model": model, "input": [{"role": "system", "content": system}, {"role": "user", "content": user}],'),
    ("success only on response.completed", "auth",
     '    if completed is None:\n        raise ChatGPTError("the stream ended',
     '    if completed is None:\n        completed = {}\n    if False:\n        raise ChatGPTError("the stream ended'),
    ("response.failed stops with OpenAI's code", "auth", 'elif kind == "response.failed":',
     'elif kind == "response.failed-mutated":'),
    ("a not-eligible account gets the Plus/Pro explanation", "auth",
     'parts = [ERROR_HELP.get(code) or message or "request failed"]', 'parts = [message or "request failed"]'),
    ("the model list keeps visibility == list only", "auth", 'if m.get("visibility") == "list"]', "if True]"),
    ("the plan token is only sent to api.openai.com (or a loopback test mock)", "llm",
     'if base != DEFAULT_BASE["chatgpt"] and not base.startswith("http://127.0.0.1:"):', "if False:"),
    ("the access token travels as the Bearer credential", "llm",
     'headers |= {"authorization": f"Bearer {key}", "accept": "text/event-stream"}',
     'headers |= {"authorization": "Bearer", "accept": "text/event-stream"}'),
    ("other providers never load chatgpt_auth", "llm",
     'PROVIDERS = ("anthropic", "openai", "gemini", "openai-compatible", "chatgpt")',
     'try:\n    from . import chatgpt_auth as _eager\nexcept ImportError:\n    import chatgpt_auth as _eager\n'
     'PROVIDERS = ("anthropic", "openai", "gemini", "openai-compatible", "chatgpt")'),
]


def copy_repo(dest):
    shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns(".git", "__pycache__", ".pytest_cache", "output"))


def run(mutant):
    rule, target, old, new = mutant if mutant else ("control (no mutation)", None, None, None)
    tmp = tempfile.mkdtemp(prefix="chatgpt-mutant-")
    try:
        work = os.path.join(tmp, "repo")
        copy_repo(work)
        if not PKG:   # test_demo_llm builds into output/; give the copy its own
            shutil.copytree(os.path.join(ROOT, "output"), os.path.join(work, "output"))
        if target:
            path = os.path.join(work, FILES[target])
            with open(path, encoding="utf-8") as f:
                text = f.read()
            if text.count(old) != 1:
                return rule, "NOT APPLIED", f"text found {text.count(old)} times in {FILES[target]}"
            with open(path, "w", encoding="utf-8") as f:
                f.write(text.replace(old, new))
        env = {k: v for k, v in os.environ.items() if not k.startswith(("LLM_", "CHATGPT_"))}
        r = subprocess.run(TESTS, cwd=work, capture_output=True, text=True, env=env, timeout=600)
        lines = (r.stdout + r.stderr).splitlines()
        # name what went red: unittest prints "FAIL: test (...)"/"ERROR: ...", pytest -q prints "FAILED path::test"
        red = [ln.strip() for ln in lines if ln.startswith(("FAIL: ", "ERROR: ", "FAILED ", "ERROR "))]
        summary = [ln.strip() for ln in lines if ln.startswith(("Ran ", "OK", "FAILED (")) or " passed" in ln]
        return rule, ("PASSED" if r.returncode == 0 else "FAILED"), (red[0] if red else " ".join(summary[-2:]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    rule, status, tail = run(None)
    print(f"{'control':8} {status:11} {rule} | {tail}", flush=True)
    if status != "PASSED":
        print("the unmutated copy must pass first; stopping")
        return 1
    bad = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as pool:
        for rule, status, tail in pool.map(run, MUTANTS):
            verdict = "KILLED" if status == "FAILED" else ("SURVIVED" if status == "PASSED" else status)
            bad += verdict != "KILLED"
            print(f"{verdict:8} {rule} | {tail}", flush=True)
    print(f"{len(MUTANTS) - bad}/{len(MUTANTS)} mutants killed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
