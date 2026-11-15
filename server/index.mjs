// REA Studio server: JSON API + GUI on one loopback port, generated-app previews on the
// next port (a separate origin, so generated code can never call the studio API).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.mjs';
import { analyzeReference, classifyTarget } from './analyze.mjs';
import { buildPlan } from './plan.mjs';
import { buildScaffold, refineOffline } from './generate/scaffold.mjs';
import { buildWithClaude, refineWithClaude, reviewPlanWithClaude, hasCredentials, explainError } from './generate/llm.mjs';
import { packageFiles } from './generate/package.mjs';
import { verifyVersion } from './verify.mjs';
import { capabilities } from './capabilities.mjs';
import { stopBrowser } from './browser.mjs';
import { zip } from './zip.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- jobs ----------
const jobs = new Map();
function startJob(projectId, kind, fn) {
  const busy = [...jobs.values()].find((j) => j.projectId === projectId && j.status === 'running' && j.kind === kind);
  if (busy) throw httpError(409, 'That is already running for this project.');
  const job = { id: store.newId('job'), projectId, kind, status: 'running', messages: [], result: null, error: null, startedAt: Date.now() };
  jobs.set(job.id, job);
  const progress = (m) => job.messages.push({ at: Date.now(), text: m });
  Promise.resolve()
    .then(() => fn(progress))
    .then((result) => Object.assign(job, { status: 'done', result: result ?? null }))
    .catch((e) => {
      console.error(`[job ${kind}]`, e);
      Object.assign(job, { status: 'error', error: explainError(e) });
    })
    .finally(() => setTimeout(() => jobs.delete(job.id), 15 * 60_000).unref());
  return { jobId: job.id };
}

// ---------- build pipeline ----------
let previewOrigin = '';

function engineLabel(engine) {
  return engine === 'ai' ? 'Claude' : 'offline scaffold';
}

async function commitVersion(projectId, { files, engine, kind, request, notes, model }, progress) {
  const version = await store.updateProject(projectId, async (project) => {
    const n = Math.max(0, ...project.versions.map((v) => v.n)) + 1;
    const packaged = packageFiles(files, project, project.plan, { engine: engineLabel(engine), notes });
    let previous = {};
    const prev = project.versions.at(-1);
    if (prev) previous = await store.readVersionFiles(projectId, prev.n).catch(() => ({}));
    await store.writeVersionFiles(projectId, n, packaged);
    const v = { n, createdAt: new Date().toISOString(), engine, model: model ?? null, kind, request: request ?? null, notes, basedOn: prev?.n ?? null, changes: store.diffFiles(previous, packaged).filter((c) => c.file !== 'PROVENANCE.md' || !prev), fileCount: Object.keys(packaged).length, verify: null };
    project.versions.push(v);
    store.logActivity(project, kind, `Version ${n} created with the ${engineLabel(engine)} engine${request ? `: “${request.slice(0, 80)}”` : ''}`);
    return v;
  });
  progress(`Version ${version.n} saved. Running automated checks`);
  await runVerify(projectId, version.n, progress);
  return { version: version.n };
}

async function runVerify(projectId, n, progress) {
  const project = await store.loadProject(projectId);
  let report;
  try {
    report = await verifyVersion(project, n, previewOrigin, progress);
  } catch (e) {
    report = { checkedAt: new Date().toISOString(), ok: false, problems: [{ kind: 'check', text: `The automated check could not run: ${e.message}` }], pages: [], coverage: null, rea: null, screenshot: null, skipped: true };
  }
  await store.updateProject(projectId, (p) => {
    const v = p.versions.find((x) => x.n === n);
    if (v) v.verify = report;
  });
  return report;
}

function requireEngine(engine) {
  if (engine !== 'ai' && engine !== 'scaffold') throw httpError(400, 'Unknown build engine.');
  if (engine === 'ai' && !hasCredentials()) throw httpError(400, 'The Claude engine needs an Anthropic API key. Add one in Settings, or use the offline scaffold engine.');
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/api/capabilities', async (_r, { query }) => capabilities(query.get('refresh') === '1'));
route('GET', '/api/info', async () => ({ previewOrigin, dataDir: store.DATA_DIR }));
route('GET', '/api/settings', async () => store.publicSettings());
route('POST', '/api/settings', async (_r, { body }) => {
  const patch = {};
  if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
  if (typeof body.model === 'string' && /^[a-z0-9.\-]{3,60}$/.test(body.model)) patch.model = body.model;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort)) patch.effort = body.effort;
  if (typeof body.headless === 'boolean') patch.headless = body.headless;
  if (typeof body.styleProbe === 'boolean') patch.styleProbe = body.styleProbe;
  await store.saveSettings(patch);
  if ('headless' in patch) await stopBrowser();
  return store.publicSettings();
});
route('POST', '/api/classify', async (_r, { body }) => classifyTarget(body.target));

route('GET', '/api/projects', async () => store.listProjects());
route('POST', '/api/projects', async (_r, { body }) => store.createProject(body));
route('GET', '/api/projects/:id', async (_r, { params }) => store.loadProject(params.id));
route('DELETE', '/api/projects/:id', async (_r, { params }) => (await store.deleteProject(params.id), { ok: true }));
route('PATCH', '/api/projects/:id', async (_r, { params, body }) =>
  store.updateProject(params.id, (p) => {
    if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim().slice(0, 120);
    if (typeof body.brief === 'string') p.brief = body.brief.slice(0, 4000);
    if (body.directives && typeof body.directives === 'object') for (const k of Object.keys(p.directives)) if (typeof body.directives[k] === 'string') p.directives[k] = body.directives[k].slice(0, 4000);
    if (body.selections && typeof body.selections === 'object') {
      for (const [id, s] of Object.entries(body.selections)) {
        if (!['include', 'modify', 'exclude'].includes(s?.mode)) continue;
        p.selections[id] = { mode: s.mode, note: String(s.note ?? '').slice(0, 1000) };
      }
    }
    if (body.selections || body.directives) if (p.plan) p.plan.stale = true;
  }));

route('POST', '/api/projects/:id/references', async (_r, { params, body }) => {
  const kind = body.kind === 'manual' ? 'manual' : 'auto';
  const target = String(body.target ?? '').trim();
  if (kind !== 'manual' && !target) throw httpError(400, 'Enter a URL or a path.');
  if (kind === 'manual' && !String(body.notes ?? '').trim()) throw httpError(400, 'Describe at least one feature.');
  const ref = { id: store.newId('ref'), kind, target, label: String(body.label || target || 'Described features').slice(0, 80), notes: String(body.notes ?? '').slice(0, 6000), status: 'pending', elements: [], evidence: [], gaps: [], screenshot: null };
  await store.updateProject(params.id, (p) => void p.references.push(ref));
  return ref;
});
route('DELETE', '/api/projects/:id/references/:rid', async (_r, { params }) =>
  store.updateProject(params.id, (p) => {
    p.references = p.references.filter((r) => r.id !== params.rid);
    for (const k of Object.keys(p.selections)) if (k.startsWith(`${params.rid}:`)) delete p.selections[k];
    if (p.plan) p.plan.stale = true;
  }));
route('POST', '/api/projects/:id/references/:rid/analyze', async (_r, { params }) => {
  const project = await store.loadProject(params.id);
  const ref = project.references.find((r) => r.id === params.rid);
  if (!ref) throw httpError(404, 'Reference not found');
  return startJob(params.id, `analyze:${ref.id}`, async (progress) => {
    const result = await analyzeReference(params.id, ref, progress);
    await store.updateProject(params.id, (p) => {
      const r = p.references.find((x) => x.id === ref.id);
      if (!r) return;
      Object.assign(r, result);
      if (p.plan) p.plan.stale = true;
      store.logActivity(p, 'analyze', `Analysed “${r.label}”: ${result.status}, ${result.elements.length} element(s), ${result.evidence.length} REA evidence record(s)`);
    });
    return { status: result.status, elements: result.elements.length };
  });
});

route('POST', '/api/projects/:id/plan', async (_r, { params, body }) =>
  store.updateProject(params.id, (p) => {
    p.planOverrides ??= {};
    const o = body.overrides;
    if (o && typeof o === 'object') {
      if (typeof o.appName === 'string') p.planOverrides.appName = o.appName.slice(0, 80);
      if (typeof o.summary === 'string') p.planOverrides.summary = o.summary.slice(0, 2000);
      if (o.placement === 'sidebar' || o.placement === 'topbar') p.planOverrides.placement = o.placement;
      if (o.theme && typeof o.theme === 'object') {
        p.planOverrides.theme ??= {};
        for (const k of ['background', 'surface', 'text', 'accent']) if (/^#[0-9a-f]{6}$/i.test(o.theme[k] ?? '')) p.planOverrides.theme[k] = o.theme[k];
      }
      if (o.pageTitles && typeof o.pageTitles === 'object') p.planOverrides.pageTitles = { ...p.planOverrides.pageTitles, ...Object.fromEntries(Object.entries(o.pageTitles).map(([k, v]) => [k, String(v).slice(0, 60)])) };
      if (Array.isArray(o.removedPages)) p.planOverrides.removedPages = o.removedPages.map(String).slice(0, 50);
      if (typeof o.addRevision === 'string' && o.addRevision.trim()) (p.planOverrides.revisions ??= []).push(o.addRevision.trim().slice(0, 1000));
      if (Number.isInteger(o.removeRevision)) p.planOverrides.revisions?.splice(o.removeRevision, 1);
      if (o.reset === true) p.planOverrides = {};
    }
    p.plan = buildPlan(p);
    return p;
  }));
route('POST', '/api/projects/:id/plan/approve', async (_r, { params }) =>
  store.updateProject(params.id, (p) => {
    if (!p.plan || p.plan.stale) p.plan = buildPlan(p);
    p.plan.approved = true;
    p.plan.approvedAt = new Date().toISOString();
    store.logActivity(p, 'plan', 'Plan approved');
  }));
route('POST', '/api/projects/:id/plan/review', async (_r, { params, body }) => {
  requireEngine('ai');
  const project = await store.loadProject(params.id);
  if (!project.plan) throw httpError(400, 'Create the plan first.');
  return startJob(params.id, 'plan-review', async () => ({ reply: await reviewPlanWithClaude(project, project.plan, String(body.instruction ?? '').slice(0, 2000)) }));
});

route('POST', '/api/projects/:id/build', async (_r, { params, body }) => {
  requireEngine(body.engine);
  const project = await store.loadProject(params.id);
  if (!project.plan?.approved || project.plan.stale) throw httpError(400, 'Review and approve the current plan before building.');
  return startJob(params.id, 'build', async (progress) => {
    progress(`Building with the ${engineLabel(body.engine)} engine`);
    const out = body.engine === 'ai' ? await buildWithClaude(project, project.plan, progress) : buildScaffold(project.plan);
    return commitVersion(params.id, { ...out, engine: body.engine, kind: 'build' }, progress);
  });
});

route('POST', '/api/projects/:id/refine', async (_r, { params, body }) => {
  requireEngine(body.engine);
  const request = String(body.request ?? '').trim().slice(0, 4000);
  if (!request) throw httpError(400, 'Describe the change you want.');
  const project = await store.loadProject(params.id);
  const base = project.versions.find((v) => v.n === Number(body.version)) ?? project.versions.at(-1);
  if (!base) throw httpError(400, 'Build a first version before requesting changes.');
  if (body.engine === 'scaffold') {
    // Dry run so an uninterpretable request fails immediately instead of creating a no-op version.
    const dry = refineOffline(request, project.plan, structuredClone(project.planOverrides ?? {}));
    if (!dry.applied.length) throw httpError(400, `The offline engine could not interpret this request. It understands theme words (dark, light, a colour or hex code for the accent, rounded, compact, serif), navigation placement (sidebar, top bar), “rename app to …”, “rename page A to B” and “remove page A”. Use the Claude engine for anything else.`);
  }
  return startJob(params.id, 'build', async (progress) => {
    if (body.engine === 'ai') {
      progress('Sending the current version and your request to Claude');
      const current = await store.readVersionFiles(params.id, base.n);
      const out = await refineWithClaude(project, project.plan, current, request, base.verify, progress);
      return commitVersion(params.id, { ...out, engine: 'ai', kind: 'refine', request }, progress);
    }
    progress('Applying the request with the offline engine');
    let report;
    const updated = await store.updateProject(params.id, (p) => {
      p.planOverrides ??= {};
      report = refineOffline(request, p.plan, p.planOverrides);
      const approved = p.plan.approved;
      p.plan = buildPlan(p);
      p.plan.approved = approved;
    });
    const out = buildScaffold(updated.plan);
    const notes = [...report.applied.map((a) => `Applied: “${a}”`), ...report.unapplied.map((u) => `Not understood by the offline engine, nothing changed for: “${u}”`), ...out.notes];
    return commitVersion(params.id, { files: out.files, notes, engine: 'scaffold', kind: 'refine', request }, progress);
  });
});

route('POST', '/api/projects/:id/versions/:n/verify', async (_r, { params }) =>
  startJob(params.id, 'verify', async (progress) => ({ ok: (await runVerify(params.id, Number(params.n), progress)).ok })));
route('POST', '/api/projects/:id/versions/:n/restore', async (_r, { params }) => {
  const files = await store.readVersionFiles(params.id, Number(params.n));
  return startJob(params.id, 'build', async (progress) => {
    const project = await store.loadProject(params.id);
    const src = project.versions.find((v) => v.n === Number(params.n));
    const version = await store.updateProject(params.id, async (p) => {
      const n = Math.max(0, ...p.versions.map((v) => v.n)) + 1;
      const prev = await store.readVersionFiles(params.id, p.versions.at(-1).n).catch(() => ({}));
      await store.writeVersionFiles(params.id, n, files);
      const v = { n, createdAt: new Date().toISOString(), engine: src?.engine ?? 'scaffold', model: src?.model ?? null, kind: 'restore', request: null, notes: [`Restored from version ${params.n}.`], basedOn: Number(params.n), changes: store.diffFiles(prev, files), fileCount: Object.keys(files).length, verify: null };
      p.versions.push(v);
      store.logActivity(p, 'restore', `Version ${n} created by restoring version ${params.n}`);
      return v;
    });
    await runVerify(params.id, version.n, progress);
    return { version: version.n };
  });
});
route('GET', '/api/projects/:id/versions/:n/files', async (_r, { params }) => store.readVersionFiles(params.id, Number(params.n)));
route('GET', '/api/jobs/:jid', async (_r, { params }) => {
  const job = jobs.get(params.jid);
  if (!job) throw httpError(404, 'Job not found (the studio may have restarted).');
  return job;
});

// ---------- server plumbing ----------
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw httpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
}

async function sendFile(res, file, extraHeaders = {}) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders }).end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

function inside(root, file) {
  const r = path.resolve(root);
  const f = path.resolve(file);
  return f === r || f.startsWith(r + path.sep);
}

export async function startServer({ port = 4600, host = '127.0.0.1' } = {}) {
  const allowedHosts = (p) => new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);

  const api = http.createServer(async (req, res) => {
    try {
      const actualPort = api.address().port;
      // Loopback-only tool that can read local paths: refuse DNS-rebinding and cross-site requests.
      if (!allowedHosts(actualPort).has(req.headers.host)) throw httpError(403, 'Forbidden host');
      const origin = req.headers.origin;
      if (origin && !allowedHosts(actualPort).has(origin.replace(/^https?:\/\//, ''))) throw httpError(403, 'Cross-origin requests are not allowed');
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith('/api/')) {
        // Binary endpoints first
        let m;
        if (req.method === 'GET' && (m = /^\/api\/projects\/([^/]+)\/evidence\/([^/]+)$/.exec(pathname))) return sendFile(res, store.evidencePath(m[1], m[2]));
        if (req.method === 'GET' && (m = /^\/api\/projects\/([^/]+)\/versions\/(\d+)\/export$/.exec(pathname))) {
          const project = await store.loadProject(m[1]);
          const files = await store.readVersionFiles(m[1], Number(m[2]));
          const name = (project.plan?.appName || project.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
          const buf = zip(files, `${name}-v${m[2]}/`);
          res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}-v${m[2]}.zip"`, 'content-length': buf.length }).end(buf);
          return;
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const match = r.re.exec(pathname);
          if (!match) continue;
          const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
          return sendJson(res, 200, await r.handler(req, { params: match.groups ?? {}, body, query: url.searchParams }));
        }
        throw httpError(404, 'Unknown API route');
      }
      if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
      const file = path.join(WEB, pathname === '/' ? 'index.html' : pathname);
      if (!inside(WEB, file)) throw httpError(403, 'Forbidden');
      return sendFile(res, file, { 'content-security-policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:${actualPort + 1}` });
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : explainError(e) });
      else res.end();
    }
  });

  // Preview server: /<projectId>/<n>/<file>
  const preview = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') return res.writeHead(405).end();
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const m = /^\/(prj_[0-9a-f]{10})\/(\d+)\/(.*)$/.exec(pathname);
      if (!m) return res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      const root = store.versionDir(m[1], Number(m[2]));
      const file = path.join(root, m[3] || 'index.html');
      if (!inside(root, file)) return res.writeHead(403).end();
      return sendFile(res, file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });

  await new Promise((resolve, reject) => api.once('error', reject).listen(port, host, resolve));
  const actual = api.address().port;
  await new Promise((resolve, reject) => preview.once('error', reject).listen(actual + 1, host, resolve));
  previewOrigin = `http://127.0.0.1:${actual + 1}`;
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  return {
    url: `http://127.0.0.1:${actual}`,
    previewOrigin,
    async close() {
      await stopBrowser();
      api.close();
      preview.close();
    },
  };
}
