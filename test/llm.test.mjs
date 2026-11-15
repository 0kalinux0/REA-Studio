// Tests the Claude build engine against a local stand-in for the Messages API, so the request
// shape, streaming handling and file protocol are exercised without a network call or a key.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const requests = [];
let reply = '';
let stopReason = 'end_turn';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < reply.length; i += 400) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.slice(i, i + 400) } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 50 } });
    send('message_stop', {});
    res.end();
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));

process.env.MINDFLOW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mindflow-llm-'));
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { parseFileProtocol, buildWithClaude, refineWithClaude, hasCredentials } = await import('../server/generate/llm.mjs');
const { buildPlan } = await import('../server/plan.mjs');
test.after(() => fake.close());

const project = {
  id: 'prj_0000000000', name: 'Test App', brief: 'A test', selections: {}, directives: { appearance: 'dark', layout: '', navigation: '', functionality: 'Rows can be archived' },
  references: [{ id: 'ref_0000000000', label: 'Ref A', target: 'https://example.test', elements: [
    { id: 'ref_0000000000:a', refId: 'ref_0000000000', status: 'verified', category: 'feature', kind: 'table', title: 'Data table “Orders”', items: ['Order', 'Total'], data: { name: 'Orders', columns: ['Order', 'Total'] } },
    { id: 'ref_0000000000:b', refId: 'ref_0000000000', status: 'verified', category: 'feature', kind: 'action', title: 'Action button “Secret”', items: [], data: { label: 'Secret' } },
  ] }],
};
project.selections['ref_0000000000:b'] = { mode: 'exclude', note: '' };

test('file protocol parser', () => {
  const r = parseFileProtocol('chat\n=== FILE: index.html ===\n<p>hi</p>\n=== END FILE ===\n=== FILE: ../evil.js ===\nx\n=== END FILE ===\n=== FILE: README.md ===\nx\n=== END FILE ===\n=== FILE: js/app.js ===\nconst a = "=== not a marker";\n=== END FILE ===\n=== DELETE: old.css ===\n=== NOTES ===\nDone.');
  assert.deepEqual(Object.keys(r.files), ['index.html', 'js/app.js']);
  assert.equal(r.files['index.html'], '<p>hi</p>\n');
  assert.deepEqual(r.deletes, ['old.css']);
  assert.deepEqual(r.rejected, ['../evil.js', 'README.md']);
  assert.equal(r.notes, 'Done.');
});

test('build sends the plan with provenance and parses the streamed app', async () => {
  assert.equal(hasCredentials(), true);
  const plan = buildPlan(project);
  reply = '=== FILE: index.html ===\n<!doctype html><title>Test App</title><main><h1>Orders</h1></main>\n=== END FILE ===\n=== FILE: app.js ===\nconsole.log(1);\n=== END FILE ===\n=== NOTES ===\nBuilt the orders table.';
  const progress = [];
  const out = await buildWithClaude(project, plan, (m) => progress.push(m));
  assert.deepEqual(Object.keys(out.files).sort(), ['app.js', 'index.html']);
  assert.deepEqual(out.notes, ['Built the orders table.']);
  assert.ok(progress.some((m) => /writing app\.js/.test(m)));

  const req = requests.at(-1);
  assert.match(req.url, /^\/v1\/messages/);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.fallbacks, 'default');
  assert.deepEqual(req.body.thinking, { type: 'adaptive' });
  assert.equal(req.body.output_config.effort, 'high');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  const text = req.body.messages[0].content.map((b) => b.text ?? '').join('\n');
  assert.match(text, /\[verified\] \(Ref A\) Data table “Orders”/);
  assert.match(text, /functionality: Rows can be archived/);
  assert.match(text, /EXPLICITLY EXCLUDED.*Secret/);
  assert.match(req.body.system, /Original work only/);
});

test('refine merges changed files, applies deletes, and surfaces refusals and empty replies', async () => {
  const plan = buildPlan(project);
  const current = { 'index.html': 'old\n', 'app.js': 'old\n', 'extra.css': 'x\n', 'README.md': 'studio file\n' };
  reply = '=== FILE: app.js ===\nnew\n=== END FILE ===\n=== DELETE: extra.css ===\n=== NOTES ===\nChanged app.js.';
  const out = await refineWithClaude(project, plan, current, 'Make it faster', { problems: [{ kind: 'exception', text: 'boom' }] }, () => {});
  assert.equal(out.files['app.js'], 'new\n');
  assert.equal(out.files['index.html'], 'old\n');
  assert.ok(!('extra.css' in out.files));
  const sent = requests.at(-1).body.messages[0].content.map((b) => b.text).join('\n');
  assert.match(sent, /Make it faster/);
  assert.match(sent, /exception: boom/);
  assert.ok(!sent.includes('studio file'), 'studio-owned files are not sent for editing');

  reply = '=== NOTES ===\nI need to know which table you mean.';
  await assert.rejects(refineWithClaude(project, plan, current, 'x', null, () => {}), /which table/);

  reply = '';
  stopReason = 'refusal';
  await assert.rejects(buildWithClaude(project, plan, () => {}), /declined/);
  stopReason = 'end_turn';
});

test('a Claude build goes through the server: version saved, packaged and checked', { timeout: 120_000 }, async (t) => {
  const { startServer } = await import('../server/index.mjs');
  const { findChrome } = await import('../server/browser.mjs');
  if (!findChrome()) return t.skip('no Chrome-family browser');
  const studio = await startServer({ port: 0 });
  t.after(() => studio.close());
  const api = async (method, p, body) => {
    const r = await fetch(studio.url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json();
    assert.ok(r.ok, `${method} ${p} → ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  const wait = async (jobId) => {
    for (;;) {
      const j = await api('GET', `/api/jobs/${jobId}`);
      if (j.status === 'done') return j.result;
      if (j.status === 'error') assert.fail(j.error);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const p = await api('POST', '/api/projects', { name: 'Tasks', brief: 'A task list' });
  const ref = await api('POST', `/api/projects/${p.id}/references`, { kind: 'manual', label: 'Wishes', notes: 'Add tasks\nMark tasks done' });
  await wait((await api('POST', `/api/projects/${p.id}/references/${ref.id}/analyze`)).jobId);
  await api('POST', `/api/projects/${p.id}/plan`, {});
  await api('POST', `/api/projects/${p.id}/plan/approve`);

  reply = `=== FILE: index.html ===
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tasks</title><link rel="icon" href="data:,"></head>
<body><nav aria-label="Main"><a href="#/home">Home</a></nav><main><h1>Tasks</h1><form id="f"><label>Task <input name="t" required></label><button>Add</button></form><ul id="list"></ul></main>
<script type="module" src="app.js"></script></body></html>
=== END FILE ===
=== FILE: app.js ===
const list = document.querySelector('#list');
document.querySelector('#f').addEventListener('submit', (e) => { e.preventDefault(); const li = document.createElement('li'); li.textContent = new FormData(e.target).get('t'); list.append(li); e.target.reset(); });
=== END FILE ===
=== NOTES ===
Built a task list. Marking tasks done is not implemented yet.`;
  const built = await wait((await api('POST', `/api/projects/${p.id}/build`, { engine: 'ai' })).jobId);
  const project = await api('GET', `/api/projects/${p.id}`);
  const v = project.versions.find((x) => x.n === built.version);
  assert.equal(v.engine, 'ai');
  assert.equal(v.model, 'claude-opus-5-5');
  assert.match(v.notes[0], /not implemented yet/);
  assert.equal(v.verify.ok, true, JSON.stringify(v.verify.problems));
  assert.match(v.verify.rea.evidenceId, /^ev_/);
  const files = await api('GET', `/api/projects/${p.id}/versions/${v.n}/files`);
  assert.ok(files['README.md'] && files['PROVENANCE.md'] && files['server.mjs'] && files['package.json']);
  assert.match(files['PROVENANCE.md'], /Described by you — nothing was inspected/);
  assert.match(files['PROVENANCE.md'], /Marking tasks done is not implemented yet/);
});
