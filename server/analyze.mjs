// Runs the REA investigation for one reference and records Evidence, elements and gaps.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as rea from './rea.mjs';
import { openPage, closePage, evaluate } from './browser.mjs';
import { writeEvidence, loadSettings } from './store.mjs';
import { palette } from './png.mjs';
import * as F from './findings.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decide how (and whether) a target can be analysed. Pure; safe to call for previews. */
export function classifyTarget(target) {
  const t = String(target || '').trim();
  if (!t) return { kind: 'invalid', supported: false, reason: 'Empty target.' };
  if (/^https?:\/\//i.test(t)) {
    try {
      new URL(t);
      return { kind: 'web', supported: true, via: 'Chrome DevTools Protocol observation + static bundle analysis' };
    } catch {
      return { kind: 'invalid', supported: false, reason: 'Not a valid URL.' };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return { kind: 'unsupported', supported: false, reason: `Only http(s) URLs can be observed; “${t.split(':')[0]}:” targets are not supported.` };
  const p = path.resolve(t);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { kind: 'invalid', supported: false, reason: `Path does not exist on this machine: ${p}` };
  }
  const ext = path.extname(p).toLowerCase();
  if (st.isDirectory()) {
    if (p.endsWith('.app') || fs.existsSync(path.join(p, 'Contents', 'Resources'))) return { kind: 'desktop-dir', supported: true, path: p, via: 'Desktop installation inspection; Electron/JS contents analysed if present' };
    if (fs.existsSync(path.join(p, 'package.json'))) return { kind: 'js-app', supported: true, path: p, via: 'Static JavaScript/Electron application analysis' };
    return { kind: 'desktop-dir', supported: true, path: p, via: 'Desktop installation inspection; Electron/JS contents analysed if present' };
  }
  if (ext === '.asar') return { kind: 'js-app', supported: true, path: p, via: 'Static JavaScript/Electron application analysis (ASAR)' };
  if (['.apk', '.aab'].includes(ext)) return { kind: 'unsupported', supported: false, path: p, reason: 'Android packages need a caller-supplied JADX/Apktool toolchain for REA; the studio does not drive that workflow. Describe the features manually instead.' };
  if (['.exe', '.dll', '.so', '.dylib', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', ''].includes(ext)) {
    return { kind: 'native-file', supported: false, path: p, reason: 'A single native binary or installer. REA can decompile native code with Hopper, Ghidra, IDA or Kuna, but the studio cannot turn decompiled code into a feature inventory. Point at the installed application folder instead (Electron apps are analysed fully), or describe the features manually.' };
  }
  return { kind: 'unsupported', supported: false, path: p, reason: `Files of type “${ext}” are not a supported reference.` };
}

// Expression evaluated in the page by the studio's own probe (clearly separate from REA).
const STYLE_PROBE = `(() => {
  const cs = (el) => getComputedStyle(el);
  const toHex = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,/]+/).map(Number); if (p.length > 3 && p[3] === 0) return null; return '#' + p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); };
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const body = cs(document.body), html = cs(document.documentElement);
  const els = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).slice(0, 1500);
  const fonts = new Map(), radii = new Map(), accents = new Map(), surfaces = new Map(); let shadow = false;
  const bodyBg = toHex(body.backgroundColor) || toHex(html.backgroundColor) || '#ffffff';
  for (const e of els) {
    const s = cs(e);
    const fam = s.fontFamily.split(',')[0].replace(/["']/g, '').trim(); fonts.set(fam, (fonts.get(fam) || 0) + 1);
    const r = s.borderTopLeftRadius; if (r && r !== '0px' && !r.includes('%')) radii.set(r, (radii.get(r) || 0) + 1);
    if (s.boxShadow && s.boxShadow !== 'none') shadow = true;
    const bg = toHex(s.backgroundColor);
    if (e.matches('a, button, [role=button], input[type=submit]')) { const c = (bg && bg !== bodyBg) ? bg : toHex(s.color); if (c) accents.set(c, (accents.get(c) || 0) + 1); }
    else if (bg && bg !== bodyBg) { const a = e.getBoundingClientRect(); surfaces.set(bg, (surfaces.get(bg) || 0) + a.width * a.height); }
  }
  const textHex = toHex(body.color);
  const accent = top(accents).map(([c]) => c).find((c) => c !== textHex && c !== bodyBg) || null;
  const vw = innerWidth, vh = innerHeight;
  const regions = [];
  for (const el of document.querySelectorAll('header, nav, aside, main, footer, [role=banner], [role=navigation], [role=complementary], [role=main], [role=contentinfo]')) {
    const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8) continue;
    let kind = null, side = null;
    if (r.height >= vh * 0.6 && r.width <= vw * 0.4) { kind = 'sidebar'; side = r.left < vw / 2 ? 'left' : 'right'; }
    else if (r.top <= 8 && r.width >= vw * 0.8 && r.height <= vh * 0.25) kind = 'topbar';
    regions.push({ tag: el.tagName.toLowerCase(), kind, side, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    if (regions.length >= 14) break;
  }
  const main = document.querySelector('main, [role=main]');
  const vars = {};
  for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) if (rule.selectorText === ':root') for (const n of rule.style) if (n.startsWith('--') && Object.keys(vars).length < 40) vars[n] = rule.style.getPropertyValue(n).trim(); } catch (e) {} }
  const h = document.querySelector('h1, h2');
  return {
    viewport: { w: vw, h: vh },
    body: { background: bodyBg, color: textHex, fontSize: body.fontSize, lineHeight: body.lineHeight },
    headings: h ? { fontSize: cs(h).fontSize, fontWeight: cs(h).fontWeight, family: cs(h).fontFamily.split(',')[0].replace(/["']/g, '').trim() } : null,
    fonts: top(fonts).slice(0, 4).map(([family, count]) => ({ family, count })),
    radius: top(radii)[0]?.[0] || null, shadow, accent, surface: top(surfaces)[0]?.[0] || null,
    regions, contentMaxWidth: main ? Math.round(main.getBoundingClientRect().width) : null, cssVariables: vars,
  };
})()`;

/**
 * Analyse one reference. Returns { status, kind, elements, evidence, gaps, screenshot }.
 * Individual REA steps that fail are recorded as gaps; they never silently disappear.
 */
export async function analyzeReference(projectId, ref, progress = () => {}) {
  const cls = classifyTarget(ref.target);
  const result = { kind: ref.kind === 'manual' ? 'manual' : cls.kind, status: 'analyzed', elements: [], evidence: [], gaps: [], screenshot: null, analyzedAt: new Date().toISOString(), reaVersion: rea.reaVersion() };

  if (ref.kind === 'manual') {
    result.elements = F.manualElements(ref.id, ref.notes);
    result.gaps.push({ step: 'inspection', message: 'Nothing was inspected for this reference. Every item is your own description.' });
    return result;
  }
  if (!cls.supported) {
    result.status = 'unsupported';
    result.gaps.push({ step: 'target', message: cls.reason });
    if (ref.notes) result.elements = F.manualElements(ref.id, ref.notes);
    return result;
  }

  const step = async (name, label, fn) => {
    progress(label);
    try {
      return await fn();
    } catch (e) {
      result.gaps.push({ step: name, message: e.message, code: e.code ?? null });
      return null;
    }
  };
  const keep = async (ev, name) => {
    const file = await writeEvidence(projectId, `${ref.id}-${name}.json`, ev);
    const rec = rea.evidenceRecord(ev, file);
    result.evidence.push(rec);
    return { operation: rec.operation, evidenceId: rec.evidenceId, file };
  };

  if (cls.kind === 'web') await analyzeWeb(projectId, ref, result, step, keep, progress);
  else await analyzeLocal(projectId, ref, cls, result, step, keep);

  if (ref.notes) result.elements.push(...F.manualElements(ref.id, ref.notes));
  if (!result.evidence.length) result.status = 'failed';
  return result;
}

async function analyzeWeb(projectId, ref, result, step, keep, progress) {
  const settings = loadSettings();
  const url = new URL(ref.target).href;
  progress('Opening page in the studio browser');
  let page;
  try {
    page = await openPage(url, { settleMs: 1800 });
  } catch (e) {
    result.status = 'failed';
    result.gaps.push({ step: 'open', message: e.message, code: e.code ?? null });
    return;
  }
  const { endpoint, targetId, session } = page;
  try {
    const finalUrl = await evaluate(session, 'location.href').catch(() => url);
    if (new URL(finalUrl).origin !== new URL(url).origin) result.gaps.push({ step: 'open', message: `The page redirected to a different origin (${new URL(finalUrl).origin}); that page was analysed. A sign-in wall is the usual cause.` });

    const inspected = await step('inspect_web_page', 'REA: inspecting DOM, accessibility tree and scripts', () =>
      rea.run(['inspect-web-page', endpoint, targetId, '--observation-ms', '1000', '--include-accessibility-text', '--include-storage-keys']));
    if (inspected) {
      const src = await keep(inspected, 'page');
      result.elements.push(...F.webPageElements(ref.id, inspected.normalized_result, src));
      const c = inspected.normalized_result.completeness;
      if (c?.truncated_sections?.length) result.gaps.push({ step: 'inspect_web_page', message: `REA truncated: ${c.truncated_sections.join(', ')}.` });
    }

    const bundle = await step('analyze_web_bundle', 'REA: static analysis of loaded scripts', () => rea.run(['analyze-web-bundle', endpoint, targetId]));
    if (bundle) result.elements.push(...F.webBundleElements(ref.id, bundle.normalized_result, await keep(bundle, 'bundle')));

    const shot = await step('capture_web_screenshot', 'REA: capturing screenshot', () => rea.run(['capture-web-screenshot', endpoint, targetId]));
    if (shot) {
      const art = shot.normalized_result.artifact;
      const png = Buffer.from(art.data_base64, 'base64');
      result.screenshot = await writeEvidence(projectId, `${ref.id}-screenshot.png`, png);
      art.data_base64 = `[stored separately as ${result.screenshot}]`;
      const src = await keep(shot, 'screenshot');
      try {
        const colors = palette(png);
        if (colors.length) result.elements.push(F.paletteElement(ref.id, colors, src));
      } catch (e) {
        result.gaps.push({ step: 'palette', message: `Could not derive a palette from the screenshot: ${e.message}` });
      }
    }

    if (settings.styleProbe) {
      await sleep(600);
      const probe = await step('studio_style_probe', 'Studio probe: reading computed styles (not REA)', () => evaluate(session, STYLE_PROBE));
      if (probe) {
        await writeEvidence(projectId, `${ref.id}-styleprobe.json`, probe);
        result.elements.push(...F.probeElements(ref.id, probe));
      }
    } else {
      result.gaps.push({ step: 'studio_style_probe', message: 'Style probe is disabled in settings, so fonts, colour roles and layout geometry were not read. REA itself does not report CSS.' });
    }
  } finally {
    session.close();
    await closePage(targetId);
  }
  result.gaps.push(
    { step: 'scope', message: 'Only this one page state was captured. Other routes, signed-in areas, hover/expanded states and anything behind interaction were not observed — add them as separate references.' },
    { step: 'scope', message: 'Network traffic during page load was not observed: REA attaches after the page has loaded and never retains request or response bodies. Endpoints listed come from static script analysis only.' },
    { step: 'scope', message: 'Behaviour is not verified: REA observed that controls exist, not what they do. Server-side logic is never visible.' },
  );
}

function findJsRoot(root) {
  const candidates = [root, path.join(root, 'resources', 'app.asar'), path.join(root, 'resources', 'app'), path.join(root, 'Contents', 'Resources', 'app.asar'), path.join(root, 'Contents', 'Resources', 'app')];
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile() && c.endsWith('.asar')) return c;
      if (st.isDirectory() && fs.existsSync(path.join(c, 'package.json'))) return c;
    } catch {
      /* keep looking */
    }
  }
  // One level of nesting: <root>/<something>/resources/app(.asar)
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const tail of [['resources', 'app.asar'], ['resources', 'app']]) {
        const c = path.join(root, d.name, ...tail);
        if (fs.existsSync(c)) return c;
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}

async function analyzeLocal(projectId, ref, cls, result, step, keep) {
  const target = cls.path;
  const isDir = (await fsp.stat(target)).isDirectory();
  if (isDir && cls.kind === 'desktop-dir') {
    const desk = await step('inspect_desktop_application', 'REA: inspecting installation directory', () => rea.run(['inspect-desktop-application', target, '--detail', 'complete']));
    if (desk) result.elements.push(...F.desktopElements(ref.id, desk.normalized_result, await keep(desk, 'desktop')));
  }
  const jsRoot = isDir ? findJsRoot(target) : target;
  if (jsRoot) {
    const app = await step('analyze_javascript_application', 'REA: static analysis of JavaScript/Electron application', () => rea.run(['analyze-javascript-application', jsRoot], { timeoutMs: 300_000 }));
    if (app) {
      const nr = app.normalized_result;
      // The full graph can be very large; keep the parts the studio and the user can use.
      const slim = { ...app, normalized_result: { ...nr, semantic_graph: nr.semantic_graph ? { schema: nr.semantic_graph.schema, omitted_by_studio: 'semantic graph not stored; re-run REA for the full graph' } : undefined } };
      result.elements.push(...F.jsAppElements(ref.id, nr, await keep(slim, 'jsapp')));
    }
    result.gaps.push(
      { step: 'scope', message: 'Static analysis only: the application was never run, so its windows, visual design and runtime behaviour were not observed.' },
      { step: 'scope', message: 'Visual design for this reference must come from your instructions or from another reference.' },
    );
  } else {
    result.gaps.push({ step: 'analyze_javascript_application', message: 'No JavaScript/Electron application (package.json or resources/app.asar) was found here. Native, .NET, Unity and other runtimes are reported as candidates only; the studio cannot derive a feature inventory from them.' });
  }
}
