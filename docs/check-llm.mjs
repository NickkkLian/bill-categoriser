// check-llm.mjs — docs/llm.js against a local mock of each provider's documented request/response shape (Node 18+).
// Same contract as tests/test_llm.py for the Python twin. Proves request shape and reply parsing, not live service
// acceptance — the README compatibility table says which combinations were actually run.
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const LLM = require('./llm.js');

const REPLY = '[{"merchant":"Northwind Paper","category":"Supplies","confidence":0.9,"reason":"paper"}]';
let seen = null;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    seen = { path: req.url, headers: req.headers, body: body ? JSON.parse(body) : {} };
    const send = (code, obj) => { const raw = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json' }); res.end(raw); };
    if (req.url.startsWith('/fail')) return send(401, { error: { message: 'invalid key' } });
    if (req.url.startsWith('/garbage')) { res.writeHead(200); return res.end('<html>'); }
    if (req.url.endsWith('/messages')) return send(200, { model: 'claude-test-1', content: [{ type: 'text', text: REPLY }] });
    if (req.url.endsWith('/chat/completions')) return send(200, { model: 'gpt-test-1', choices: [{ message: { content: 'Here:\n```json\n' + REPLY + '\n```' } }] });
    if (req.url.includes(':generateContent')) return send(200, { modelVersion: 'gemini-test-1', candidates: [{ content: { parts: [{ text: REPLY.slice(0, 20) }, { text: REPLY.slice(20) }] } }] });
    send(404, { error: 'no route' });
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

console.log('providers against the mock');
let c = LLM.config({ provider: 'anthropic', baseUrl: base, apiKey: 'sk-ant-test' });
let r = await LLM.complete(c, 'SYS', 'USER', { maxTokens: 321, browser: true });
ok(seen.path === '/messages' && seen.headers['x-api-key'] === 'sk-ant-test' && seen.headers['anthropic-version'] === '2023-06-01', 'anthropic: /messages with x-api-key and anthropic-version');
ok(seen.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'anthropic from a page: sends the browser-access header Anthropic requires');
ok(eq(seen.body, { model: 'claude-sonnet-5', max_tokens: 321, system: 'SYS', messages: [{ role: 'user', content: 'USER' }] }), 'anthropic: body is model, max_tokens, system, messages');
ok(r.model === 'claude-test-1' && LLM.extractJson(r.text)[0].category === 'Supplies', 'anthropic: reply text and model read');

c = LLM.config({ provider: 'openai', baseUrl: base, apiKey: 'sk-oa-test', model: 'some-openai-model' });
r = await LLM.complete(c, 'SYS', 'USER', { maxTokens: 222 });
ok(seen.path === '/chat/completions' && seen.headers.authorization === 'Bearer sk-oa-test', 'openai: /chat/completions with a bearer key');
ok(seen.body.max_completion_tokens === 222 && !('max_tokens' in seen.body) && !('temperature' in seen.body), 'openai: max_completion_tokens, no max_tokens, no temperature');
ok(eq(seen.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]), 'openai: system and user messages');
ok(r.model === 'gpt-test-1' && LLM.extractJson(r.text)[0].merchant === 'Northwind Paper', 'openai: fenced JSON reply extracted');

c = LLM.config({ provider: 'gemini', baseUrl: base, apiKey: 'AIza-test', model: 'models/gemini-some-model' });
r = await LLM.complete(c, 'SYS', 'USER', { maxTokens: 111 });
ok(seen.path === '/models/gemini-some-model:generateContent' && !seen.path.includes('AIza') && seen.headers['x-goog-api-key'] === 'AIza-test', 'gemini: generateContent path, key in x-goog-api-key, not in the URL');
ok(eq(seen.body, { systemInstruction: { parts: [{ text: 'SYS' }] }, contents: [{ role: 'user', parts: [{ text: 'USER' }] }], generationConfig: { maxOutputTokens: 111 } }), 'gemini: systemInstruction, contents, generationConfig.maxOutputTokens');
ok(r.text === REPLY && r.model === 'gemini-test-1', 'gemini: parts joined, modelVersion read');

c = LLM.config({ provider: 'openai-compatible', baseUrl: base, model: 'llama-local' });
await LLM.complete(c, 'SYS', 'USER', { maxTokens: 99 });
ok(!('authorization' in seen.headers) && seen.body.max_tokens === 99 && !('max_completion_tokens' in seen.body), 'openai-compatible: no key → no Authorization; max_tokens');
ok(!('anthropic-dangerous-direct-browser-access' in seen.headers), 'the Anthropic browser header is only sent to Anthropic');

console.log('errors');
ok(await throwsWith(() => LLM.complete(LLM.config({ provider: 'anthropic', baseUrl: base + '/fail', apiKey: 'bad' }), 's', 'u'), /HTTP 401 invalid key/), 'HTTP error surfaces status and the provider message');
ok(await throwsWith(() => LLM.complete(LLM.config({ provider: 'anthropic', baseUrl: base + '/garbage', apiKey: 'k' }), 's', 'u'), /not JSON/), 'non-JSON reply is an error');
ok(await throwsWith(() => LLM.complete(LLM.config({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', model: 'm' }), 's', 'u'), /network error/), 'unreachable endpoint is a named network error');
ok(await throwsWith(async () => LLM.parseResponse({ provider: 'openai', model: 'm' }, { choices: [] }), /unexpected response shape/), 'unexpected shape is an error, not an empty answer');

console.log('configuration');
ok(eq((({ provider, model, baseUrl }) => ({ provider, model, baseUrl }))(LLM.config({ apiKey: 'k' })), { provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: 'https://api.anthropic.com/v1' }), 'defaults to Claude');
for (const [opts, re] of [[{}, /API key/], [{ provider: 'openai', apiKey: 'k' }, /model id is required/], [{ provider: 'openai-compatible', model: 'm' }, /base URL is required/], [{ provider: 'mistral' }, /not one of/]])
  ok(await throwsWith(async () => LLM.config(opts), re), `config error names what to set: ${JSON.stringify(opts)}`);
for (const p of LLM.PROVIDERS) {
  const cfg = LLM.config({ provider: p, model: 'm', baseUrl: 'http://h/v1', apiKey: 'SECRET-' + p });
  const req = LLM.buildRequest(cfg, 's', 'u', 10, { browser: true });
  ok(!req.url.includes('SECRET') && JSON.stringify(req.headers).includes('SECRET-' + p) && !LLM.describe(cfg).includes('SECRET'), `${p}: key only in headers, never in the URL or the description`);
}

console.log('changing provider');
for (const p of LLM.PROVIDERS) {
  const n = LLM.switchProvider(p);
  ok(n.provider === p && n.apiKey === null && n.baseUrl === '' && n.model === (LLM.DEFAULT_MODEL[p] || ''), `switching to ${p} drops the key and the base URL`);
}
// the page's provider menu goes through switchProvider and puts its empty key where the key field reads from
const APP = require('node:fs').readFileSync(new URL('./app.js', import.meta.url), 'utf8');
ok(/'aria-label': 'Model provider', onchange: e => \{ const n = LLM\.switchProvider\(e\.target\.value\);[^}]*\bS\.apiKey = n\.apiKey;[^}]*render\(\); \}/.test(APP)
  && /'aria-label': 'API key', value: S\.apiKey \|\| ''/.test(APP), 'app.js: changing the provider empties the key field (S.apiKey)');

console.log('JSON extraction');
ok(eq(LLM.extractJson('Here you go:\n```json\n[{"a": "b]"}]\n```'), [{ a: 'b]' }]), 'code fence and a bracket inside a string');
ok(eq(LLM.extractJson('see [note] then [{"m": "say \\"hi\\" ]"}]'), [{ m: 'say "hi" ]' }]), 'skips a non-JSON bracket, handles escaped quotes');
ok(eq(LLM.extractJson('[{"m": "a \\" ] b"}]'), [{ m: 'a " ] b' }]), 'an escaped quote followed by a bracket does not end the array');
ok(await throwsWith(async () => LLM.extractJson('I cannot help with that.'), /no JSON array/), 'no JSON raises');

srv.close();
console.log(`\n${fail ? 'FAIL' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
