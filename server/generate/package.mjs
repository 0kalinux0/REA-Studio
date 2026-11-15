// Files added to every generated version regardless of engine: run instructions, a provenance
// record, and a zero-dependency static server so the export runs with nothing but Node.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectedElements } from '../plan.mjs';
import { reaVersion } from '../rea.mjs';

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

const STATUS_TEXT = {
  verified: 'Verified — observed directly by REA',
  derived: 'Derived — computed by the studio from REA evidence',
  probe: 'Probed — read by the studio’s own style probe, not by REA',
  inferred: 'Inferred — a low-confidence guess',
  user: 'Described by you — nothing was inspected',
};

export function provenanceMarkdown(project, plan, { engine, notes = [] }) {
  const L = [`# Provenance for ${plan.appName}`, '', `Generated ${new Date().toISOString()} by Mindflow Studio using REA ${reaVersion() ?? '(unknown version)'} and the **${engine}** build engine.`, '',
    'This app was written from an inventory of observed structure and behaviour. It contains no code, text content, data or assets copied from the references. You are responsible for having the right to analyse the references and for how you use the result.', '',
    '## References', ''];
  for (const r of project.references) {
    L.push(`### ${r.label}`, '', `- Target: \`${r.target || '(described manually)'}\``, `- Analysis: ${r.status ?? 'not analysed'}${r.analyzedAt ? ` at ${r.analyzedAt}` : ''}`);
    for (const e of r.evidence ?? []) L.push(`- REA evidence: \`${e.operation}\` — confidence \`${e.confidence}\`, id \`${e.evidenceId}\``);
    if (r.gaps?.length) L.push('- Not observed / limitations:', ...r.gaps.map((g) => `  - ${g.message}`));
    L.push('');
  }
  L.push('## What was built from what', '');
  const chosen = selectedElements(project).filter((e) => e.mode !== 'exclude');
  for (const status of Object.keys(STATUS_TEXT)) {
    const list = chosen.filter((e) => e.status === status);
    if (!list.length) continue;
    L.push(`### ${STATUS_TEXT[status]}`, '');
    for (const e of list) L.push(`- ${e.title} _(from ${e.refLabel})_${e.mode === 'modify' && e.note ? ` — modified: ${e.note}` : ''}`);
    L.push('');
  }
  if (plan.excluded?.length) L.push('## Deliberately excluded', '', ...plan.excluded.map((e) => `- ${e.title} _(from ${e.from})_`), '');
  if (plan.assumptions?.length) L.push('## Assumptions', '', ...plan.assumptions.map((a) => `- ${a}`), '');
  if (notes.length) L.push('## Build notes', '', ...notes.map((n) => `- ${n}`), '');
  return L.join('\n');
}

export function readmeMarkdown(plan, { engine, files }) {
  return `# ${plan.appName}

${plan.summary}

## Run it

Requires Node.js 18 or newer. No install step and no dependencies.

\`\`\`bash
npm start
\`\`\`

Then open http://127.0.0.1:4173. To use another port: \`node server.mjs 8080\`.

Any static file server also works, for example \`python3 -m http.server 4173\`. Opening
\`index.html\` straight from disk will not work because the app uses JavaScript modules.

## What is in here

${Object.keys(files).sort().map((f) => `- \`${f}\``).join('\n')}
- \`server.mjs\` — tiny static server used by \`npm start\`
- \`PROVENANCE.md\` — which parts came from verified observations and which are assumptions

## Good to know

- Data is saved in your browser's localStorage. There is no backend; clearing site data resets the app.
- Built by Mindflow Studio with the ${engine} engine. See \`PROVENANCE.md\` for sources and known gaps.
`;
}

export function packageFiles(files, project, plan, meta) {
  const out = { ...files };
  out['server.mjs'] = fs.readFileSync(path.join(RUNTIME, 'server.mjs'), 'utf8');
  out['package.json'] = JSON.stringify({ name: slug(plan.appName), version: '0.1.0', private: true, type: 'module', scripts: { start: 'node server.mjs' }, engines: { node: '>=18' } }, null, 2) + '\n';
  out['README.md'] = readmeMarkdown(plan, { ...meta, files });
  out['PROVENANCE.md'] = provenanceMarkdown(project, plan, meta);
  return out;
}

export const RESERVED = new Set(['server.mjs', 'package.json', 'README.md', 'PROVENANCE.md']);
