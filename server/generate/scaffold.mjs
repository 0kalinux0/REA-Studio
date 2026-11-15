// Offline build engine. Deterministically turns an approved plan into a working static app
// (a fixed, readable runtime plus a spec.js describing this particular app). It needs no API
// key, but it can only honour a small vocabulary of plain-language instructions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretDirectives } from '../plan.mjs';

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime');
const read = (f) => fs.readFileSync(path.join(RUNTIME, f), 'utf8');

function mix(a, b, t) {
  const p = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const HEX = /^#[0-9a-f]{6}$/i;
const safeHex = (v, fallback) => (HEX.test(String(v)) ? v.toLowerCase() : fallback);
const safeCss = (v, fallback) => (/^[\w\s",.\-()%]+$/.test(String(v)) ? v : fallback);

export function themeCss(theme) {
  const bg = safeHex(theme.background, '#f6f7f9');
  const text = safeHex(theme.text, lum(bg) < 0.4 ? '#e6e9ee' : '#1c2430');
  const surface = safeHex(theme.surface, lum(bg) < 0.4 ? mix(bg, '#ffffff', 0.06) : '#ffffff');
  const accent = safeHex(theme.accent, '#2563eb');
  const compact = theme.density === 'compact';
  return `:root {
  --bg: ${bg};
  --surface: ${surface};
  --text: ${text};
  --accent: ${accent};
  --on-accent: ${lum(accent) > 0.55 ? '#10151c' : '#ffffff'};
  --line: ${mix(surface, text, 0.16)};
  --hover: ${mix(surface, text, 0.07)};
  --font: ${safeCss(theme.font, 'system-ui, sans-serif')};
  --radius: ${safeCss(theme.radius, '8px')};
  --size: ${compact ? '14px' : '15px'};
  --gap: ${compact ? '14px' : '22px'};
  --pad: ${compact ? '12px' : '18px'};
  --cell: ${compact ? '6px' : '10px'};
  color-scheme: ${lum(bg) < 0.4 ? 'dark' : 'light'};
}
`;
}

export function buildScaffold(plan) {
  const spec = {
    appName: plan.appName,
    summary: plan.summary,
    navigation: plan.navigation,
    pages: plan.pages.map((p) => ({ id: p.id, title: p.title, widgets: p.widgets.map(({ elementId, status, from, mirrored, described, ...w }) => w) })),
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const files = {
    'index.html': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(plan.appName)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<div id="app"></div>
<div id="toast" role="status" aria-live="polite"></div>
<script type="module" src="app.js"></script>
</body>
</html>
`,
    'styles.css': themeCss(plan.theme) + '\n' + read('styles.css'),
    'app.js': read('app.js'),
    'spec.js': `// Generated from the approved plan. Edit freely: app.js renders whatever is described here.\nexport const spec = ${JSON.stringify(spec, null, 2)};\n`,
  };
  const notes = [];
  for (const u of plan.directiveReport?.unapplied ?? []) notes.push(`Instruction not applied by the offline engine (${u.area}): “${u.text}”`);
  for (const m of plan.modifications ?? []) notes.push(`Modification not applied by the offline engine: ${m.title} → “${m.note}”`);
  for (const r of plan.revisions ?? []) notes.push(`Plan revision note not applied by the offline engine: “${r}”`);
  for (const p of plan.pages) for (const w of p.widgets) if (w.described) notes.push(`Feature you described is only a placeholder: “${w.title}”`);
  return { files, notes };
}

/**
 * Offline refinement: understands theme/navigation vocabulary plus a few structural commands.
 * Mutates `overrides` (the project's plan overrides) and reports what it could not do.
 */
export function refineOffline(request, plan, overrides) {
  const applied = [];
  const unapplied = [];
  overrides.theme ??= {};
  overrides.pageTitles ??= {};
  overrides.removedPages ??= [];
  const findPage = (name) => plan.pages.find((p) => p.title.toLowerCase() === name.toLowerCase().trim());
  for (const raw of String(request).split(/[.\n;]+/).map((s) => s.trim()).filter(Boolean)) {
    let m;
    if ((m = /^(?:rename|call) (?:the )?(?:app|application|product|it)(?: to)? ["“]?(.+?)["”]?$/i.exec(raw))) {
      overrides.appName = m[1].trim();
      applied.push(raw);
    } else if ((m = /^rename (?:the )?(?:page )?["“]?(.+?)["”]?(?: page)? to ["“]?(.+?)["”]?$/i.exec(raw)) && findPage(m[1])) {
      overrides.pageTitles[findPage(m[1]).id] = m[2].trim();
      applied.push(raw);
    } else if ((m = /^(?:remove|delete|drop|hide) (?:the )?["“]?(.+?)["”]?(?: page| tab| section)?$/i.exec(raw)) && findPage(m[1])) {
      overrides.removedPages.push(findPage(m[1]).id);
      applied.push(raw);
    } else {
      const theme = {};
      const nav = {};
      const r = interpretDirectives({ appearance: raw }, theme, nav);
      if (r.applied.length) {
        Object.assign(overrides.theme, theme);
        if (nav.placement) overrides.placement = nav.placement;
        applied.push(raw);
      } else unapplied.push(raw);
    }
  }
  return { applied, unapplied };
}
