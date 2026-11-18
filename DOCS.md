# Bill Bench: details

## Rules file validation

An explicitly supplied conflicting threshold is rejected before writing output. Invalid categories, malformed thresholds, empty normalised aliases and duplicate normalised aliases are also rejected rather than silently skipped.

## The nineteen

On the 30-name evaluation set (`python3 -B demo.py eval`), the cached `claude-sonnet-5` run scored 30 of 30 and the keyword baseline 19 of 30.

The nineteen is worth breaking down, because the round number is misleading. The baseline gets 19 of the 20 keyword names and 0 of the 10 inference names — it is not that the inference names account for the whole gap. The one keyword name it misses is `Summit Plaza Leasing`: the rule for rent looks for `lease`, and the name says `Leasing`. That is the ordinary failure of a keyword list; the eval prints this split. Read the whole comparison as what this set was built to show — thirty synthetic names cannot say how much better a model is in general. Without the cache the eval reports **NOT RUN** (exit code 2).

## The optional LLM step

`python3 -B demo.py build --llm` asks a model about each `Uncategorised` merchant and writes `output/llm-suggestions.json` with `category / confidence / reason`; answers are cached in `docs/llm-cache.json` with the provider, model and date, keyed by normalised merchant name, so later builds and the browser page work offline. Since that cache ships with the repository, running the command below on the delivered dataset sends nothing and needs no key — the line it prints says whether the answers were asked of the model or read from the cache, so the two are never confused. The ledger and workbook never change: the step is advisory by design, and `check` asserts that. Any failure — no key, no model id, timeout, malformed reply, a category outside the allowed set — falls back to `Uncategorised` without stopping the build.

The delivered `output/llm-suggestions.json` is that step's real output on this dataset, from the same 2026-09-22 run: the seed-42 demo leaves 20 rows uncategorised under two merchant names, `=SYNTHETIC_FORMULA_TEXT()` and `Demo Other 06`, and the model returned no category for either — a formula string and a placeholder are not merchants. The step is allowed to decline.

The model is your choice. Claude is the default, not a requirement:

```sh
ANTHROPIC_API_KEY=... python3 -B demo.py build --llm                                    # Claude, claude-sonnet-5-5
LLM_PROVIDER=openai OPENAI_API_KEY=... LLM_MODEL=your-model-id python3 -B demo.py build --llm
LLM_PROVIDER=gemini GEMINI_API_KEY=... LLM_MODEL=your-model-id python3 -B demo.py build --llm
LLM_PROVIDER=openai-compatible LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=your-model-id python3 -B demo.py build --llm   # Ollama, LM Studio, vLLM…
LLM_PROVIDER=chatgpt LLM_MODEL=your-model-id python3 -B demo.py build --llm             # your ChatGPT plan (not yet tried live), see below
```

Only Claude has a default model id, `claude-sonnet-5-5`, and it can be changed like any other; for the others you name one from your provider's list, so nothing here goes stale when a vendor renames its models. Sonnet 5.5 thinks on every request and the thinking counts toward the output limit, so Claude requests get `max_tokens` 16000; the other providers keep 2048. A Claude reply that stops with `refusal` or `max_tokens` is reported as that, not parsed as half an answer. `llm.py` (CLI) and `docs/llm.js` (browser) are the same small adapter in two languages, with no SDKs. They use nothing provider-specific as a precondition — no tool calling, JSON mode or response schemas. The prompt asks for a JSON array in plain words, and the parser keeps only well-formed entries whose category is in the allowed set, so a model that ignores the instruction produces no suggestions rather than wrong ones. Keys are sent in headers only, never in a URL, and never written to disk or browser storage.

| Provider | How to select it | What has been run |
|---|---|---|
| Claude (Anthropic) | default · `ANTHROPIC_API_KEY` | Request and reply format checked against a local mock of the documented API: end to end from the CLI (`tests/test_demo_llm.py`) and through the page's own adapter `docs/llm.js` in Node (`node docs/check-llm.mjs`, including the header Anthropic requires for calls from a page). **Run against the live API**, 2026-09-22 with `claude-sonnet-5`: 30 of 30 on the evaluation set. `docs/llm-cache.json` is what those runs produced — the 30 evaluation names in batches of twelve, plus a separate `build --llm` for the two the demo leaves uncategorised. |
| OpenAI | `LLM_PROVIDER=openai` · `OPENAI_API_KEY` · `LLM_MODEL` | Format checked against a local mock, from the CLI and through `docs/llm.js` (sends `max_completion_tokens`, no `temperature`). Should work per OpenAI's documentation; **not run against the live API.** |
| Google Gemini | `LLM_PROVIDER=gemini` · `GEMINI_API_KEY` · `LLM_MODEL` | Format checked against a local mock, from the CLI and through `docs/llm.js` (key in the `x-goog-api-key` header). Should work per Google's documentation; **not run against the live API.** |
| OpenAI-compatible | `LLM_PROVIDER=openai-compatible` · `LLM_BASE_URL` · `LLM_MODEL` · optional `LLM_API_KEY` | Format checked against a local mock, from the CLI and through `docs/llm.js` (no key, no `Authorization` header). **Not run against a real Ollama, LM Studio or vLLM server.** A server called from the page must allow its origin (Ollama: `OLLAMA_ORIGINS`). |
| ChatGPT plan (Continue with ChatGPT) | `LLM_PROVIDER=chatgpt` · `LLM_MODEL` · one-time `python3 chatgpt_auth.py login` | Sign-in, refresh, sign-out and the Responses stream checked against a local mock of OpenAI's documented flow, with the ID token signed by a real RSA key (`tests/test_chatgpt_auth.py`), plus `demo.py build --llm` end to end; `tests/chatgpt_mutants.py` breaks each of 40 rules once and the tests catch every one. CLI only. **Not yet signed in against the live service.** |

```sh
python3 -m unittest discover -s tests -v     # adapter against a mock of each provider; demo.py build --llm end to end per provider
python3 -B tests/chatgpt_mutants.py           # Continue with ChatGPT: break each rule in a disposable copy, expect red
node docs/check-llm.mjs                       # the browser adapter, same contract
```

## Continue with ChatGPT (your ChatGPT plan, no API key)

**Status: not yet tried with a real sign-in.** The flow is built from OpenAI's documentation and tested against a local mock of it, so everything below describes what the documentation says should happen.

This provider is meant to run the model step on a ChatGPT Plus or Pro plan instead of an API key. It follows OpenAI's official **Sign in with ChatGPT** flow for open-source, locally hosted apps ([OpenAI's documentation](https://developers.openai.com/siwc/token-sharing-open-source)); no unofficial endpoint and no scraped session is involved.

```sh
python3 chatgpt_auth.py login        # opens your browser: sign in to ChatGPT and allow the app to use your plan
python3 chatgpt_auth.py models       # the model ids your plan can use
LLM_PROVIDER=chatgpt LLM_MODEL=a-model-id-from-that-list python3 -B demo.py build --llm
python3 chatgpt_auth.py status       # who is signed in and whether plan usage is on (never prints a token)
python3 chatgpt_auth.py logout       # revokes the session at OpenAI, then clears the local tokens
```

**What it needs** (per OpenAI's documentation). An eligible ChatGPT Plus or Pro plan. Other accounts can sign in, but OpenAI answers their requests with `subscription_sharing_user_not_eligible`; that error is shown as it came, with the other providers named. Nothing switches to another provider or to an API key on its own. On Plus, the five-hour usage limit is shared with every other app that uses your plan; usage and per-app limits are at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).

**Preview limits** ([OpenAI's list](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)). Responses API only; every request is sent with `store: false` and `stream: true`; fields such as `max_output_tokens` and `temperature` are not accepted, so this provider sends neither (the 16000 and 2048 output budgets above do not apply to it).

**How it is built.** The first `login` registers "Bill Bench" as an agent on your ChatGPT account (`client_id=dynamic_agent_client`, a browser callback on `http://127.0.0.1:1455/auth/callback` or another free port, PKCE, no client secret); later sign-ins reuse the client id OpenAI issued. The ID token is checked against OpenAI's published keys (RS256 signature, issuer, audience, expiry, nonce), and plan usage counts as on only when OpenAI grants `chatgpt.tokens.use.direct`. The signature check uses the standard library, because this project has no third-party dependencies; OpenAI's guide suggests a maintained JWT library where one can be used. Tokens are stored in `~/.config/bill-bench/chatgpt/` (or `CHATGPT_AUTH_DIR`), one file per account, written atomically with mode 0600; never in this repository, never printed or logged. The access token is refreshed about five minutes before it expires, and the rotating refresh token is replaced at the same time.

The browser page does not offer this provider: the sign-in needs a local callback listener, which a static page cannot run.
