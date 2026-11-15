// Automated check of a generated version: load it in the studio browser, visit every page,
// collect runtime errors, compare what is on screen with the plan, and let REA inspect and
// screenshot the result the same way it inspected the references.
import * as rea from './rea.mjs';
import { openPage, closePage, evaluate } from './browser.mjs';
import { writeEvidence } from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_TEXT = `(() => {
  const parts = [document.body.innerText];
  for (const el of document.querySelectorAll('[aria-label], [placeholder], [title], input[type=submit], input[type=button]')) parts.push(el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.value || '');
  return parts.join('\\n');
})()`;

export function expectedLabels(plan) {
  const out = [];
  const add = (label, kind, page) => label && out.push({ label: String(label), kind, page });
  for (const item of plan.navigation.items) add(item.label, 'navigation item', null);
  for (const p of plan.pages) {
    for (const w of p.widgets) {
      if (w.note) continue; // user asked for a modification; the original label may rightly be gone
      if (w.type === 'table') w.columns.forEach((c) => add(c, 'table column', p.id));
      if (w.type === 'form') { w.fields.forEach((f) => add(f.label, 'form field', p.id)); add(w.submit, 'form button', p.id); }
      if (w.type === 'tabs') w.tabs.forEach((t) => add(t, 'tab', p.id));
      if (w.type === 'action') add(w.label, 'action button', p.id);
      if (w.type === 'stats') w.cards.forEach((c) => add(c.label, 'card', p.id));
      if (w.type === 'search') add(w.placeholder, 'search box', p.id);
    }
  }
  return out;
}

export async function verifyVersion(project, n, previewOrigin, progress = () => {}) {
  const url = `${previewOrigin}/${project.id}/${n}/`;
  const report = { checkedAt: new Date().toISOString(), url, ok: false, problems: [], pages: [], coverage: null, rea: null, screenshot: null };
  progress('Loading the app in the studio browser');
  let page;
  try {
    page = await openPage(url, { settleMs: 900, record: true });
  } catch (e) {
    report.problems.push({ kind: 'load', text: e.message });
    return report;
  }
  const { endpoint, targetId, session, problems } = page;
  try {
    const textByPage = {};
    const home = await evaluate(session, PAGE_TEXT).catch(() => '');
    if (home.trim().length < 5) report.problems.push({ kind: 'blank', text: 'The page rendered no visible text.' });
    const links = await evaluate(session, `[...new Set([...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')))].filter((h) => h.length > 1).slice(0, 30)`).catch(() => []);
    progress(`Visiting ${links.length || 1} page(s)`);
    for (const href of links) {
      const before = problems.length;
      await evaluate(session, `location.hash = ${JSON.stringify(href)}`).catch(() => {});
      await sleep(250);
      const text = await evaluate(session, PAGE_TEXT).catch(() => '');
      const id = decodeURIComponent(href.replace(/^#\/?/, ''));
      textByPage[id] = text;
      report.pages.push({ route: href, ok: problems.length === before && text.trim().length > 5, errors: problems.length - before });
    }
    if (links.length) {
      await evaluate(session, `location.hash = ${JSON.stringify(links[0])}`).catch(() => {});
      await sleep(250);
    }

    // Coverage: does each label the plan promises appear on its page?
    if (project.plan) {
      const expected = expectedLabels(project.plan);
      const allText = [home, ...Object.values(textByPage)].join('\n').toLowerCase();
      const missing = expected.filter((e) => {
        const hay = (e.page && textByPage[e.page] ? textByPage[e.page] : allText).toLowerCase();
        return !hay.includes(e.label.toLowerCase());
      });
      report.coverage = { expected: expected.length, found: expected.length - missing.length, missing: missing.slice(0, 40), method: 'Text and labels read from the running app by the studio (not REA).' };
    }

    progress('REA: inspecting the generated app');
    try {
      const ev = await rea.run(['inspect-web-page', endpoint, targetId, '--observation-ms', '500', '--include-accessibility-text']);
      const nodes = ev.normalized_result.accessibility?.nodes ?? [];
      const roles = {};
      for (const a of nodes) if (!a.ignored) roles[a.role] = (roles[a.role] || 0) + 1;
      const interactive = nodes.filter((a) => !a.ignored && ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'tab'].includes(a.role));
      report.rea = {
        evidenceId: ev.evidence_id, domNodes: ev.normalized_result.dom?.total_nodes ?? 0, accessibilityNodes: nodes.length,
        landmarks: ['banner', 'navigation', 'main', 'complementary', 'contentinfo'].filter((r) => roles[r]),
        unlabelledControls: interactive.filter((a) => !(a.name || '').trim()).length, interactiveControls: interactive.length,
      };
      if (!roles.main) report.problems.push({ kind: 'accessibility', text: 'No <main> landmark found by REA.' });
      if (report.rea.unlabelledControls) report.problems.push({ kind: 'accessibility', text: `${report.rea.unlabelledControls} interactive control(s) have no accessible name.` });
    } catch (e) {
      report.rea = { error: e.message };
    }
    progress('REA: capturing a screenshot of the generated app');
    try {
      const shot = await rea.run(['capture-web-screenshot', endpoint, targetId]);
      report.screenshot = await writeEvidence(project.id, `version-${n}.png`, Buffer.from(shot.normalized_result.artifact.data_base64, 'base64'));
    } catch {
      /* screenshot is optional */
    }
    report.problems.push(...problems.filter((p) => !/favicon\.ico/.test(p.text)).filter((p, i, a) => a.findIndex((q) => q.text === p.text) === i).slice(0, 30));
  } finally {
    session.close();
    await closePage(targetId);
  }
  const blocking = report.problems.filter((p) => p.kind !== 'accessibility');
  report.ok = blocking.length === 0 && report.pages.every((p) => p.ok);
  return report;
}
