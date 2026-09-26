/* llm.js — the browser twin of ../llm.py: one small, dependency-free way to call four kinds of LLM endpoint.
   Loaded as a classic <script> (window.LLM) and with require() in node (check-llm.mjs).

   Providers: anthropic (default) · openai · gemini · openai-compatible (Ollama, LM Studio, vLLM, most gateways).
   Model-agnostic: prompts ask for JSON in plain words and callers validate the reply (extractJson). No provider-only
   feature is a precondition. Keys travel in headers only, never in a URL, and are never stored by this file. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LLM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PROVIDERS = ['anthropic', 'openai', 'gemini', 'openai-compatible'];
  const LABEL = { anthropic: 'Claude (Anthropic)', openai: 'OpenAI', gemini: 'Google Gemini', 'openai-compatible': 'OpenAI-compatible endpoint' };
  const DEFAULT_MODEL = { anthropic: 'claude-sonnet-5' };
  const DEFAULT_BASE = { anthropic: 'https://api.anthropic.com/v1', openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta' };

  class ConfigError extends Error {}
  class ProviderError extends Error {}

  function config({ provider = 'anthropic', model = '', baseUrl = '', apiKey = '' } = {}) {
    provider = String(provider).trim().toLowerCase();
    if (!PROVIDERS.includes(provider)) throw new ConfigError(`provider "${provider}" is not one of ${PROVIDERS.join(', ')}`);
    model = String(model || DEFAULT_MODEL[provider] || '').trim();
    if (!model) throw new ConfigError(`a model id is required for ${LABEL[provider]} (use one from your provider's model list)`);
    baseUrl = String(baseUrl || DEFAULT_BASE[provider] || '').trim().replace(/\/+$/, '');
    if (!baseUrl) throw new ConfigError('a base URL is required for an OpenAI-compatible endpoint (for Ollama: http://localhost:11434/v1)');
    apiKey = String(apiKey || '').trim();
    if (!apiKey && provider !== 'openai-compatible') throw new ConfigError(`an API key is required for ${LABEL[provider]}`);
    return { provider, model, baseUrl, apiKey };
  }

  function buildRequest(cfg, system, user, maxTokens = 2048, { browser = false } = {}) {
    const { provider: p, model, baseUrl: base, apiKey: key } = cfg;
    const headers = { 'content-type': 'application/json' };
    let url, body;
    if (p === 'anthropic') {
      url = `${base}/messages`;
      Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      if (browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';   // Anthropic requires it for calls from a page
      body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
    } else if (p === 'openai' || p === 'openai-compatible') {
      url = `${base}/chat/completions`;
      if (key) headers.authorization = `Bearer ${key}`;
      body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
      // OpenAI deprecated max_tokens (reasoning models reject it); many compatible servers only know max_tokens.
      // Temperature stays at each model's default: several models reject any other value.
      body[p === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    } else {
      const name = model.startsWith('models/') ? model.slice(7) : model;
      url = `${base}/models/${encodeURIComponent(name)}:generateContent`;
      headers['x-goog-api-key'] = key;
      body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens } };
    }
    return { url, headers, body: JSON.stringify(body) };
  }

  function parseResponse(cfg, data) {
    try {
      if (cfg.provider === 'anthropic') return { text: data.content.filter(c => (c.type || 'text') === 'text').map(c => c.text || '').join(''), model: data.model || cfg.model };
      if (cfg.provider === 'gemini') return { text: data.candidates[0].content.parts.map(x => x.text || '').join(''), model: data.modelVersion || cfg.model };
      return { text: data.choices[0].message.content || '', model: data.model || cfg.model };
    } catch (e) {
      throw new ProviderError(`${cfg.provider}: unexpected response shape (${e.message})`);
    }
  }

  async function complete(cfg, system, user, { maxTokens = 2048, fetchImpl, browser = typeof window !== 'undefined', timeoutMs = 60000 } = {}) {
    const req = buildRequest(cfg, system, user, maxTokens, { browser });
    const f = fetchImpl || fetch;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try { res = await f(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: ctl ? ctl.signal : undefined }); }
    catch (e) { throw new ProviderError(`${cfg.provider}: network error (${e.name === 'AbortError' ? 'timed out' : e.message}) — offline, blocked by CORS, or the endpoint is down`); }
    finally { if (timer) clearTimeout(timer); }
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw.slice(0, 300);
      try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error)) || detail; } catch (e) {}
      throw new ProviderError(`${cfg.provider}: HTTP ${res.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.trim());
    }
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new ProviderError(`${cfg.provider}: response was not JSON`); }
    return parseResponse(cfg, data);
  }

  function extractJson(text, kind = 'array') {
    const [open, close] = kind === 'array' ? ['[', ']'] : ['{', '}'];
    const s = String(text).replace(/```(?:json)?/g, '');
    let start = s.indexOf(open);
    while (start !== -1) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close && --depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { break; }
        }
      }
      start = s.indexOf(open, start + 1);
    }
    throw new Error(`no JSON ${kind} in the model reply`);
  }

  // The settings after the provider is changed: that provider's default model, no base URL and no key. The key is
  // dropped on purpose, so a key typed for one provider is never sent to the next one's endpoint (an OpenAI key to an
  // OpenAI-compatible address run by someone else, say).
  function switchProvider(provider) {
    return { provider, model: DEFAULT_MODEL[provider] || '', baseUrl: '', apiKey: null };
  }

  function describe(cfg) {
    return `${LABEL[cfg.provider]} · ${cfg.model}${cfg.baseUrl === DEFAULT_BASE[cfg.provider] ? '' : ' @ ' + cfg.baseUrl}`;
  }

  return { PROVIDERS, LABEL, DEFAULT_MODEL, DEFAULT_BASE, ConfigError, ProviderError, config, switchProvider, buildRequest, parseResponse, complete, extractJson, describe };
});
