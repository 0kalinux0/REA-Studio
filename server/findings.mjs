// Turns REA Evidence into a flat inventory of selectable "elements" (features and design
// elements). Every element carries a provenance status so the UI can separate what REA
// actually observed from what the studio derived, probed itself, or merely guessed:
//
//   verified  – stated directly by REA Evidence (observed DOM/accessibility/static AST facts)
//   derived   – computed deterministically by the studio from REA Evidence (e.g. palette from
//               REA's screenshot, grouping of observed IPC channels)
//   probe     – read by the studio's own CDP style probe, NOT by REA
//   inferred  – a low-confidence inference (REA's own "inferences", or a studio heuristic)
//   user      – described by the user; nothing was inspected
import crypto from 'node:crypto';

export const STATUSES = ['verified', 'derived', 'probe', 'inferred', 'user'];

const clip = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const uniq = (a) => [...new Set(a)];

function makeElement(refId, e) {
  const h = crypto.createHash('sha1').update(`${e.category}|${e.kind}|${e.title}|${e.ordinal ?? ''}`).digest('hex').slice(0, 10);
  const { ordinal, ...rest } = e;
  return { id: `${refId}:${h}`, refId, items: [], data: {}, ...rest };
}

// ---------- accessibility tree helpers ----------
function buildTree(nodes) {
  const byId = new Map();
  for (const n of nodes) if (!n.ignored && n.role !== 'InlineTextBox') byId.set(n.node_id, { ...n, children: [] });
  const roots = [];
  const raw = new Map(nodes.map((x) => [x.node_id, x]));
  for (const n of byId.values()) {
    // Ignored ancestors are dropped by REA's flag; re-attach to the nearest retained ancestor.
    let p = n.parent_id;
    while (p != null && !byId.has(p)) p = raw.get(p)?.parent_id ?? null;
    if (p != null && byId.has(p)) byId.get(p).children.push(n);
    else roots.push(n);
  }
  return roots;
}
function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}
const descendants = (node, pred) => [...walk(node)].filter((n) => n !== node && pred(n));
const hasAncestorIn = (set, node, parents) => {
  for (let p = parents.get(node); p; p = parents.get(p)) if (set.has(p)) return true;
  return false;
};
const textOf = (node) => uniq(descendants(node, (n) => n.role === 'StaticText').map((n) => (n.name || '').trim()).filter(Boolean));
const label = (n) => (n.name || '').trim();
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'slider', 'switch', 'listbox', 'ComboBoxSelect', 'DateTime', 'Date']);

export function webPageElements(refId, page, src) {
  const out = [];
  const add = (e) => out.push(makeElement(refId, { status: 'verified', source: src, ...e }));
  const a11y = page.accessibility?.nodes ?? [];
  const textIncluded = page.accessibility?.text_capture?.status === 'included';
  const roots = buildTree(a11y);
  const all = roots.flatMap((r) => [...walk(r)]);
  const parents = new Map();
  for (const n of all) for (const c of n.children) parents.set(c, n);
  const byRole = (r) => all.filter((n) => n.role === r);

  // Page identity
  const h1 = byRole('heading').find((n) => n.states?.some((s) => s.name === 'level' && s.value === 1));
  add({
    category: 'page', kind: 'page', title: `Page “${clip(page.target?.title || page.target?.url || 'untitled', 60)}”`,
    detail: `${page.target?.url ?? ''}${h1 ? ` · main heading “${clip(label(h1), 50)}”` : ''}`,
    data: { url: page.target?.url, title: page.target?.title, h1: h1 ? label(h1) : null },
  });

  // Landmarks → layout
  const LANDMARKS = { banner: 'top bar (banner)', complementary: 'sidebar (complementary)', navigation: 'navigation', main: 'main content', contentinfo: 'footer', search: 'search', sectionheader: 'section header', sectionfooter: 'section footer' };
  const marks = all.filter((n) => LANDMARKS[n.role]);
  if (marks.length) {
    const order = marks.map((n) => `${LANDMARKS[n.role]}${label(n) ? ` “${label(n)}”` : ''}`);
    add({
      category: 'layout', kind: 'landmarks', title: `Page structure: ${uniq(marks.map((n) => LANDMARKS[n.role].split(' (')[0])).join(' + ')}`,
      detail: 'Landmark regions in document order, from the accessibility tree.', items: order,
      data: { landmarks: marks.map((n) => ({ role: n.role, name: label(n) })) },
    });
  }

  // Navigation
  const navs = byRole('navigation');
  const navSet = new Set(navs);
  navs.forEach((n, i) => {
    const links = descendants(n, (d) => d.role === 'link').map(label).filter(Boolean);
    const inside = hasAncestorIn(new Set(byRole('complementary')), n, parents) ? 'sidebar' : hasAncestorIn(new Set(byRole('banner')), n, parents) ? 'top bar' : null;
    add({
      category: 'navigation', kind: 'nav', ordinal: i, title: `Navigation${label(n) ? ` “${label(n)}”` : ''} (${links.length} link${links.length === 1 ? '' : 's'})`,
      detail: inside ? `Located in the ${inside}.` : 'Navigation landmark.', items: links, data: { label: label(n), items: links, placement: inside },
    });
  });

  // Named regions / card groups
  byRole('region').forEach((r, i) => {
    const cards = r.children.filter((c) => c.role === 'article');
    const headings = descendants(r, (d) => d.role === 'heading').map(label).filter(Boolean);
    if (cards.length >= 2) {
      const cardInfo = cards.map((c) => ({ heading: descendants(c, (d) => d.role === 'heading').map(label)[0] || '', text: textOf(c) }));
      add({
        category: 'section', kind: 'cards', ordinal: i, title: `Card group “${clip(label(r) || headings[0] || 'cards', 50)}” (${cards.length} cards)`,
        detail: 'Repeated article cards inside one region.', items: cardInfo.map((c) => c.heading || c.text[0] || 'card'), data: { label: label(r), cards: cardInfo },
      });
    } else if (label(r) || headings.length) {
      const contains = uniq(descendants(r, (d) => ['table', 'image', 'img', 'form', 'list', 'tablist', 'grid'].includes(d.role)).map((d) => d.role));
      add({
        category: 'section', kind: 'section', ordinal: i, title: `Section “${clip(label(r) || headings[0], 60)}”`,
        detail: contains.length ? `Contains: ${contains.join(', ')}.` : 'Named region.', items: headings, data: { label: label(r), headings, contains },
      });
    }
  });

  // Tables
  [...byRole('table'), ...byRole('grid')].forEach((t, i) => {
    const cols = descendants(t, (d) => d.role === 'columnheader').map(label).filter(Boolean);
    const rows = descendants(t, (d) => d.role === 'row').length;
    const region = (() => { for (let p = parents.get(t); p; p = parents.get(p)) if (p.role === 'region' && label(p)) return label(p); return null; })();
    add({
      category: 'feature', kind: 'table', ordinal: i, title: `Data table${region ? ` “${clip(region, 40)}”` : ''}${cols.length ? `: ${clip(cols.join(', '), 60)}` : ''}`,
      detail: `${cols.length} column(s), ${Math.max(0, rows - (cols.length ? 1 : 0))} data row(s) observed at capture time.`, items: cols, data: { name: region, columns: cols, rows },
    });
  });

  // Forms and search
  const formNodes = [...byRole('form'), ...byRole('search')];
  const formSet = new Set(formNodes);
  formNodes.forEach((f, i) => {
    const fields = descendants(f, (d) => FIELD_ROLES.has(d.role)).map((d) => ({ role: d.role, name: label(d) }));
    const buttons = descendants(f, (d) => d.role === 'button').map(label).filter(Boolean);
    const isSearch = f.role === 'search' || fields.some((x) => x.role === 'searchbox');
    add({
      category: 'feature', kind: isSearch ? 'search' : 'form', ordinal: i,
      title: isSearch ? `Search${fields[0]?.name ? ` “${clip(fields[0].name, 40)}”` : ''}` : `Form${label(f) ? ` “${clip(label(f), 40)}”` : ''} (${fields.length} field${fields.length === 1 ? '' : 's'})`,
      detail: buttons.length ? `Submit/actions: ${buttons.join(', ')}.` : 'No buttons observed inside the form.',
      items: fields.map((x) => `${x.name || '(unlabelled)'} · ${x.role}`), data: { label: label(f), fields, buttons },
    });
  });
  // Loose search boxes outside any form
  byRole('searchbox').filter((s) => !hasAncestorIn(formSet, s, parents)).forEach((s, i) =>
    add({ category: 'feature', kind: 'search', ordinal: `loose${i}`, title: `Search${label(s) ? ` “${clip(label(s), 40)}”` : ''}`, detail: 'Standalone search box.', items: [], data: { fields: [{ role: 'searchbox', name: label(s) }], buttons: [] } }));

  // Tabs
  byRole('tablist').forEach((t, i) => {
    const tabs = descendants(t, (d) => d.role === 'tab').map(label).filter(Boolean);
    add({ category: 'feature', kind: 'tabs', ordinal: i, title: `Tabs: ${clip(tabs.join(', '), 60)}`, detail: `${tabs.length} tab(s).`, items: tabs, data: { tabs } });
  });

  // Standalone actions
  const actions = byRole('button').filter((b) => label(b) && !hasAncestorIn(formSet, b, parents) && !hasAncestorIn(navSet, b, parents) && !hasAncestorIn(new Set(byRole('tablist')), b, parents));
  uniq(actions.map(label)).slice(0, 25).forEach((name) =>
    add({ category: 'feature', kind: 'action', title: `Action button “${clip(name, 50)}”`, detail: 'A button exists with this label. What it does was not observed.', data: { label: name } }));

  // Open dialogs
  [...byRole('dialog'), ...byRole('alertdialog')].forEach((d, i) =>
    add({ category: 'feature', kind: 'dialog', ordinal: i, title: `Dialog${label(d) ? ` “${clip(label(d), 40)}”` : ''}`, detail: 'Dialog was open at capture time.', items: textOf(d).slice(0, 12), data: { label: label(d) } }));

  // Media / charts
  const regionOf = (n) => { for (let p = parents.get(n); p; p = parents.get(p)) if (p.role === 'region' && label(p)) return label(p); return null; };
  const seenMedia = new Set();
  [...byRole('image'), ...byRole('img'), ...byRole('graphics-document')].filter((n) => label(n) && !seenMedia.has(label(n)) && seenMedia.add(label(n))).slice(0, 15).forEach((n) =>
    add({ category: 'section', kind: 'media', title: `Image or chart “${clip(label(n), 50)}”`, detail: 'Labelled graphic. Its pixels are not reproduced; only its role and label are known.', data: { label: label(n), region: regionOf(n) } }));

  // DOM-level signals (tag names only; REA does not retain attribute values or text)
  const tags = {};
  for (const n of page.dom?.nodes ?? []) if (n.node_type === 1) tags[n.node_name] = (tags[n.node_name] || 0) + 1;
  const notable = ['DIALOG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'svg', 'SVG', 'FORM', 'TABLE', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS'].filter((t) => tags[t]);
  if (notable.length) {
    add({
      category: 'tech', kind: 'dom', title: `DOM signals: ${notable.map((t) => `${tags[t]}× <${t.toLowerCase()}>`).join(', ')}`,
      detail: `${page.dom.total_nodes} DOM nodes. Tag names only — REA does not retain attribute values or text content.` + (tags.DIALOG ? ' Closed <dialog> elements exist but their contents were not exposed.' : ''),
      data: { tags },
    });
  }
  if (!textIncluded && a11y.length) out.forEach((e) => (e.detail += ' (Accessibility text was not captured.)'));

  // Client-side persistence
  const st = page.storage;
  if (st) {
    const keys = [...(st.local_storage_keys ?? []).map((k) => `localStorage: ${k.name ?? k}`), ...(st.session_storage_keys ?? []).map((k) => `sessionStorage: ${k.name ?? k}`), ...(st.indexed_db_names ?? []).map((k) => `IndexedDB: ${k.name ?? k}`), ...(st.cache_names ?? []).map((k) => `Cache: ${k.name ?? k}`)];
    if (keys.length) add({ category: 'data', kind: 'storage', title: `Client-side persistence (${keys.length} key${keys.length === 1 ? '' : 's'})`, detail: 'Key names only; REA redacts stored values.', items: keys.slice(0, 40), data: { keys } });
  }
  return out;
}

export function webBundleElements(refId, bundle, src) {
  const out = [];
  const add = (e) => out.push(makeElement(refId, { source: src, ...e }));
  const obs = bundle.observations ?? {};
  const routes = uniq([...(obs.routes ?? []).map((r) => r.value ?? r.pattern ?? r.path), ...(bundle.route_inventory?.routes ?? []).map((r) => r.pattern ?? r.value ?? r.path)].filter(Boolean));
  if (routes.length) add({ status: 'verified', category: 'page', kind: 'routes', title: `Client routes (${routes.length})`, detail: 'Route patterns found by static analysis of loaded scripts. Static candidates do not prove reachability or completeness.', items: routes.slice(0, 80), data: { routes } });
  const endpoints = uniq((obs.endpoints ?? []).map((e) => `${e.value}  [${e.mechanism}]`));
  if (endpoints.length) add({ status: 'verified', category: 'data', kind: 'endpoints', title: `API endpoints referenced in scripts (${endpoints.length})`, detail: 'Literal request targets found in script source. Request/response bodies were not observed.', items: endpoints.slice(0, 80), data: { endpoints: (obs.endpoints ?? []).map((e) => ({ value: e.value, mechanism: e.mechanism })) } });
  const byKind = {};
  for (const inf of bundle.inferences ?? []) (byKind[inf.kind] ??= []).push(inf);
  for (const [kind, list] of Object.entries(byKind)) {
    const vendor = /vendor|framework|library/i.test(kind);
    add({
      status: 'inferred', category: vendor ? 'tech' : 'data', kind: `inference:${kind}`, title: `REA inference — ${kind.replace(/_/g, ' ')} (${list.length})`,
      detail: 'Reported by REA as an inference, not an observation. Treat as a hint.', items: uniq(list.map((i) => `${i.value} · confidence ${i.confidence}`)).slice(0, 40), data: { inferences: list.map((i) => ({ value: i.value, confidence: i.confidence })) },
    });
  }
  const chunks = obs.chunks?.nodes?.length ?? 0;
  if (chunks) add({ status: 'verified', category: 'tech', kind: 'scripts', title: `${chunks} script(s) analysed, ${bundle.completeness?.parse_failures ?? 0} parse failure(s)`, detail: `Static bundle analysis status: ${bundle.completeness?.status ?? 'unknown'}.`, items: obs.chunks.nodes.map((n) => `${n.url} (${n.bytes} bytes)`).slice(0, 40), data: {} });
  return out;
}

export function paletteElement(refId, colors, src) {
  return makeElement(refId, {
    status: 'derived', source: { ...src, basis: 'Pixel histogram of the screenshot REA captured' }, category: 'design', kind: 'palette',
    title: `Colour palette (${colors.length} dominant colours)`, detail: 'Share of screenshot pixels. Says nothing about which colour plays which role.',
    items: colors.map((c) => `${c.hex} · ${(c.share * 100).toFixed(1)}%`), data: { colors },
  });
}

/** Elements from the studio's own CDP style probe. These are NOT REA findings. */
export function probeElements(refId, probe) {
  const src = { operation: 'studio_style_probe', evidenceId: null, basis: 'Computed styles read by the studio via CDP Runtime.evaluate (not REA)' };
  const out = [];
  const add = (e) => out.push(makeElement(refId, { status: 'probe', source: src, ...e }));
  if (probe.fonts?.length) add({ category: 'design', kind: 'typography', title: `Typography: ${clip(probe.fonts[0].family, 50)}`, detail: `Base text ${probe.body.fontSize} / ${probe.body.lineHeight}.`, items: probe.fonts.map((f) => `${f.family} · ${f.count} elements`), data: { fonts: probe.fonts, body: probe.body, headings: probe.headings } });
  const roles = [['Page background', probe.body?.background], ['Body text', probe.body?.color], ['Accent (most common link/button colour)', probe.accent], ['Surface (most common panel background)', probe.surface]].filter(([, v]) => v);
  if (roles.length) add({ category: 'design', kind: 'color-roles', title: `Colour roles: ${roles.map(([, v]) => v).slice(0, 4).join(' ')}`, detail: 'Computed colours with the role each plays on the page.', items: roles.map(([k, v]) => `${k}: ${v}`), data: { background: probe.body?.background, text: probe.body?.color, accent: probe.accent, surface: probe.surface, cssVariables: probe.cssVariables } });
  if (probe.radius || probe.shadow) add({ category: 'design', kind: 'shape', title: `Shape: ${probe.radius ? `corner radius ${probe.radius}` : 'square corners'}${probe.shadow ? ', shadows used' : ''}`, detail: 'Most common non-zero border radius across sampled elements.', data: { radius: probe.radius, shadow: probe.shadow } });
  if (probe.regions?.length) {
    const side = probe.regions.find((r) => r.kind === 'sidebar');
    const top = probe.regions.find((r) => r.kind === 'topbar');
    add({
      category: 'layout', kind: 'geometry', title: `Layout geometry: ${[side && `sidebar ${side.side} ${side.w}px`, top && `top bar ${top.h}px`, `viewport ${probe.viewport.w}×${probe.viewport.h}`].filter(Boolean).join(', ')}`,
      detail: 'Bounding boxes of the main structural regions.', items: probe.regions.map((r) => `${r.tag}${r.kind ? ` (${r.kind})` : ''}: ${r.w}×${r.h} at ${r.x},${r.y}`), data: { regions: probe.regions, viewport: probe.viewport, contentMaxWidth: probe.contentMaxWidth },
    });
  }
  return out;
}

// ---------- local JavaScript / Electron application ----------
export function jsAppElements(refId, app, src) {
  const out = [];
  const basis = 'Static AST analysis; runtime registration and reachability are unproven';
  const add = (e) => out.push(makeElement(refId, { status: 'verified', source: { ...src, basis }, ...e }));
  const nodes = app.graph?.nodes ?? [];
  const labels = (kind) => uniq(nodes.filter((n) => n.kind === kind).flatMap((n) => n.observations.map((o) => o.label)));
  const pkg = labels('package');
  const s = app.summary ?? {};
  add({
    category: 'tech', kind: 'app', title: `JavaScript application${pkg.length ? ` “${pkg[0]}”` : ''} (${app.format})`,
    detail: `${app.statistics?.parsed_javascript_files ?? 0} JS file(s) parsed, ${app.statistics?.parse_failures ?? 0} parse failure(s). Electron semantics: ${s.electron_semantics ?? 'n/a'}.`,
    items: [...labels('electron-main').map((l) => `main process: ${l}`), ...labels('electron-preload').map((l) => `preload: ${l}`), ...labels('electron-renderer').map((l) => `renderer page: ${l}`)], data: { summary: s },
  });
  const windows = labels('browser-window');
  if (windows.length) add({ category: 'layout', kind: 'windows', title: `${windows.length} application window(s)`, detail: 'BrowserWindow constructions found in the main process. Window contents are not rendered by static analysis.', items: windows, data: { count: windows.length } });
  for (const page of labels('electron-renderer')) add({ category: 'page', kind: 'page', title: `Renderer page “${page}”`, detail: 'HTML entry loaded by a window. Its visual layout was not observed (static analysis only).', data: { url: page, title: page } });

  const channels = uniq(nodes.filter((n) => n.kind === 'ipc-channel' || n.kind === 'ipc-handler').flatMap((n) => n.observations.map((o) => o.properties?.channel ?? o.label)).filter(Boolean));
  const groups = {};
  for (const c of channels) (groups[c.includes(':') ? c.split(':')[0] : c.includes('.') ? c.split('.')[0] : c.includes('-') ? c.split('-')[0] : 'general'] ??= []).push(c);
  for (const [g, list] of Object.entries(groups)) {
    add({
      status: 'derived', category: 'feature', kind: 'capability', title: `Capability “${g}” (${list.length} operation${list.length === 1 ? '' : 's'})`,
      detail: 'IPC channels REA observed, grouped by name prefix by the studio. Channel names are verified; what each does is implied only by its name.', items: list, data: { group: g, operations: list.map((c) => c.split(/[:.]/).slice(1).join(':') || c) },
    });
  }
  const apis = nodes.filter((n) => n.kind === 'context-bridge-api');
  for (const api of apis) {
    const name = api.observations[0]?.label;
    const members = uniq(nodes.filter((n) => n.kind === 'javascript-expression').flatMap((n) => n.observations.map((o) => o.label)).filter((l) => l.startsWith(`${name}.`)));
    add({ category: 'data', kind: 'bridge-api', title: `Renderer API “window.${name}” (${members.length} member${members.length === 1 ? '' : 's'})`, detail: 'Exposed to the UI through contextBridge.', items: members, data: { name, members } });
  }
  const routes = uniq((app.route_inventory?.routes ?? []).map((r) => r.pattern ?? r.value ?? r.path).filter(Boolean));
  if (routes.length) add({ category: 'page', kind: 'routes', title: `Client routes (${routes.length})`, detail: 'Route patterns found by static analysis. Static candidates do not prove reachability.', items: routes.slice(0, 80), data: { routes } });
  const mods = uniq(labels('javascript-module').filter((m) => !/^[./]/.test(m) && !m.endsWith('.js')));
  if (mods.length) add({ category: 'tech', kind: 'modules', title: `External modules imported (${mods.length})`, detail: 'Module specifiers imported by the analysed code.', items: mods.slice(0, 60), data: { modules: mods } });
  return out;
}

export function desktopElements(refId, desk, src) {
  const out = [];
  const add = (e) => out.push(makeElement(refId, { status: 'verified', source: src, ...e }));
  const families = uniq((desk.candidates ?? []).map((c) => c.family ?? c.kind ?? c.name).filter(Boolean));
  const files = desk.files ?? [];
  add({
    category: 'tech', kind: 'installation', title: families.length ? `Runtime candidates: ${families.join(', ')}` : 'No known runtime family recognised',
    detail: `${desk.coverage?.entries_examined ?? files.length} directory entries examined (${desk.coverage?.status ?? 'unknown'}). Candidates do not establish what code actually runs.`,
    items: files.filter((f) => f.kind === 'file').slice(0, 40).map((f) => f.path), data: { families, nextProbes: (desk.next_probes ?? []).map((p) => p.operation ?? p.tool ?? p.kind) },
  });
  return out;
}

export function manualElements(refId, text) {
  return String(text || '').split('\n').map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 60).map((line, i) =>
    makeElement(refId, { status: 'user', source: { operation: 'user_description', evidenceId: null, basis: 'Typed by you; nothing was inspected' }, category: 'feature', kind: 'described', ordinal: i, title: clip(line, 90), detail: 'Described by you. Not verified against the target.', data: { text: line } }));
}
