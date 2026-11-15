// REA Studio GUI. Plain ES module, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

const STEPS = [
  { id: 'references', title: 'References', sub: 'Pick what to analyse' },
  { id: 'select', title: 'Select & direct', sub: 'Keep, change or drop' },
  { id: 'plan', title: 'Review plan', sub: 'Approve before building' },
  { id: 'build', title: 'Build & preview', sub: 'Try it, request changes' },
  { id: 'versions', title: 'Versions & export', sub: 'History and source code' },
];
const STATUS = {
  verified: ['Verified', 'Observed directly by REA and backed by a stored evidence record.'],
  derived: ['Derived', 'Computed by the studio from REA evidence, such as a palette from REA’s screenshot.'],
  probe: ['Probed', 'Read by the studio’s own style probe in the browser. Not an REA finding.'],
  inferred: ['Inferred', 'A low-confidence guess. Excluded unless you opt in.'],
  user: ['Described', 'Typed by you. Nothing was inspected.'],
};
const CATEGORY = { page: 'Pages & routes', layout: 'Layout', navigation: 'Navigation', section: 'Sections & content blocks', feature: 'Features & workflows', data: 'Data & APIs', design: 'Design', tech: 'Technical context' };
const MODELS = [['claude-opus-5-5', 'Claude Opus 5.5 (recommended)'], ['claude-fable-5-2', 'Claude Fable 5.2 (most capable, slower)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest)']];

const state = {
  projects: [], project: null, step: 'references', info: null, settings: null, caps: null,
  jobs: {}, classify: null, addMode: 'auto',
  view: { version: null, viewport: 'desktop', engine: null, refFilter: 'all', showExcluded: true, codeVersion: null, codeFile: null, files: null, reviewReply: null },
};

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
function toast(message, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4000);
}
const fail = (e) => toast(e.message, 'error');

async function refreshProject() {
  if (!state.project) return;
  state.project = await api('GET', `/api/projects/${state.project.id}`);
}

/** Start a server job, show its progress wherever [data-job=key] appears, then refresh. */
async function runJob(key, start, { done, quiet } = {}) {
  if (state.jobs[key]) return;
  state.jobs[key] = { messages: ['Starting…'] };
  render();
  try {
    const { jobId } = await start();
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      const job = await api('GET', `/api/jobs/${jobId}`);
      state.jobs[key].messages = job.messages.map((m) => m.text);
      for (const el of $$(`[data-job="${key}"]`)) el.innerHTML = progressHtml(key);
      if (job.status === 'error') throw new Error(job.error);
      if (job.status === 'done') {
        delete state.jobs[key];
        await refreshProject();
        await done?.(job.result);
        break;
      }
    }
  } catch (e) {
    delete state.jobs[key];
    await refreshProject().catch(() => {});
    if (!quiet) fail(e);
  }
  render();
}
function progressHtml(key) {
  const j = state.jobs[key];
  if (!j) return '';
  return `<div class="progress"><span class="spinner"></span><span>${esc(j.messages.at(-1) || 'Working…')}</span></div>`;
}

// ---------- routing ----------
function parseHash() {
  const m = /^#\/p\/([^/]+)(?:\/(\w+))?/.exec(location.hash);
  return m ? { id: m[1], step: STEPS.some((s) => s.id === m[2]) ? m[2] : 'references' } : { id: null };
}
async function route() {
  const { id, step } = parseHash();
  try {
    if (!id) {
      state.project = null;
      state.projects = await api('GET', '/api/projects');
    } else {
      if (state.project?.id !== id) {
        state.project = await api('GET', `/api/projects/${id}`);
        state.view = { ...state.view, version: null, codeVersion: null, files: null, reviewReply: null, refFilter: 'all' };
      }
      state.step = step;
    }
  } catch (e) {
    fail(e);
    location.hash = '#/';
    return;
  }
  render();
}
const go = (step) => (location.hash = `#/p/${state.project.id}/${step}`);

// ---------- helpers on project data ----------
const defaultMode = (el) => (el.status === 'inferred' || el.category === 'tech' ? 'exclude' : 'include');
const sel = (el) => state.project.selections[el.id] ?? { mode: defaultMode(el), note: '' };
const allElements = () => state.project.references.flatMap((r) => (r.elements ?? []).map((e) => ({ ...e, ref: r })));
const planReady = () => state.project.plan && !state.project.plan.stale;
const latest = () => state.project.versions.at(-1) ?? null;
const currentVersion = () => state.project.versions.find((v) => v.n === state.view.version) ?? latest();
const aiReady = () => Boolean(state.settings?.hasApiKey);
const engine = () => state.view.engine ?? (aiReady() ? 'ai' : 'scaffold');
const badge = (status) => `<span class="badge ${status}" title="${esc(STATUS[status][1])}">${STATUS[status][0]}</span>`;

function stepDone(id) {
  const p = state.project;
  if (id === 'references') return p.references.some((r) => r.status === 'analyzed');
  if (id === 'select') return Boolean(p.plan) || Object.keys(p.selections).length > 0;
  if (id === 'plan') return Boolean(p.plan?.approved && !p.plan.stale);
  return p.versions.length > 0;
}

// ---------- render ----------
function render() {
  const active = document.activeElement;
  const keep = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const scroll = $('.main')?.scrollTop ?? 0;
  const root = $('#root');
  if (!state.project) {
    $('#crumb').innerHTML = '';
    root.innerHTML = `<main class="main">${homeView()}</main>`;
  } else {
    $('#crumb').innerHTML = `<span>/</span><strong>${esc(state.project.name)}</strong>`;
    const views = { references: referencesView, select: selectView, plan: planView, build: buildView, versions: versionsView };
    root.innerHTML = `<nav class="steps" aria-label="Workflow">${STEPS.map((s, i) => `<button class="step ${stepDone(s.id) ? 'done' : ''}" ${s.id === state.step ? 'aria-current="step"' : ''} data-action="step" data-step="${s.id}"><span class="num">${stepDone(s.id) ? '✓' : i + 1}</span><span><b>${s.title}</b><span class="sub">${s.sub}</span></span></button>`).join('')}
      <span class="spacer"></span><button class="btn quiet sm" data-action="home">← All projects</button></nav>
      <main class="main">${views[state.step]()}</main>`;
  }
  if ($('.main')) $('.main').scrollTop = scroll;
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ }
    }
  }
}

function homeView() {
  return `<div class="page">
    <div class="pagehead"><div><h1>Build your own version of software you like</h1>
      <p>Point the studio at websites, web apps or desktop apps. It uses REA to investigate them, shows you what it found and how sure it is, and builds a working application from the parts you choose.</p></div></div>
    <form class="card stack" data-form="new-project">
      <h2>Start a project</h2>
      <div class="grid2">
        <label class="field">Project name<input type="text" name="name" required maxlength="120" placeholder="e.g. Team workspace"></label>
        <label class="field">What do you want to build? <span class="hint">Optional. You can refine this later.</span><input type="text" name="brief" maxlength="400" placeholder="e.g. An orders dashboard with a simple notes area"></label>
      </div>
      <div><button class="btn primary">Create project</button></div>
    </form>
    <div class="stack"><h2>Your projects</h2>
      ${state.projects.length ? `<div class="projects">${state.projects.map((p) => `<button class="card project" data-action="open-project" data-id="${p.id}"><h3>${esc(p.name)}</h3><span class="muted small">${p.references} reference${p.references === 1 ? '' : 's'} · ${p.versions} version${p.versions === 1 ? '' : 's'}</span><span class="muted small">Updated ${when(p.updatedAt)}</span></button>`).join('')}</div>` : `<div class="empty">No projects yet. Create one above to get started.</div>`}
    </div>
    <p class="muted small">Only analyse software you own or are authorised to examine. The studio rebuilds structure and behaviour with original code; it does not copy a reference’s code, content, branding or assets.</p>
  </div>`;
}

// ----- step 1: references -----
function referencesView() {
  const p = state.project;
  const c = state.classify;
  const manual = state.addMode === 'manual';
  return `<div class="page">
    <div class="pagehead"><div><h1>References</h1><p>Add each thing you want to draw from: a page of a website or web app, a desktop application folder, or simply a description. Add several to combine them.</p></div>
      <button class="btn primary" data-action="step" data-step="select" ${p.references.some((r) => r.elements?.length) ? '' : 'disabled'}>Next: choose what to keep →</button></div>
    <form class="card stack" data-form="add-reference">
      <div class="row between"><h2>Add a reference</h2>
        <div class="seg" role="group" aria-label="Reference type"><button type="button" data-action="add-mode" data-mode="auto" aria-pressed="${!manual}">Analyse a target</button><button type="button" data-action="add-mode" data-mode="manual" aria-pressed="${manual}">Describe it myself</button></div></div>
      ${manual ? `
        <label class="field">Name<input type="text" name="label" maxlength="80" placeholder="e.g. Features from the old desktop tool" required></label>
        <label class="field">Features, one per line <span class="hint">Use this for software the studio cannot inspect. These are labelled “Described”, never “Verified”.</span><textarea name="notes" rows="4" required placeholder="Bulk rename files&#10;Export a report as PDF"></textarea></label>` : `
        <label class="field">Website address or path on this computer
          <input type="text" id="target-input" name="target" required autocomplete="off" placeholder="https://app.example.com/dashboard   or   /Applications/Example.app   or   C:\\Program Files\\Example" value="${esc(state.targetDraft ?? '')}"></label>
        <div id="classify">${classifyHtml(c)}</div>
        <div class="grid2">
          <label class="field">Name <span class="hint">Optional</span><input type="text" name="label" maxlength="80" placeholder="e.g. Competitor dashboard"></label>
          <label class="field">Extra features you know about <span class="hint">Optional, one per line</span><input type="text" name="notes" placeholder="Things the analysis cannot see"></label>
        </div>`}
      <div class="row"><button class="btn primary">${manual ? 'Add description' : 'Add and analyse'}</button>
        <span class="muted small">Pages that need sign-in: turn off “Run the browser hidden” in Settings, sign in when the window opens, then analyse again.</span></div>
    </form>
    ${p.references.length ? p.references.map(refCard).join('') : `<div class="empty">Nothing added yet. Each reference is analysed separately, and every finding keeps a note of where it came from.</div>`}
  </div>`;
}
function classifyHtml(c) {
  if (!c) return '';
  return c.supported ? `<div class="banner info"><span class="status ok">Supported</span><span>${esc(c.via)}</span></div>`
    : `<div class="banner"><span class="status ${c.kind === 'invalid' ? 'bad' : 'unsupported'}">${c.kind === 'invalid' ? 'Check the target' : 'Not supported'}</span><span>${esc(c.reason)}</span></div>`;
}
function refCard(r) {
  const p = state.project;
  const key = `analyze:${r.id}`;
  const counts = {};
  for (const e of r.elements ?? []) counts[e.status] = (counts[e.status] || 0) + 1;
  const thumb = r.screenshot ? `style="background-image:url('/api/projects/${p.id}/evidence/${encodeURIComponent(r.screenshot)}')"` : '';
  return `<article class="card ref">
    <div class="thumb" ${thumb} role="img" aria-label="${r.screenshot ? 'Screenshot captured by REA' : 'No screenshot'}">${r.screenshot ? '' : r.kind === 'manual' ? 'Described by you' : 'No screenshot'}</div>
    <div class="stack">
      <div class="row between top"><div><h2>${esc(r.label)}</h2><div class="muted small mono">${esc(r.target || 'manual description')}</div></div>
        <div class="row"><span class="status ${esc(r.status)}">${esc(r.status)}</span>
          <button class="btn sm" data-action="analyze" data-id="${r.id}" ${state.jobs[key] ? 'disabled' : ''}>${r.status === 'pending' ? 'Analyse' : 'Analyse again'}</button>
          <button class="btn sm danger" data-action="remove-ref" data-id="${r.id}">Remove</button></div></div>
      <div data-job="${key}">${progressHtml(key)}</div>
      ${r.elements?.length ? `<div class="row">${Object.entries(counts).map(([s, n]) => `${badge(s)} <span class="small muted">${n}</span>`).join(' ')}</div>` : ''}
      ${r.evidence?.length ? `<details><summary>${r.evidence.length} REA evidence record${r.evidence.length === 1 ? '' : 's'}</summary><ul class="plain small">${r.evidence.map((e) => `<li><code>${esc(e.operation)}</code> · confidence <b>${esc(e.confidence)}</b> · <a href="/api/projects/${p.id}/evidence/${encodeURIComponent(e.file)}" target="_blank" rel="noopener">raw evidence</a> <span class="muted mono">${esc((e.evidenceId || '').slice(0, 19))}…</span></li>`).join('')}</ul></details>` : ''}
      ${r.gaps?.length ? `<details ${r.status !== 'analyzed' ? 'open' : ''}><summary>${r.gaps.length} thing${r.gaps.length === 1 ? '' : 's'} not observed or not possible</summary><ul class="dots small muted">${r.gaps.map((g) => `<li>${esc(g.message)}</li>`).join('')}</ul></details>` : ''}
    </div></article>`;
}

// ----- step 2: select -----
function selectView() {
  const p = state.project;
  const els = allElements();
  if (!els.length) return `<div class="page"><div class="empty">Analyse at least one reference first.<br><br><button class="btn primary" data-action="step" data-step="references">Go to references</button></div></div>`;
  const refs = p.references.filter((r) => r.elements?.length);
  const shown = els.filter((e) => state.view.refFilter === 'all' || e.ref.id === state.view.refFilter);
  const chosen = els.filter((e) => sel(e).mode !== 'exclude').length;
  const groups = refs.filter((r) => state.view.refFilter === 'all' || r.id === state.view.refFilter).map((r) => {
    const mine = shown.filter((e) => e.ref.id === r.id);
    const byCat = Object.keys(CATEGORY).map((c) => [c, mine.filter((e) => e.category === c)]).filter(([, l]) => l.length);
    return `<section class="card stack"><div class="row between"><h2>${esc(r.label)}</h2><div class="row"><button class="btn sm" data-action="bulk" data-ref="${r.id}" data-mode="include">Include all</button><button class="btn sm" data-action="bulk" data-ref="${r.id}" data-mode="exclude">Exclude all</button></div></div>
      ${byCat.map(([c, list]) => `<div><div class="group-title"><h3>${CATEGORY[c]}</h3></div>${list.map(elementRow).join('')}</div>`).join('')}</section>`;
  }).join('');
  const d = p.directives;
  return `<div class="page wide">
    <div class="pagehead"><div><h1>Choose what to keep, change or leave out</h1><p>Everything found is listed with how it is known. Use “Change” to say in your own words how a piece should differ. Mix elements from different references freely.</p></div>
      <button class="btn primary" data-action="make-plan">Draft the plan →</button></div>
    <div class="split">
      <div class="stack">
        <div class="row"><span class="muted small">${chosen} of ${els.length} selected</span><span class="spacer"></span>
          <label class="row small">Show <select id="ref-filter" style="width:auto"><option value="all">all references</option>${refs.map((r) => `<option value="${r.id}" ${state.view.refFilter === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label></div>
        ${groups}
      </div>
      <aside class="stack sticky">
        <div class="card stack"><h2>Your direction, in plain language</h2><p class="muted small">These apply to the whole app and override anything observed in a reference.</p>
          ${[['appearance', 'Appearance', 'e.g. Dark theme with a teal accent, rounded corners'], ['layout', 'Layout', 'e.g. Compact, with the table as the main focus'], ['navigation', 'Navigation', 'e.g. Top bar instead of a sidebar'], ['functionality', 'Functionality', 'e.g. Orders can be archived; add CSV export']].map(([k, label, ph]) => `<label class="field">${label}<textarea id="dir-${k}" data-directive="${k}" rows="2" placeholder="${ph}">${esc(d[k])}</textarea></label>`).join('')}
        </div>
        <div class="card flat stack"><h3>How each finding is known</h3><div class="legend">${Object.entries(STATUS).map(([k, [, text]]) => `<div>${badge(k)}<span>${text}</span></div>`).join('')}</div></div>
      </aside>
    </div></div>`;
}
function elementRow(e) {
  const s = sel(e);
  return `<div class="el ${s.mode === 'exclude' ? 'excluded' : ''}" data-el="${e.id}">
    <div class="el-body stack tight"><div class="el-title">${esc(e.title)} ${badge(e.status)}</div>
      <div class="muted small">${esc(e.detail)}${e.source?.operation ? ` <span class="mono">· ${esc(e.source.operation)}</span>` : ''}</div>
      ${e.items?.length ? `<div class="chips">${e.items.slice(0, 14).map((i) => `<span class="chip" title="${esc(i)}">${esc(i)}</span>`).join('')}${e.items.length > 14 ? `<span class="chip">+${e.items.length - 14} more</span>` : ''}</div>` : ''}</div>
    <div class="seg" role="group" aria-label="What to do with ${esc(e.title)}">${[['include', 'Include'], ['modify', 'Change'], ['exclude', 'Exclude']].map(([m, l]) => `<button data-action="mode" data-mode="${m}" aria-pressed="${s.mode === m}">${l}</button>`).join('')}</div>
    <div class="el-note" ${s.mode === 'modify' ? '' : 'hidden'}><input type="text" id="note-${e.id}" data-note="${e.id}" value="${esc(s.note)}" placeholder="How should this be different? e.g. Add a “Priority” column and allow sorting by it" aria-label="Change for ${esc(e.title)}"></div>
  </div>`;
}

// ----- step 3: plan -----
function planView() {
  const p = state.project;
  const plan = p.plan;
  if (!plan) return `<div class="page"><div class="empty">No plan yet.<br><br><button class="btn primary" data-action="make-plan">Draft the plan from my selections</button></div></div>`;
  const t = plan.theme;
  const rep = plan.directiveReport ?? { applied: [], unapplied: [] };
  const pending = [...rep.unapplied.map((u) => u.text), ...plan.modifications.map((m) => `${m.title}: ${m.note}`), ...plan.revisions];
  return `<div class="page">
    <div class="pagehead"><div><h1>Review the plan</h1><p>This is exactly what will be built. Edit it here, add notes for the builder, and approve when it looks right. Nothing is built until you approve.</p></div>
      <div class="row">${plan.approved && !plan.stale ? `<span class="status ok">Approved</span><button class="btn primary" data-action="step" data-step="build">Go to build →</button>` : `<button class="btn primary" data-action="approve-plan">Approve plan</button>`}</div></div>
    ${plan.stale ? `<div class="banner"><span>Your selections or directions changed after this plan was drafted.</span><button class="btn sm" data-action="make-plan">Update the plan</button></div>` : ''}
    <div class="grid2">
      <div class="card stack"><h2>Identity</h2>
        <label class="field">App name<input type="text" id="plan-name" data-plan="appName" value="${esc(plan.appName)}" maxlength="80"></label>
        <label class="field">What it is for<textarea id="plan-summary" data-plan="summary" rows="3">${esc(plan.summary)}</textarea></label></div>
      <div class="card stack"><h2>Look</h2>
        <div class="swatches">${[['background', 'Background'], ['surface', 'Panels'], ['text', 'Text'], ['accent', 'Accent']].map(([k, l]) => `<label class="swatch"><input type="color" data-theme="${k}" value="${esc(t[k])}" aria-label="${l} colour">${l}<span class="mono">${esc(t[k])}</span></label>`).join('')}</div>
        <p class="small muted">Font: <span class="mono">${esc(t.font)}</span> · corners ${esc(t.radius)} · ${esc(t.mode)} · ${esc(t.density)}</p>
        <p class="small muted">Starting point: ${esc(t.source)}.</p>
        ${plan.design.length ? `<div class="chips">${plan.design.map((x) => `<span class="chip" title="${esc(x.title)}">${esc(x.from)}: ${esc(x.title)}</span>`).join('')}</div>` : ''}</div>
    </div>
    <div class="card stack"><div class="row between"><h2>Navigation and pages</h2>
        <label class="row small">Navigation style <select data-plan="placement" style="width:auto"><option value="sidebar" ${plan.navigation.placement === 'sidebar' ? 'selected' : ''}>Sidebar</option><option value="topbar" ${plan.navigation.placement === 'topbar' ? 'selected' : ''}>Top bar</option></select></label></div>
      <p class="small muted">Menu taken from: ${esc(plan.navigation.source)}.</p>
      <div class="grid2">${plan.pages.map((pg) => `<div class="pageplan"><div class="row"><input type="text" id="page-${pg.id}" data-page-title="${pg.id}" value="${esc(pg.title)}" aria-label="Page title" style="font-weight:600">${plan.pages.length > 1 ? `<button class="btn sm danger" data-action="remove-page" data-id="${pg.id}">Remove</button>` : ''}</div>
        ${pg.widgets.map((w) => `<div class="widget"><span class="type">${esc(w.type)}</span><span>${esc(w.title || w.label || w.placeholder || (w.tabs || []).join(', '))}${w.columns ? ` <span class="muted">(${esc(w.columns.join(', '))})</span>` : ''}${w.operations ? ` <span class="muted">(${esc(w.operations.join(', '))})</span>` : ''}</span>${w.status ? `<span class="meta">${badge(w.status)}<span class="muted small">${esc(w.from ?? '')}</span>${w.note ? `<span class="chip" title="${esc(w.note)}">change: ${esc(w.note)}</span>` : ''}</span>` : ''}</div>`).join('')}
        ${pg.placeholder ? `<p class="small muted">Not observed in any reference — placeholder only.</p>` : ''}</div>`).join('')}</div></div>
    <div class="grid2">
      <div class="card stack"><h2>Notes for the builder</h2>
        <p class="small muted">Say anything else you want changed. Notes are added to the plan and handed to the build engine.</p>
        ${plan.revisions.length ? `<ul class="plain">${plan.revisions.map((r, i) => `<li class="row between"><span>${esc(r)}</span><button class="btn sm quiet" data-action="remove-revision" data-i="${i}" aria-label="Remove note">✕</button></li>`).join('')}</ul>` : ''}
        <form class="stack" data-form="add-revision"><textarea name="text" rows="2" required placeholder="e.g. Put the notes area on the first page next to the orders table"></textarea>
          <div class="row"><button class="btn">Add note</button>${aiReady() ? `<button type="button" class="btn quiet" data-action="review-plan">Ask Claude how it would handle this</button>` : ''}</div></form>
        <div data-job="plan-review">${progressHtml('plan-review')}</div>
        ${state.view.reviewReply ? `<div class="banner info notes">${esc(state.view.reviewReply)}</div>` : ''}
        ${pending.length ? `<details open><summary>${pending.length} instruction${pending.length === 1 ? '' : 's'} that need the Claude engine</summary><ul class="dots small muted">${pending.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="small muted">The offline engine only understands theme, navigation placement and simple page edits. It will build without these and say so.</p></details>` : ''}
        ${rep.applied.length ? `<details><summary>${rep.applied.length} instruction${rep.applied.length === 1 ? '' : 's'} already reflected above</summary><ul class="dots small muted">${rep.applied.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul></details>` : ''}</div>
      <div class="card stack"><h2>Assumptions and gaps</h2>
        ${plan.assumptions.length ? `<ul class="dots small">${plan.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : `<p class="muted small">None recorded.</p>`}
        <details><summary>${plan.features.length} selected element${plan.features.length === 1 ? '' : 's'} and where each comes from</summary><ul class="plain small">${plan.features.map((f) => `<li>${badge(f.status)} ${esc(f.title)} <span class="muted">· ${esc(f.from)}</span></li>`).join('')}</ul></details>
        ${plan.excluded.length ? `<details><summary>${plan.excluded.length} excluded</summary><ul class="dots small muted">${plan.excluded.map((x) => `<li>${esc(x.title)} · ${esc(x.from)}</li>`).join('')}</ul></details>` : ''}
        <div><button class="btn sm quiet" data-action="reset-plan">Discard my plan edits</button></div></div>
    </div></div>`;
}

// ----- step 4: build & preview -----
function engineChooser() {
  const e = engine();
  return `<div class="engine" role="radiogroup" aria-label="Build engine">
    <label><input type="radio" name="engine" value="ai" ${e === 'ai' ? 'checked' : ''} ${aiReady() ? '' : 'disabled'}><b>Claude</b><span class="small muted">${aiReady() ? 'Writes the app from your plan and follows any plain-language instruction.' : 'Needs an Anthropic API key. Add one in Settings.'}</span></label>
    <label><input type="radio" name="engine" value="scaffold" ${e === 'scaffold' ? 'checked' : ''}><b>Offline scaffold</b><span class="small muted">Instant, no key. Working app from a fixed toolkit; limited instructions.</span></label></div>`;
}
function verifyHtml(v) {
  const r = v.verify;
  if (!r) return `<p class="muted small">Not checked yet.</p>`;
  const line = (cls, mark, text) => `<div class="checkline ${cls}"><span class="mark">${mark}</span><span>${text}</span></div>`;
  const out = [];
  const errors = r.problems.filter((x) => x.kind !== 'accessibility');
  out.push(errors.length ? line('fail', '✕', `${errors.length} runtime problem${errors.length === 1 ? '' : 's'}`) : line('pass', '✓', 'Loads with no script or network errors'));
  if (r.pages?.length) { const bad = r.pages.filter((x) => !x.ok); out.push(bad.length ? line('fail', '✕', `${bad.length} of ${r.pages.length} pages failed: ${esc(bad.map((b) => b.route).join(', '))}`) : line('pass', '✓', `All ${r.pages.length} pages open`)); }
  if (r.coverage) out.push(r.coverage.missing.length ? line('note', '!', `${r.coverage.found} of ${r.coverage.expected} planned labels found on screen`) : line('pass', '✓', `All ${r.coverage.expected} planned labels found on screen`));
  if (r.rea?.evidenceId) out.push(line(r.rea.unlabelledControls ? 'note' : 'pass', r.rea.unlabelledControls ? '!' : '✓', `REA inspection: ${r.rea.accessibilityNodes} accessibility nodes, ${r.rea.interactiveControls} controls, ${r.rea.unlabelledControls} without a name`));
  else if (r.rea?.error) out.push(line('note', '!', `REA could not inspect the result: ${esc(r.rea.error)}`));
  const details = [...errors.map((x) => `${x.kind}: ${x.text}`), ...r.problems.filter((x) => x.kind === 'accessibility').map((x) => x.text), ...(r.coverage?.missing ?? []).map((m) => `Not found on screen: ${m.kind} “${m.label}”`)];
  return `<div class="stack tight">${out.join('')}${details.length ? `<details><summary>Details</summary><ul class="dots small muted">${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}<p class="small muted">Checked ${when(r.checkedAt)}. These checks confirm the app runs and matches the plan’s labels; they do not prove every behaviour is correct.</p></div>`;
}
function buildView() {
  const p = state.project;
  const building = Boolean(state.jobs.build);
  if (!p.versions.length) {
    return `<div class="page"><div class="pagehead"><div><h1>Build</h1><p>Turn the approved plan into a working application. You can preview it here and keep refining.</p></div></div>
      ${!planReady() || !p.plan.approved ? `<div class="banner"><span>${p.plan ? 'The plan needs your approval first.' : 'Draft and approve a plan first.'}</span><button class="btn sm" data-action="step" data-step="plan">Review the plan</button></div>` : ''}
      <div class="card stack"><h2>Choose how to build</h2>${engineChooser()}
        <div class="row"><button class="btn primary" data-action="build" ${planReady() && p.plan.approved && !building ? '' : 'disabled'}>Build version 1</button><div data-job="build">${progressHtml('build')}</div></div>
        <p class="small muted">The Claude engine sends your plan, the selected findings and reference screenshots to the Anthropic API. The offline engine sends nothing anywhere.</p></div></div>`;
  }
  const v = currentVersion();
  const widths = { desktop: '100%', tablet: '820px', phone: '390px' };
  const src = `${state.info.previewOrigin}/${p.id}/${v.n}/`;
  const stale = p.plan?.stale || !p.plan?.approved;
  return `<div class="page wide">
    <div class="pagehead"><div><h1>Build & preview</h1><p>Use the app below as you would for real. Describe any change in plain language to produce a new version; earlier versions stay available.</p></div></div>
    <div class="buildgrid">
      <div class="frame-wrap">
        <div class="frame-bar"><label class="row small">Version <select id="version-pick" style="width:auto">${[...p.versions].reverse().map((x) => `<option value="${x.n}" ${x.n === v.n ? 'selected' : ''}>v${x.n}${x.n === latest().n ? ' (latest)' : ''}</option>`).join('')}</select></label>
          <div class="seg" role="group" aria-label="Preview size">${Object.keys(widths).map((k) => `<button data-action="viewport" data-size="${k}" aria-pressed="${state.view.viewport === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
          <span class="spacer"></span><button class="btn sm" data-action="reload-preview">Reload</button><a class="btn sm" href="${src}" target="_blank" rel="noopener">Open in new tab</a></div>
        <div class="frame-stage ${state.view.viewport === 'desktop' ? '' : 'narrow'}"><iframe class="preview" id="preview" title="Preview of version ${v.n}" src="${src}" style="max-width:${widths[state.view.viewport]}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"></iframe></div>
      </div>
      <aside class="stack">
        <div class="card stack"><h2>Request a change</h2>
          <form class="stack" data-form="refine"><textarea id="refine-text" name="request" rows="4" required placeholder="${engine() === 'ai' ? 'e.g. Add a status filter above the orders table and make paid orders green' : 'e.g. Make it dark with a purple accent. Rename page Reports to Insights'}"></textarea>
            ${engineChooser()}
            <div class="row"><button class="btn primary" ${building ? 'disabled' : ''}>Apply to v${v.n} → new version</button></div></form>
          <div data-job="build">${progressHtml('build')}</div>
          ${stale ? `<div class="banner"><span>The plan changed since this was built.</span><button class="btn sm" data-action="step" data-step="plan">Review plan</button>${planReady() && p.plan.approved ? '' : ''}</div>` : `<div><button class="btn sm quiet" data-action="build" ${building ? 'disabled' : ''}>Rebuild from the plan instead</button></div>`}
        </div>
        <div class="card stack"><div class="row between"><h2>Checks for v${v.n}</h2><button class="btn sm" data-action="verify" data-n="${v.n}" ${state.jobs.verify ? 'disabled' : ''}>Run again</button></div>
          <div data-job="verify">${progressHtml('verify')}</div>${verifyHtml(v)}</div>
        <div class="card stack"><h2>Builder’s notes for v${v.n}</h2>
          <p class="small muted">${v.kind === 'build' ? 'Built' : v.kind === 'restore' ? 'Restored' : 'Changed'} ${when(v.createdAt)} with ${v.engine === 'ai' ? `Claude${v.model ? ` (${esc(v.model)})` : ''}` : 'the offline scaffold'}.</p>
          ${v.request ? `<p class="small"><b>Request:</b> ${esc(v.request)}</p>` : ''}
          ${v.notes?.length ? `<div class="notes">${esc(v.notes.join('\n'))}</div>` : `<p class="muted small">No notes.</p>`}</div>
      </aside>
    </div></div>`;
}

// ----- step 5: versions -----
function versionsView() {
  const p = state.project;
  if (!p.versions.length) return `<div class="page"><div class="empty">No versions yet. Build the first one to see it here.<br><br><button class="btn primary" data-action="step" data-step="build">Go to build</button></div></div>`;
  const cv = state.view.codeVersion;
  return `<div class="page">
    <div class="pagehead"><div><h1>Versions & export</h1><p>Every build and change is kept. Preview or restore any version, read its source, or download it as a ready-to-run project.</p></div></div>
    <div class="card"><div data-job="build">${progressHtml('build')}</div>${[...p.versions].reverse().map((v) => {
      const ok = v.verify ? (v.verify.ok ? ['ok', 'Checks passed'] : ['bad', 'Checks found problems']) : ['', 'Not checked'];
      return `<div class="version"><div class="vnum">v${v.n}</div>
        <div class="stack tight"><div class="row"><b>${v.kind === 'build' ? 'Built from plan' : v.kind === 'restore' ? `Restored from v${v.basedOn}` : 'Change request'}</b><span class="status ${ok[0]}">${ok[1]}</span><span class="muted small">${when(v.createdAt)} · ${v.engine === 'ai' ? 'Claude' : 'offline scaffold'} · ${v.fileCount} files</span></div>
          ${v.request ? `<div class="small">“${esc(v.request)}”</div>` : ''}
          ${v.changes?.length && v.basedOn ? `<div class="chips">${v.changes.slice(0, 10).map((c) => `<span class="chip">${c.change === 'added' ? '+' : c.change === 'removed' ? '−' : '~'} ${esc(c.file)}</span>`).join('')}</div>` : ''}</div>
        <div class="row"><button class="btn sm" data-action="preview-version" data-n="${v.n}">Preview</button><button class="btn sm" data-action="view-code" data-n="${v.n}">Source</button>
          ${v.n !== latest().n ? `<button class="btn sm" data-action="restore" data-n="${v.n}">Restore</button>` : ''}<a class="btn sm primary" href="/api/projects/${p.id}/versions/${v.n}/export" download>Download .zip</a></div></div>`;
    }).join('')}</div>
    ${cv && state.view.files ? `<div class="card stack"><div class="row between"><h2>Source of v${cv}</h2><button class="btn sm quiet" data-action="close-code">Close</button></div>
      <div class="files"><nav aria-label="Files">${Object.keys(state.view.files).map((f) => `<button data-action="pick-file" data-file="${esc(f)}" aria-current="${f === state.view.codeFile}">${esc(f)}</button>`).join('')}</nav><pre tabindex="0">${esc(state.view.files[state.view.codeFile] ?? '')}</pre></div></div>` : ''}
    <div class="card stack"><h2>Running an exported project</h2>
      <p>Unzip it, then in that folder run <code>npm start</code> and open <code>http://127.0.0.1:4173</code>. It needs Node.js 18 or newer and nothing else. Each export includes a <code>README.md</code> with these steps and a <code>PROVENANCE.md</code> listing which parts came from verified observations and which are assumptions.</p></div>
    <details class="card"><summary>Project activity</summary><ul class="plain small muted">${[...p.activity].reverse().slice(0, 40).map((a) => `<li>${when(a.at)} — ${esc(a.message)}</li>`).join('')}</ul></details>
    <div><button class="btn danger sm" data-action="delete-project">Delete this project</button></div>
  </div>`;
}

// ---------- modals ----------
function openModal(html) {
  const m = $('#modal');
  m.innerHTML = html;
  if (!m.open) m.showModal();
}
async function showCapabilities(refresh = false) {
  openModal(`<div class="modal-head"><h2>What can be analysed</h2><span class="spacer"></span><button class="btn sm quiet" data-action="close-modal">Close</button></div><div class="modal-body"><div class="progress"><span class="spinner"></span>Checking this installation…</div></div>`);
  try {
    const c = (state.caps = await api('GET', `/api/capabilities${refresh ? '?refresh=1' : ''}`));
    openModal(`<div class="modal-head"><h2>What can be analysed</h2><span class="spacer"></span><button class="btn sm quiet" data-action="close-modal">Close</button></div>
      <div class="modal-body">
        <div class="row"><span class="status ${c.rea.ok ? 'ok' : 'bad'}">REA ${esc(c.rea.version ?? 'missing')}</span>${c.rea.counts ? `<span class="muted small">${c.rea.counts.cli_commands} commands available; the studio uses the web, desktop-folder and JavaScript-application ones.</span>` : ''}${c.rea.error ? `<span class="small">${esc(c.rea.error)}</span>` : ''}</div>
        <div class="row"><span class="status ${c.browser.executable ? 'ok' : 'bad'}">${c.browser.executable ? 'Browser found' : 'No browser found'}</span><span class="muted small mono">${esc(c.browser.executable ?? 'Install Chrome, Chromium, Edge or Brave to analyse websites and to check builds.')}</span></div>
        <div class="row"><span class="status ${c.ai.configured ? 'ok' : 'warn'}">${c.ai.configured ? 'Claude engine ready' : 'Claude engine not set up'}</span><span class="muted small">${c.ai.configured ? '' : 'Only the offline scaffold engine is available until you add an API key in Settings.'}</span></div>
        <table class="matrix"><thead><tr><th>Target</th><th>Support</th><th>What the studio does</th><th>What it cannot see</th></tr></thead><tbody>
          ${c.matrix.map((r) => `<tr><td><b>${esc(r.target)}</b></td><td><span class="status ${r.level}">${r.level === 'full' ? 'Supported' : r.level === 'partial' ? 'Partly' : r.level === 'manual' ? 'Manual' : 'Not supported'}</span></td><td>${esc(r.studio)}${r.needs && r.needs !== '—' ? `<div class="muted small">${esc(r.needs)}</div>` : ''}</td><td class="muted">${esc(r.limits)}</td></tr>`).join('')}</tbody></table>
        <details><summary>Native analysis engines REA can use (not needed by the studio)</summary><ul class="plain small">${c.rea.providers.map((x) => `<li><span class="status ${x.available ? 'ok' : ''}">${esc(x.id)}</span> <span class="muted">${x.available ? 'available' : 'not configured'}</span></li>`).join('')}</ul></details>
      </div>`);
  } catch (e) {
    openModal(`<div class="modal-head"><h2>What can be analysed</h2><span class="spacer"></span><button class="btn sm quiet" data-action="close-modal">Close</button></div><div class="modal-body"><div class="banner error">${esc(e.message)}</div></div>`);
  }
}
function showSettings() {
  const s = state.settings;
  openModal(`<div class="modal-head"><h2>Settings</h2><span class="spacer"></span><button class="btn sm quiet" data-action="close-modal">Close</button></div>
    <form class="modal-body" data-form="settings">
      <label class="field">Anthropic API key <span class="hint">${s.hasApiKey ? `A key is set (from ${esc(s.apiKeySource)}). Leave blank to keep it.` : 'Enables the Claude build engine. Stored only on this computer.'}</span><input type="password" name="apiKey" autocomplete="off" placeholder="${s.hasApiKey ? '••••••••' : 'sk-ant-…'}"></label>
      ${s.apiKeySource === 'settings' ? `<label class="check"><input type="checkbox" name="clearKey"><span>Remove the saved key</span></label>` : ''}
      <div class="grid2"><label class="field">Model<select name="model">${MODELS.map(([id, label]) => `<option value="${id}" ${s.model === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="field">Effort <span class="hint">Higher is more thorough and slower.</span><select name="effort">${['low', 'medium', 'high', 'xhigh'].map((e) => `<option ${s.effort === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label></div>
      <label class="check"><input type="checkbox" name="headless" ${s.headless ? 'checked' : ''}><span><b>Run the analysis browser hidden</b><br><span class="muted small">Turn this off to see the browser window, for example to sign in to a web app before analysing it. The studio uses its own separate browser profile.</span></span></label>
      <label class="check"><input type="checkbox" name="styleProbe" ${s.styleProbe ? 'checked' : ''}><span><b>Read fonts, colours and layout sizes with the studio’s style probe</b><br><span class="muted small">REA does not report CSS. The probe runs a small read-only script in the page; its findings are labelled “Probed”.</span></span></label>
      <div class="row"><button class="btn primary">Save</button><span class="muted small">Projects are stored in <span class="mono">${esc(state.info.dataDir)}</span></span></div>
    </form>`);
}

// ---------- actions ----------
let saveTimer;
function queueSave(patch) {
  clearTimeout(saveTimer);
  queueSave.pending = { ...(queueSave.pending || {}), ...patch, selections: { ...(queueSave.pending?.selections || {}), ...(patch.selections || {}) }, directives: { ...(queueSave.pending?.directives || {}), ...(patch.directives || {}) } };
  saveTimer = setTimeout(flushSave, 500);
}
async function flushSave() {
  clearTimeout(saveTimer);
  const patch = queueSave.pending;
  if (!patch || !state.project) return;
  queueSave.pending = null;
  try {
    await api('PATCH', `/api/projects/${state.project.id}`, patch);
    if (state.project.plan) state.project.plan.stale = true;
  } catch (e) {
    fail(e);
  }
}
async function planUpdate(overrides) {
  await flushSave();
  state.project = await api('POST', `/api/projects/${state.project.id}/plan`, { overrides });
  render();
}
const analyze = (id) => runJob(`analyze:${id}`, () => api('POST', `/api/projects/${state.project.id}/references/${id}/analyze`));

const actions = {
  home: () => (location.hash = '#/'),
  'open-project': (el) => (location.hash = `#/p/${el.dataset.id}/references`),
  step: (el) => flushSave().then(() => go(el.dataset.step)),
  'open-capabilities': () => showCapabilities(true),
  'open-settings': showSettings,
  'close-modal': () => $('#modal').close(),
  'add-mode': (el) => { state.addMode = el.dataset.mode; state.classify = null; render(); },
  analyze: (el) => analyze(el.dataset.id),
  'remove-ref': async (el) => {
    if (!confirm('Remove this reference and its findings?')) return;
    state.project = await api('DELETE', `/api/projects/${state.project.id}/references/${el.dataset.id}`);
    render();
  },
  mode: (el) => {
    const row = el.closest('.el');
    const id = row.dataset.el;
    const note = $('[data-note]', row).value;
    state.project.selections[id] = { mode: el.dataset.mode, note };
    for (const b of $$('.seg button', row)) b.setAttribute('aria-pressed', String(b === el));
    row.classList.toggle('excluded', el.dataset.mode === 'exclude');
    $('.el-note', row).hidden = el.dataset.mode !== 'modify';
    if (el.dataset.mode === 'modify') $('[data-note]', row).focus();
    queueSave({ selections: { [id]: state.project.selections[id] } });
  },
  bulk: (el) => {
    const patch = {};
    for (const e of allElements().filter((x) => x.ref.id === el.dataset.ref)) patch[e.id] = state.project.selections[e.id] = { mode: el.dataset.mode, note: sel(e).note };
    queueSave({ selections: patch });
    render();
  },
  'make-plan': async () => { await planUpdate({}); go('plan'); },
  'approve-plan': async () => { await flushSave(); state.project = await api('POST', `/api/projects/${state.project.id}/plan/approve`); toast('Plan approved'); go('build'); },
  'remove-page': (el) => planUpdate({ removedPages: [...(state.project.planOverrides?.removedPages ?? []), el.dataset.id] }),
  'remove-revision': (el) => planUpdate({ removeRevision: Number(el.dataset.i) }),
  'reset-plan': () => confirm('Discard edits made on this screen and redraft from your selections?') && planUpdate({ reset: true }),
  'review-plan': () => {
    const text = $('[data-form="add-revision"] textarea').value.trim();
    if (!text) return toast('Type the note you want Claude to consider first.');
    state.view.reviewReply = null;
    runJob('plan-review', () => api('POST', `/api/projects/${state.project.id}/plan/review`, { instruction: text }), { done: (r) => (state.view.reviewReply = r.reply) });
  },
  build: () => {
    if (state.project.versions.length && !confirm('Rebuild from the plan? This creates a new version; existing versions are kept.')) return;
    state.view.version = null;
    runJob('build', () => api('POST', `/api/projects/${state.project.id}/build`, { engine: engine() }), { done: () => toast('New version ready') });
  },
  verify: (el) => runJob('verify', () => api('POST', `/api/projects/${state.project.id}/versions/${el.dataset.n}/verify`)),
  viewport: (el) => { state.view.viewport = el.dataset.size; render(); },
  'reload-preview': () => { const f = $('#preview'); f.src = f.src; },
  'preview-version': (el) => { state.view.version = Number(el.dataset.n); go('build'); },
  restore: (el) => confirm(`Create a new version that is a copy of v${el.dataset.n}?`) && runJob('build', () => api('POST', `/api/projects/${state.project.id}/versions/${el.dataset.n}/restore`), { done: () => { state.view.version = null; toast('Version restored'); } }),
  'view-code': async (el) => {
    state.view.files = await api('GET', `/api/projects/${state.project.id}/versions/${el.dataset.n}/files`);
    state.view.codeVersion = Number(el.dataset.n);
    state.view.codeFile = 'index.html' in state.view.files ? 'index.html' : Object.keys(state.view.files)[0];
    render();
  },
  'pick-file': (el) => { state.view.codeFile = el.dataset.file; render(); },
  'close-code': () => { state.view.codeVersion = null; state.view.files = null; render(); },
  'delete-project': async () => {
    if (!confirm(`Delete “${state.project.name}” with all its findings and versions? This cannot be undone.`)) return;
    await api('DELETE', `/api/projects/${state.project.id}`);
    location.hash = '#/';
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  Promise.resolve(actions[el.dataset.action]?.(el)).catch(fail);
});

const forms = {
  'new-project': async (data) => {
    const p = await api('POST', '/api/projects', data);
    location.hash = `#/p/${p.id}/references`;
  },
  'add-reference': async (data) => {
    const body = state.addMode === 'manual' ? { kind: 'manual', label: data.label, notes: data.notes } : { target: data.target, label: data.label, notes: data.notes };
    const ref = await api('POST', `/api/projects/${state.project.id}/references`, body);
    state.targetDraft = '';
    state.classify = null;
    await refreshProject();
    analyze(ref.id);
  },
  'add-revision': (data) => { state.view.reviewReply = null; return planUpdate({ addRevision: data.text }); },
  refine: async (data) => {
    const base = currentVersion().n;
    state.view.version = null;
    await runJob('build', () => api('POST', `/api/projects/${state.project.id}/refine`, { engine: engine(), request: data.request, version: base }), { done: () => toast('New version ready') });
  },
  settings: async (data, form) => {
    const patch = { model: data.model, effort: data.effort, headless: form.headless.checked, styleProbe: form.styleProbe.checked };
    if (data.apiKey) patch.apiKey = data.apiKey;
    else if (form.clearKey?.checked) patch.apiKey = '';
    state.settings = await api('POST', '/api/settings', patch);
    $('#modal').close();
    toast('Settings saved');
    render();
  },
};
document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  Promise.resolve(forms[form.dataset.form](Object.fromEntries(new FormData(form)), form)).catch(fail);
});

let classifyTimer;
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'target-input') {
    state.targetDraft = t.value;
    clearTimeout(classifyTimer);
    classifyTimer = setTimeout(async () => {
      state.classify = t.value.trim() ? await api('POST', '/api/classify', { target: t.value }).catch(() => null) : null;
      const box = $('#classify');
      if (box) box.innerHTML = classifyHtml(state.classify);
    }, 350);
  } else if (t.dataset.directive) {
    state.project.directives[t.dataset.directive] = t.value;
    queueSave({ directives: { [t.dataset.directive]: t.value } });
  } else if (t.dataset.note) {
    const id = t.dataset.note;
    state.project.selections[id] = { mode: 'modify', note: t.value };
    queueSave({ selections: { [id]: state.project.selections[id] } });
  }
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.id === 'ref-filter') { state.view.refFilter = t.value; render(); }
  else if (t.id === 'version-pick') { state.view.version = Number(t.value); render(); }
  else if (t.name === 'engine') { state.view.engine = t.value; render(); }
  else if (t.dataset.plan) planUpdate({ [t.dataset.plan]: t.value }).catch(fail);
  else if (t.dataset.theme) planUpdate({ theme: { [t.dataset.theme]: t.value } }).catch(fail);
  else if (t.dataset.pageTitle) planUpdate({ pageTitles: { [t.dataset.pageTitle]: t.value } }).catch(fail);
});
addEventListener('hashchange', () => flushSave().then(route));

// ---------- boot ----------
(async () => {
  try {
    [state.info, state.settings] = await Promise.all([api('GET', '/api/info'), api('GET', '/api/settings')]);
  } catch (e) {
    fail(e);
  }
  await route();
})();
