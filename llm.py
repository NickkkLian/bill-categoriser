"""llm.py — one small, dependency-free way to call four kinds of LLM endpoint.

Providers
  anthropic           Claude, Messages API                         (default)
  openai              OpenAI, Chat Completions API
  gemini              Google Gemini, generateContent API
  openai-compatible   any server that speaks the Chat Completions shape: Ollama, LM Studio, vLLM, most gateways

Configuration (environment variables)
  LLM_PROVIDER   anthropic | openai | gemini | openai-compatible          default: anthropic
  LLM_MODEL      model id. Required for every provider except anthropic   (no guessed defaults for other vendors)
  LLM_BASE_URL   endpoint base. Required for openai-compatible (e.g. http://localhost:11434/v1); optional elsewhere
  API key        ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY | LLM_API_KEY (openai-compatible, optional)

Model-agnostic by design: prompts ask for JSON in plain words, and callers validate the reply themselves
(`extract_json`). No provider-only feature — tool use, JSON mode, response schemas — is a precondition, so a model
that ignores a formatting hint fails validation instead of passing silently. Keys only ever travel in headers,
never in a URL.
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

PROVIDERS = ("anthropic", "openai", "gemini", "openai-compatible")
DEFAULT_MODEL = {"anthropic": "claude-sonnet-5"}
DEFAULT_BASE = {
    "anthropic": "https://api.anthropic.com/v1",
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
}
KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY",
           "openai-compatible": "LLM_API_KEY"}


class ConfigError(ValueError):
    """The environment does not describe a usable endpoint. The message says which variable to set."""


class ProviderError(RuntimeError):
    """The endpoint answered with an error or with a body this adapter cannot read."""


def config_from_env(env=None, default_provider="anthropic"):
    env = os.environ if env is None else env
    provider = (env.get("LLM_PROVIDER") or default_provider).strip().lower()
    if provider not in PROVIDERS:
        raise ConfigError(f"LLM_PROVIDER={provider!r} is not one of {', '.join(PROVIDERS)}")
    model = (env.get("LLM_MODEL") or DEFAULT_MODEL.get(provider) or "").strip()
    if not model:
        raise ConfigError(f"LLM_MODEL is required for {provider} (use a model id from your provider's model list)")
    base = (env.get("LLM_BASE_URL") or DEFAULT_BASE.get(provider) or "").strip().rstrip("/")
    if not base:
        raise ConfigError("LLM_BASE_URL is required for openai-compatible (for Ollama: http://localhost:11434/v1)")
    key = (env.get(KEY_ENV[provider]) or "").strip()
    if not key and provider != "openai-compatible":
        raise ConfigError(f"{KEY_ENV[provider]} is not set")
    return {"provider": provider, "model": model, "base_url": base, "api_key": key}


def build_request(cfg, system, user, max_tokens=2048):
    """Pure: returns (url, headers, body_bytes). No network."""
    p, model, base, key = cfg["provider"], cfg["model"], cfg["base_url"], cfg["api_key"]
    headers = {"content-type": "application/json"}
    if p == "anthropic":
        url = f"{base}/messages"
        headers |= {"x-api-key": key, "anthropic-version": "2023-06-01"}
        body = {"model": model, "max_tokens": max_tokens, "system": system,
                "messages": [{"role": "user", "content": user}]}
    elif p in ("openai", "openai-compatible"):
        url = f"{base}/chat/completions"
        if key:
            headers["authorization"] = f"Bearer {key}"
        body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        # OpenAI's own API deprecated max_tokens (reasoning models reject it); many compatible servers only know
        # max_tokens. Temperature is left at each model's default: several models reject any other value.
        body["max_completion_tokens" if p == "openai" else "max_tokens"] = max_tokens
    elif p == "gemini":
        name = model[len("models/"):] if model.startswith("models/") else model
        url = f"{base}/models/{urllib.parse.quote(name, safe='')}:generateContent"
        headers["x-goog-api-key"] = key
        body = {"systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {"maxOutputTokens": max_tokens}}
    else:
        raise ConfigError(f"unknown provider {p!r}")
    return url, headers, json.dumps(body).encode("utf-8")


def parse_response(cfg, data):
    """Returns (text, model) from a provider's JSON reply, or raises ProviderError."""
    p = cfg["provider"]
    try:
        if p == "anthropic":
            text = "".join(c.get("text", "") for c in data["content"] if c.get("type", "text") == "text")
            model = data.get("model") or cfg["model"]
        elif p in ("openai", "openai-compatible"):
            text = data["choices"][0]["message"]["content"] or ""
            model = data.get("model") or cfg["model"]
        else:
            text = "".join(part.get("text", "") for part in data["candidates"][0]["content"]["parts"])
            model = data.get("modelVersion") or cfg["model"]
    except (KeyError, IndexError, TypeError) as e:
        raise ProviderError(f"{p}: unexpected response shape ({type(e).__name__}: {e})") from None
    return text, model


def complete(cfg, system, user, max_tokens=2048, timeout=60, opener=None):
    """One request, no retries. Returns (text, model). Raises ProviderError on HTTP errors and unreadable bodies."""
    url, headers, body = build_request(cfg, system, user, max_tokens)
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    open_ = opener or urllib.request.urlopen
    try:
        with open_(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300] if hasattr(e, "read") else ""
        raise ProviderError(f"{cfg['provider']}: HTTP {e.code} {detail}".strip()) from None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ProviderError(f"{cfg['provider']}: response was not JSON") from None
    return parse_response(cfg, data)


def extract_json(text, kind="array"):
    """First JSON array (or object) in a model reply, tolerating code fences and prose around it."""
    opener, closer = ("[", "]") if kind == "array" else ("{", "}")
    cleaned = re.sub(r"```(?:json)?", "", text)
    start = cleaned.find(opener)
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(cleaned)):
            ch = cleaned[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(cleaned[start:i + 1])
                    except json.JSONDecodeError:
                        break
        start = cleaned.find(opener, start + 1)
    raise ValueError(f"no JSON {kind} in the model reply")


def describe(cfg):
    """Human-readable, key-free description for logs and caches."""
    base = "" if cfg["base_url"] == DEFAULT_BASE.get(cfg["provider"]) else f" @ {cfg['base_url']}"
    return f"{cfg['provider']} · {cfg['model']}{base}"
