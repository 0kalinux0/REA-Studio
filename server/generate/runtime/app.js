// Application runtime. Everything the app shows is described in spec.js; edit that file to
// change pages, navigation, widgets or theme. Data is stored in this browser (localStorage).
import { spec } from './spec.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const words = (entity) => String(entity).replace(/-/g, ' ');
const key = (label) => String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'field';

// ---- storage ----
const NS = `app:${key(spec.appName)}:`;
const store = {
  read(name, fallback) {
    try {
      const raw = localStorage.getItem(NS + name);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  write(name, value) {
    try {
      localStorage.setItem(NS + name, JSON.stringify(value));
    } catch {
      toast('Could not save: browser storage is unavailable.');
    }
  },
};

function records(entity, columns) {
  let rows = store.read(`records:${entity}`, null);
  if (!rows) {
    rows = [1, 2, 3].map((i) => {
      const row = { id: crypto.randomUUID() };
      columns.forEach((c, ci) => (row[key(c)] = ci === 0 ? `Sample ${words(entity)} ${i}` : '—'));
      return row;
    });
    store.write(`records:${entity}`, rows);
  }
  return rows;
}
const saveRecords = (entity, rows) => store.write(`records:${entity}`, rows);

// ---- feedback ----
let toastTimer;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function recordDialog(title, columns, initial, onSave) {
  const dlg = h('dialog', { class: 'dialog' });
  const form = h('form', { method: 'dialog' }, h('h2', {}, title),
    columns.map((c) => h('label', {}, c, h('input', { name: key(c), value: initial?.[key(c)] && initial[key(c)] !== '—' ? initial[key(c)] : '', required: columns.indexOf(c) === 0 }))),
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'submit', value: 'save' }, 'Save')));
  form.addEventListener('submit', () => {
    const data = Object.fromEntries(new FormData(form));
    for (const c of columns) if (!data[key(c)]) data[key(c)] = '—';
    onSave(data);
  });
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  form.querySelector('input')?.focus();
}

// ---- widgets ----
const state = { query: '' };
const adders = new Map(); // entity -> function that opens its "add" dialog

function tableWidget(w, rerender) {
  const cols = w.columns;
  let rows = records(w.entity, cols);
  let sort = store.read(`sort:${w.entity}`, null);
  const body = h('tbody');
  const count = h('span', { class: 'muted' });
  const add = () => recordDialog(`New ${words(w.entity)}`, cols, null, (data) => {
    rows = [{ id: crypto.randomUUID(), ...data }, ...rows];
    saveRecords(w.entity, rows);
    toast('Saved');
    rerender();
  });
  adders.set(w.entity, add);
  const draw = () => {
    const q = state.query.trim().toLowerCase();
    let view = q ? rows.filter((r) => cols.some((c) => String(r[key(c)] ?? '').toLowerCase().includes(q))) : [...rows];
    if (sort) view.sort((a, b) => String(a[sort.col] ?? '').localeCompare(String(b[sort.col] ?? ''), undefined, { numeric: true }) * (sort.dir === 'asc' ? 1 : -1));
    body.replaceChildren(...view.map((r) => h('tr', {},
      cols.map((c) => h('td', {}, r[key(c)] ?? '')),
      h('td', { class: 'actions' },
        h('button', { class: 'ghost small', onclick: () => recordDialog(`Edit ${words(w.entity)}`, cols, r, (data) => { Object.assign(r, data); saveRecords(w.entity, rows); draw(); toast('Updated'); }) }, 'Edit'),
        h('button', { class: 'ghost small danger', onclick: () => { if (!confirm('Delete this row?')) return; rows = rows.filter((x) => x.id !== r.id); saveRecords(w.entity, rows); rerender(); } }, 'Delete')))));
    if (!view.length) body.append(h('tr', {}, h('td', { colSpan: cols.length + 1, class: 'muted center' }, q ? 'No rows match your search.' : 'Nothing here yet.')));
    count.textContent = `${view.length} of ${rows.length}`;
  };
  const head = h('tr', {}, cols.map((c) => h('th', {}, h('button', { class: 'sort', title: 'Sort', onclick: () => { sort = sort?.col === key(c) && sort.dir === 'asc' ? { col: key(c), dir: 'desc' } : { col: key(c), dir: 'asc' }; store.write(`sort:${w.entity}`, sort); draw(); } }, c))), h('th', {}));
  draw();
  return h('section', { class: 'panel' },
    h('div', { class: 'row between' }, h('h2', {}, w.title), h('div', { class: 'row' }, count, h('button', { onclick: add }, `Add ${words(w.entity)}`))),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, head), body)));
}

function capabilityWidget(w, rerender) {
  const cols = ['Title', 'Details'];
  const ops = w.operations.map((o) => o.toLowerCase());
  const can = (re) => ops.some((o) => re.test(o));
  const extra = w.operations.filter((o) => !/list|get|read|load|fetch|save|create|add|new|update|edit|delete|remove|export/i.test(o));
  const panel = tableWidget({ ...w, title: w.title.replace(/^./, (m) => m.toUpperCase()), columns: cols }, rerender);
  const bar = h('div', { class: 'row wrap' });
  if (can(/export/)) {
    bar.append(h('button', { class: 'ghost', onclick: () => {
      const blob = new Blob([JSON.stringify(records(w.entity, cols), null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `${w.entity}-export.json` });
      a.click();
      URL.revokeObjectURL(a.href);
    } }, 'Export as JSON'));
  }
  for (const op of extra) bar.append(h('button', { class: 'ghost', disabled: true, title: 'This operation exists in the reference but was not rebuilt.' }, `${op} (not built)`));
  if (bar.children.length) panel.append(bar);
  return panel;
}

function statsWidget(w) {
  const tables = spec.pages.flatMap((p) => p.widgets).filter((x) => x.type === 'table' || x.type === 'capability');
  return h('section', {}, h('h2', {}, w.title), h('div', { class: 'cards' }, w.cards.map((c) => {
    const match = tables.find((t) => key(c.label).includes(t.entity) || t.entity.includes(key(c.label).replace(/s$/, '')));
    const value = match ? store.read(`records:${match.entity}`, []).length : '—';
    return h('article', { class: 'card' }, h('h3', {}, c.label), h('p', { class: 'value' }, String(value)), h('p', { class: 'muted small' }, match ? `rows in ${match.title}` : 'no data source yet'));
  })));
}

function chartWidget(w) {
  const tables = spec.pages.flatMap((p) => p.widgets).filter((x) => x.type === 'table' || x.type === 'capability');
  const series = tables.map((t) => ({ label: t.title, value: store.read(`records:${t.entity}`, []).length }));
  const data = series.length ? series : [{ label: 'No data', value: 0 }];
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 420, H = 150, bw = Math.min(70, (W - 20) / data.length - 12);
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': w.title, class: 'chart' });
  data.forEach((d, i) => {
    const bh = (d.value / max) * (H - 40);
    const x = 14 + i * (bw + 12);
    chart.append(svg('rect', { x, y: H - 22 - bh, width: bw, height: Math.max(2, bh), rx: 4, class: 'bar' }));
    const t = svg('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'tick' });
    t.textContent = `${d.label.slice(0, 12)} (${d.value})`;
    chart.append(t);
  });
  return h('section', { class: 'panel' }, h('h2', {}, w.title), chart, h('p', { class: 'muted small' }, 'Shows row counts from this app’s own tables.'));
}

function formWidget(w) {
  const entries = store.read(`form:${key(w.title)}`, []);
  const count = h('p', { class: 'muted small' }, `${entries.length} submission(s) stored in this browser.`);
  const radios = w.fields.filter((f) => f.type === 'radio');
  const others = w.fields.filter((f) => f.type !== 'radio');
  const form = h('form', { class: 'stack' },
    radios.length ? h('fieldset', {}, h('legend', {}, 'Choose one'), radios.map((f) => h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'choice', value: f.label, required: true }), f.label))) : null,
    others.map((f) => {
      const name = key(f.label);
      if (f.type === 'checkbox' || f.type === 'switch') return h('label', { class: 'inline' }, h('input', { type: 'checkbox', name }), f.label);
      if (f.type === 'slider') return h('label', {}, f.label, h('input', { type: 'range', name }));
      if (f.type === 'spinbutton') return h('label', {}, f.label, h('input', { type: 'number', name }));
      if (/comment|message|note|description|details/i.test(f.label)) return h('label', {}, f.label, h('textarea', { name, rows: 3 }));
      return h('label', {}, f.label, h('input', { name, type: /e-?mail/i.test(f.label) ? 'email' : /password/i.test(f.label) ? 'password' : 'text' }));
    }),
    h('div', {}, h('button', { type: 'submit' }, w.submit)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    entries.push({ at: new Date().toISOString(), ...Object.fromEntries(new FormData(form)) });
    store.write(`form:${key(w.title)}`, entries);
    count.textContent = `${entries.length} submission(s) stored in this browser.`;
    form.reset();
    toast('Submitted');
  });
  return h('section', { class: 'panel' }, h('h2', {}, w.title), form, count);
}

function tabsWidget(w) {
  const saved = store.read(`tab:${key(w.tabs.join('-'))}`, 0);
  const panel = h('div', { class: 'tabpanel', role: 'tabpanel' });
  const buttons = w.tabs.map((t, i) => h('button', { role: 'tab', class: 'tab', onclick: () => select(i) }, t));
  function select(i) {
    buttons.forEach((b, bi) => b.setAttribute('aria-selected', String(bi === i)));
    panel.textContent = `Content for “${w.tabs[i]}” goes here.`;
    store.write(`tab:${key(w.tabs.join('-'))}`, i);
  }
  select(Math.min(saved, w.tabs.length - 1));
  return h('section', { class: 'panel' }, h('div', { role: 'tablist', class: 'tabs' }, buttons), panel);
}

function actionWidget(w) {
  return h('button', { onclick: () => {
    if (/new|add|create/i.test(w.label) && adders.size) {
      const wanted = [...adders.keys()].find((e) => w.label.toLowerCase().includes(e)) ?? [...adders.keys()][0];
      adders.get(wanted)();
    } else toast(`“${w.label}” is not wired up yet.`);
  } }, w.label);
}

const sectionWidget = (w) => h('section', { class: 'panel' }, h('h2', {}, w.title), w.text ? h('p', { class: 'muted' }, w.text) : null);

function renderWidget(w, rerender) {
  switch (w.type) {
    case 'table': return tableWidget(w, rerender);
    case 'capability': return capabilityWidget(w, rerender);
    case 'stats': return statsWidget(w);
    case 'chart': return chartWidget(w);
    case 'form': return formWidget(w);
    case 'tabs': return tabsWidget(w);
    case 'section': return sectionWidget(w);
    default: return null;
  }
}

// ---- shell & routing ----
function currentPage() {
  const id = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  return spec.pages.find((p) => p.id === id) ?? spec.pages[0];
}

function render() {
  const page = currentPage();
  adders.clear();
  document.title = `${page.title} · ${spec.appName}`;
  document.body.dataset.nav = spec.navigation.placement;
  const nav = h('nav', { 'aria-label': 'Main' }, spec.navigation.items.map((i) =>
    h('a', { href: `#/${i.pageId}`, class: i.pageId === page.id ? 'active' : '', 'aria-current': i.pageId === page.id ? 'page' : null }, i.label)));
  const brand = h('div', { class: 'brand' }, spec.appName);
  const search = page.widgets.find((w) => w.type === 'search');
  const actions = page.widgets.filter((w) => w.type === 'action');
  const content = h('div', { class: 'content' });
  const drawContent = () => content.replaceChildren(...page.widgets.filter((w) => !['search', 'action'].includes(w.type)).map((w) => renderWidget(w, drawContent)).filter(Boolean));
  drawContent();
  const searchBox = search ? h('input', { type: 'search', placeholder: search.placeholder, 'aria-label': search.placeholder, value: state.query, oninput: (e) => { state.query = e.target.value; drawContent(); } }) : null;
  const header = h('header', { class: 'pagehead' }, h('h1', {}, page.title), searchBox, actions.map(actionWidget));
  const shell = spec.navigation.placement === 'sidebar'
    ? [h('aside', { class: 'sidebar' }, brand, nav), h('main', {}, header, content)]
    : [h('header', { class: 'topbar' }, brand, nav), h('main', {}, header, content)];
  $('#app').replaceChildren(...shell);
}

addEventListener('hashchange', () => { state.query = ''; render(); });
render();
