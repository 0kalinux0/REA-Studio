// End-to-end test of the whole pipeline with the offline engine:
// references → REA analysis → selection → plan → build → automated check → refine → export.
// Needs a Chrome-family browser; skipped when none is found.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.MINDFLOW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mindflow-test-'));
const { startServer } = await import('../server/index.mjs');
const { findChrome } = await import('../server/browser.mjs');

function serveDir(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const srv = http.createServer((req, res) => {
    const file = path.join(dir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    fs.readFile(file, (err, data) => (err ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': types[path.extname(file)] || 'text/plain' }).end(data)));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}

test('full pipeline with the offline engine', { skip: findChrome() ? false : 'no Chrome-family browser', timeout: 240_000 }, async (t) => {
  const studio = await startServer({ port: 0 });
  const dash = await serveDir(path.join(here, 'fixtures', 'dashboard-site'));
  const docs = await serveDir(path.join(here, 'fixtures', 'docs-site'));
  t.after(async () => {
    await studio.close();
    dash.srv.close();
    docs.srv.close();
  });
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
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  const project = await api('POST', '/api/projects', { name: 'Orbit Desk', brief: 'Dashboard from one site, top navigation from another, notes from a desktop app.' });
  const pid = project.id;
  const refs = [];
  for (const [label, target] of [['Dashboard site', dash.url], ['Docs site', docs.url], ['Notes desktop app', path.join(here, 'fixtures', 'electron-app')]]) {
    refs.push(await api('POST', `/api/projects/${pid}/references`, { label, target }));
  }
  refs.push(await api('POST', `/api/projects/${pid}/references`, { kind: 'manual', label: 'Wishlist', notes: 'Weekly email digest\nDark mode toggle' }));
  for (const r of refs) await wait((await api('POST', `/api/projects/${pid}/references/${r.id}/analyze`)).jobId);

  let p = await api('GET', `/api/projects/${pid}`);
  const [dashRef, docsRef, appRef, manualRef] = p.references;
  assert.equal(dashRef.status, 'analyzed');
  assert.deepEqual(dashRef.evidence.map((e) => e.operation), ['inspect_web_page', 'analyze_web_bundle', 'capture_web_screenshot']);
  assert.ok(dashRef.evidence.every((e) => /^ev_[0-9a-f]{64}$/.test(e.evidenceId)), 'every evidence record carries a REA evidence id');
  const find = (ref, kind) => ref.elements.find((e) => e.kind === kind);
  assert.deepEqual(find(dashRef, 'table').data.columns, ['Order', 'Customer', 'Status', 'Total']);
  assert.equal(find(dashRef, 'table').status, 'verified');
  assert.equal(find(dashRef, 'palette').status, 'derived');
  assert.equal(find(dashRef, 'color-roles').status, 'probe');
  assert.ok(dashRef.elements.some((e) => e.status === 'inferred'), 'REA inferences are kept separate');
  assert.deepEqual(find(docsRef, 'nav').data.items, ['Guides', 'API', 'Changelog', 'Pricing']);
  assert.ok(appRef.elements.some((e) => e.kind === 'capability' && e.data.group === 'notes'));
  assert.ok(manualRef.elements.every((e) => e.status === 'user'));
  assert.ok(dashRef.gaps.length > 0, 'limitations are recorded');

  // Combine: dashboard widgets + docs navigation + notes capability; drop the dashboard's own nav.
  const selections = {};
  for (const e of dashRef.elements) if (e.kind === 'nav') selections[e.id] = { mode: 'exclude' };
  for (const e of docsRef.elements) if (['color-roles', 'palette', 'typography', 'shape', 'form', 'tabs', 'search'].includes(e.kind) || /Breadcrumb/.test(e.title)) selections[e.id] = { mode: 'exclude' };
  await api('PATCH', `/api/projects/${pid}`, { selections, directives: { appearance: 'Use a teal accent colour', navigation: '', layout: '', functionality: 'Let me archive orders' } });

  p = await api('POST', `/api/projects/${pid}/plan`, { overrides: { appName: 'Orbit Desk' } });
  assert.equal(p.plan.navigation.placement, 'topbar');
  assert.deepEqual(p.plan.navigation.items.map((i) => i.label).slice(0, 4), ['Guides', 'API', 'Changelog', 'Pricing']);
  assert.equal(p.plan.theme.accent, '#0d9488');
  assert.equal(p.plan.theme.background, '#0f172a', 'theme comes from the dashboard reference');
  assert.ok(p.plan.directiveReport.unapplied.some((u) => /archive/.test(u.text)), 'uninterpretable instructions are reported, not dropped');
  assert.ok(p.plan.pages.some((pg) => pg.widgets.some((w) => w.type === 'capability')));

  await assert.rejects(api('POST', `/api/projects/${pid}/build`, { engine: 'scaffold' }), /approve/);
  await api('POST', `/api/projects/${pid}/plan/approve`);
  const built = await wait((await api('POST', `/api/projects/${pid}/build`, { engine: 'scaffold' })).jobId);
  assert.equal(built.version, 1);

  p = await api('GET', `/api/projects/${pid}`);
  const v1 = p.versions[0];
  assert.equal(v1.verify.ok, true, JSON.stringify(v1.verify.problems));
  assert.ok(v1.verify.pages.length >= 4 && v1.verify.pages.every((x) => x.ok));
  assert.equal(v1.verify.coverage.missing.length, 0, JSON.stringify(v1.verify.coverage.missing));
  assert.match(v1.verify.rea.evidenceId, /^ev_/);
  assert.ok(v1.notes.some((n) => /archive/.test(n)), 'build notes say what the offline engine could not do');

  const html = await (await fetch(`${studio.previewOrigin}/${pid}/1/`)).text();
  assert.match(html, /<title>Orbit Desk<\/title>/);
  const files = await api('GET', `/api/projects/${pid}/versions/1/files`);
  for (const f of ['index.html', 'app.js', 'spec.js', 'styles.css', 'README.md', 'PROVENANCE.md', 'package.json', 'server.mjs']) assert.ok(f in files, f);
  assert.match(files['PROVENANCE.md'], /Verified — observed directly by REA/);
  assert.ok(!/Acme|Fernway/.test(files['spec.js'] + files['index.html']), 'reference brand names are not copied into the app');

  // Iterate
  const v2 = await wait((await api('POST', `/api/projects/${pid}/refine`, { engine: 'scaffold', request: 'Make it light. Rename page Pricing to Plans. Add a kanban board' })).jobId);
  assert.equal(v2.version, 2);
  p = await api('GET', `/api/projects/${pid}`);
  assert.equal(p.versions[1].verify.ok, true);
  assert.ok(p.versions[1].changes.some((c) => c.file === 'spec.js' && c.change === 'modified'));
  assert.ok(p.versions[1].notes.some((n) => /Not understood.*kanban/.test(n)));
  assert.ok(p.plan.pages.some((pg) => pg.title === 'Plans'));
  await assert.rejects(api('POST', `/api/projects/${pid}/refine`, { engine: 'scaffold', request: 'Add a kanban board' }), /could not interpret/);
  await assert.rejects(api('POST', `/api/projects/${pid}/build`, { engine: 'ai' }), /API key/);

  // Restore + export
  const v3 = await wait((await api('POST', `/api/projects/${pid}/versions/1/restore`)).jobId);
  assert.equal(v3.version, 3);
  const z = Buffer.from(await (await fetch(`${studio.url}/api/projects/${pid}/versions/3/export`)).arrayBuffer());
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.ok(z.includes(Buffer.from('orbit-desk-v3/index.html')));

  // Guard rails
  assert.equal((await fetch(`${studio.url}/api/projects`, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${studio.previewOrigin}/${pid}/1/..%2f..%2fproject.json`)).status, 403);
});
