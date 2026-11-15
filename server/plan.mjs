// Builds the reviewable plan ("spec") from the selected elements and plain-language directives.
// The spec is the single contract between review and implementation: both build engines
// (Claude and the offline scaffold) implement exactly what is in it.

export const DEFAULT_MODE = (el) => (el.status === 'inferred' || el.category === 'tech' ? 'exclude' : 'include');

export function selectionFor(project, el) {
  const s = project.selections[el.id];
  return { mode: s?.mode ?? DEFAULT_MODE(el), note: s?.note ?? '' };
}

export function selectedElements(project) {
  const out = [];
  for (const ref of project.references) {
    for (const el of ref.elements ?? []) {
      const sel = selectionFor(project, el);
      out.push({ ...el, ...sel, refLabel: ref.label });
    }
  }
  return out;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
const singular = (s) => s.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function saturation(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mx = Math.max(...c), mn = Math.min(...c);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

const NAMED = { blue: '#2563eb', green: '#16a34a', red: '#dc2626', purple: '#7c3aed', violet: '#7c3aed', orange: '#ea580c', teal: '#0d9488', pink: '#db2777', yellow: '#ca8a04', indigo: '#4f46e5', cyan: '#0891b2', black: '#111827' };
const DARK = { mode: 'dark', background: '#0f1419', surface: '#1a2129', text: '#e6e9ee' };
const LIGHT = { mode: 'light', background: '#f6f7f9', surface: '#ffffff', text: '#1c2430' };

/**
 * The offline scaffold can only act on a small vocabulary of plain-language instructions.
 * Anything it cannot interpret is returned in `unapplied` so the gap is visible in the plan.
 */
export function interpretDirectives(directives, theme, navigation) {
  const applied = [];
  const unapplied = [];
  const sentences = (t) => String(t || '').split(/[.\n;]+/).map((s) => s.trim()).filter(Boolean);
  const tryTheme = (s) => {
    let hit = false;
    const l = s.toLowerCase();
    if (/\bdark\b/.test(l)) { Object.assign(theme, DARK); hit = true; }
    else if (/\b(light|white|bright)\b/.test(l)) { Object.assign(theme, LIGHT); hit = true; }
    const hex = /#[0-9a-f]{6}\b/i.exec(s);
    if (hex) { theme.accent = hex[0].toLowerCase(); hit = true; }
    else for (const [name, value] of Object.entries(NAMED)) if (new RegExp(`\\b${name}\\b`).test(l) && /(accent|primary|brand|colou?r|theme|buttons?|highlight)/.test(l)) { theme.accent = value; hit = true; break; }
    if (/\b(rounded|pill|soft)\b/.test(l)) { theme.radius = '14px'; hit = true; }
    else if (/\b(square|sharp|no rounding)\b/.test(l)) { theme.radius = '0px'; hit = true; }
    if (/\bserif\b/.test(l) && !/sans/.test(l)) { theme.font = 'Georgia, "Times New Roman", serif'; hit = true; }
    else if (/\b(monospace|mono)\b/.test(l)) { theme.font = 'ui-monospace, "SF Mono", Menlo, monospace'; hit = true; }
    else if (/\bsans\b/.test(l)) { theme.font = 'system-ui, -apple-system, "Segoe UI", sans-serif'; hit = true; }
    if (/\b(compact|dense)\b/.test(l)) { theme.density = 'compact'; hit = true; }
    return hit;
  };
  const tryNav = (s) => {
    const l = s.toLowerCase();
    if (/\b(sidebar|side nav|side menu|left (nav|menu|rail)|vertical)\b/.test(l)) { navigation.placement = 'sidebar'; return true; }
    if (/\b(top ?bar|top nav|top menu|header nav|horizontal|navbar)\b/.test(l)) { navigation.placement = 'topbar'; return true; }
    return false;
  };
  for (const [key, text] of Object.entries(directives || {})) {
    for (const s of sentences(text)) {
      const hit = key === 'functionality' ? false : (tryTheme(s) | tryNav(s)) > 0;
      (hit ? applied : unapplied).push({ area: key, text: s });
    }
  }
  return { applied, unapplied };
}

function widgetFor(el) {
  const base = { elementId: el.id, note: el.mode === 'modify' ? el.note : '', status: el.status, from: el.refLabel };
  const d = el.data || {};
  switch (el.kind) {
    case 'cards': return { ...base, type: 'stats', title: d.label || 'Overview', cards: (d.cards || []).map((c) => ({ label: c.heading || c.text?.[0] || 'Metric' })) };
    case 'table': return { ...base, type: 'table', title: d.name || 'Records', entity: slug(singular(d.name || d.columns?.[0] || 'record')), columns: d.columns?.length ? d.columns : ['Name', 'Details'] };
    case 'form': return { ...base, type: 'form', title: d.label || 'Form', fields: (d.fields || []).map((f) => ({ label: f.name || 'Field', type: f.role })), submit: d.buttons?.[0] || 'Submit' };
    case 'search': return { ...base, type: 'search', placeholder: d.fields?.[0]?.name || 'Search' };
    case 'tabs': return { ...base, type: 'tabs', tabs: d.tabs || [] };
    case 'action': return { ...base, type: 'action', label: d.label };
    case 'dialog': return { ...base, type: 'section', title: d.label || 'Dialog', text: 'A dialog was open in the reference here.' };
    case 'media': return { ...base, type: 'chart', title: d.label || 'Chart' };
    case 'section': return { ...base, type: 'section', title: d.label || d.headings?.[0] || 'Section', text: '' };
    case 'capability': return { ...base, type: 'capability', title: d.group, entity: slug(singular(d.group || 'item')), operations: d.operations || [] };
    case 'described': return { ...base, type: 'section', title: d.text, text: 'Described by you; needs the AI build engine or a follow-up request to implement.', described: true };
    default: return null;
  }
}

export function buildPlan(project) {
  const all = selectedElements(project);
  const chosen = all.filter((e) => e.mode !== 'exclude');
  const excluded = all.filter((e) => e.mode === 'exclude' && e.category !== 'tech' && e.status !== 'inferred').map((e) => ({ title: e.title, from: e.refLabel }));
  const assumptions = [];

  // ---- theme ----
  const theme = { ...LIGHT, accent: '#2563eb', font: 'system-ui, -apple-system, "Segoe UI", sans-serif', radius: '8px', density: 'comfortable', source: 'studio default' };
  const roles = chosen.find((e) => e.kind === 'color-roles');
  const pal = chosen.find((e) => e.kind === 'palette');
  if (roles) {
    const d = roles.data;
    Object.assign(theme, { background: d.background || theme.background, text: d.text || theme.text, surface: d.surface || theme.surface, accent: d.accent || theme.accent, source: `${roles.refLabel} (studio style probe)` });
    theme.mode = luminance(theme.background) < 0.4 ? 'dark' : 'light';
  } else if (pal?.data.colors?.length) {
    const cs = pal.data.colors.map((c) => c.hex);
    theme.background = cs[0];
    theme.mode = luminance(cs[0]) < 0.4 ? 'dark' : 'light';
    Object.assign(theme, theme.mode === 'dark' ? { text: DARK.text } : { text: LIGHT.text });
    theme.surface = cs[1] || theme.surface;
    const acc = [...cs].sort((a, b) => saturation(b) - saturation(a))[0];
    if (acc && saturation(acc) > 0.3) theme.accent = acc;
    theme.source = `${pal.refLabel} (palette derived from REA screenshot)`;
    assumptions.push('Colour roles (which colour is background, surface, accent) were guessed from pixel share and saturation.');
  } else assumptions.push('No design element was selected, so the theme uses studio defaults.');
  const typo = chosen.find((e) => e.kind === 'typography');
  if (typo?.data.fonts?.[0]) theme.font = `"${typo.data.fonts[0].family}", system-ui, sans-serif`;
  const shape = chosen.find((e) => e.kind === 'shape');
  if (shape?.data.radius) theme.radius = shape.data.radius;

  // ---- navigation ----
  const navs = chosen.filter((e) => e.kind === 'nav' && e.data.items?.length >= 2 && !/breadcrumb/i.test(e.data.label || ''));
  const nav = navs.sort((a, b) => b.data.items.length - a.data.items.length)[0];
  const navigation = { placement: 'sidebar', items: [], source: nav ? nav.refLabel : 'generated from selected features' };
  if (nav) {
    const geo = project.references.find((r) => r.id === nav.refId)?.elements?.find((e) => e.kind === 'geometry');
    navigation.placement = nav.data.placement === 'top bar' ? 'topbar' : nav.data.placement === 'sidebar' ? 'sidebar' : geo?.data.regions?.some((r) => r.kind === 'sidebar') ? 'sidebar' : 'topbar';
    if (navs.length > 1) assumptions.push(`Several navigation menus were selected; “${nav.title}” is used as the primary one. Exclude the others or say which should win.`);
  }

  const { applied, unapplied } = interpretDirectives(project.directives, theme, navigation);
  // Edits made directly in the plan review screen win over everything else.
  const o = project.planOverrides || {};
  if (o.theme) Object.assign(theme, o.theme);
  if (o.placement) navigation.placement = o.placement;

  // ---- pages & widgets ----
  const widgets = chosen.map(widgetFor).filter(Boolean);
  const pages = [];
  const addPage = (title, extra = {}) => {
    let id = slug(title);
    while (pages.some((p) => p.id === id)) id += '-2';
    const page = { id, title, widgets: [], ...extra };
    pages.push(page);
    return page;
  };
  if (nav) for (const item of nav.data.items) addPage(item);
  const caps = widgets.filter((w) => w.type === 'capability');
  if (!pages.length) {
    if (caps.length) for (const c of caps) addPage(c.title.replace(/^./, (m) => m.toUpperCase()));
    else addPage('Home');
  }
  const home = pages[0];
  const matchPage = (name) => pages.find((p) => { const a = singular(p.title), b = singular(String(name || '')); return a && b && (a === b || b.includes(a) || a.includes(b)); });
  for (const w of widgets) {
    let page = home;
    if (w.type === 'capability') page = matchPage(w.title) || addPage(w.title.replace(/^./, (m) => m.toUpperCase()));
    else if (w.type === 'table') {
      const own = matchPage(w.title) || matchPage(w.entity);
      if (own && own !== home) own.widgets.push({ ...w, elementId: w.elementId, mirrored: true });
    }
    page.widgets.push(w);
  }
  for (const p of pages) {
    if (!p.widgets.length) {
      p.placeholder = true;
      p.widgets.push({ type: 'section', title: p.title, text: 'This page appeared in the reference navigation but its contents were not observed. Describe what belongs here to have it built.' });
    }
  }
  for (const id of o.removedPages || []) {
    const i = pages.findIndex((p) => p.id === id);
    if (i >= 0 && pages.length > 1) pages.splice(i, 1);
  }
  for (const p of pages) if (o.pageTitles?.[p.id]) p.title = o.pageTitles[p.id];
  const empty = pages.filter((p) => p.placeholder).map((p) => p.title);
  if (empty.length) assumptions.push(`Pages listed in navigation but never observed get a placeholder: ${empty.join(', ')}. Add those pages as references or describe them.`);
  navigation.items = pages.map((p) => ({ label: p.title, pageId: p.id }));

  for (const w of widgets) if (w.type === 'action') assumptions.push(`What the “${w.label}” button does was not observed; it is wired to the nearest matching feature or left as a stub.`);
  if (widgets.some((w) => w.type === 'table')) assumptions.push('Table rows are stored locally in the browser and seeded with placeholder data. Reference data and server APIs are not copied.');
  if (widgets.some((w) => w.type === 'capability')) assumptions.push('Desktop capabilities are rebuilt as browser-based record managers; operations are inferred from channel names.');

  const refsUsed = [...new Set(chosen.map((e) => e.refLabel))];
  return {
    appName: o.appName || project.name,
    summary: o.summary || project.brief || `Custom application combining selected features from ${refsUsed.join(', ') || 'your description'}.`,
    theme, navigation, pages,
    features: chosen.filter((e) => !['design', 'tech'].includes(e.category)).map((e) => ({ elementId: e.id, title: e.title, mode: e.mode, note: e.note, status: e.status, from: e.refLabel, category: e.category })),
    design: chosen.filter((e) => e.category === 'design').map((e) => ({ title: e.title, status: e.status, from: e.refLabel, mode: e.mode, note: e.note })),
    excluded, assumptions,
    instructions: { ...project.directives },
    directiveReport: { applied, unapplied },
    modifications: chosen.filter((e) => e.mode === 'modify' && e.note).map((e) => ({ title: e.title, note: e.note })),
    generatedAt: new Date().toISOString(),
    approved: false,
    revisions: o.revisions ?? [],
  };
}

/** Text digest of the plan and its evidence, used as the brief for the AI build engine. */
export function planBrief(project, plan) {
  const lines = [];
  lines.push(`APP NAME: ${plan.appName}`, `GOAL: ${plan.summary}`, '');
  lines.push('THEME:', JSON.stringify(plan.theme), '');
  lines.push(`NAVIGATION (${plan.navigation.placement}): ${plan.navigation.items.map((i) => i.label).join(' | ')}`, '');
  lines.push('PAGES AND WIDGETS:');
  for (const p of plan.pages) {
    lines.push(`- Page "${p.title}"${p.placeholder ? ' (not observed in any reference — design something sensible and say so in NOTES)' : ''}`);
    for (const w of p.widgets) lines.push(`    • ${JSON.stringify({ ...w, elementId: undefined })}`);
  }
  lines.push('', 'SELECTED ELEMENTS WITH PROVENANCE (verified = observed by REA; derived/probe = computed from observations; inferred/user = not observed):');
  for (const el of selectedElements(project).filter((e) => e.mode !== 'exclude')) {
    lines.push(`- [${el.status}] (${el.refLabel}) ${el.title}${el.items?.length ? ` :: ${el.items.slice(0, 30).join(' | ')}` : ''}${el.mode === 'modify' && el.note ? `\n    USER MODIFICATION: ${el.note}` : ''}`);
  }
  if (plan.excluded.length) lines.push('', 'EXPLICITLY EXCLUDED (do not build): ' + plan.excluded.map((e) => e.title).join('; '));
  const ins = Object.entries(plan.instructions || {}).filter(([, v]) => v?.trim());
  if (ins.length) {
    lines.push('', 'USER INSTRUCTIONS (these override anything observed in a reference):');
    for (const [k, v] of ins) lines.push(`- ${k}: ${v.trim()}`);
  }
  if (plan.revisions?.length) lines.push('', 'PLAN REVISION NOTES FROM THE USER:', ...plan.revisions.map((r) => `- ${r}`));
  return lines.join('\n');
}
