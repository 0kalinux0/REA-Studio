// AI build engine: Claude writes and revises the application from the approved plan.
// Files travel in a plain-text delimiter protocol (no JSON escaping of source code):
//
//   === FILE: path/to/file.ext ===
//   <entire file content>
//   === END FILE ===
//   === DELETE: path/to/file.ext ===
//   === NOTES ===
//   <free text for the user>
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadSettings, safeRelPath, evidencePath } from '../store.mjs';
import { planBrief } from '../plan.mjs';
import { RESERVED } from './package.mjs';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function hasCredentials() {
  return Boolean(loadSettings().apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function client() {
  const { apiKey } = loadSettings();
  // With no key in settings the SDK resolves credentials from the environment itself.
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

const SYSTEM = `You are the build engine inside REA Studio, a tool that helps a person build their own application informed by an inventory of features observed in reference software.

You write complete, working, original front-end applications.

Hard requirements for everything you produce:
- Static web app with no build step: index.html at the root, plus CSS and JavaScript ES modules. No frameworks, no npm packages, no CDN or other network requests, no external fonts or images. Draw any graphics with CSS or inline SVG.
- Every feature in the plan must actually work in the browser: navigation switches pages (hash routing), forms validate and save, tables support add/edit/delete, search filters, state persists in localStorage. Never ship a dead button; if something genuinely cannot work without a backend, implement a local mock data layer behind a small module and say so in NOTES.
- Original work only. The references tell you what kinds of features and structure the person liked; they are not something to copy. Do not reproduce reference brand names, logos, marketing copy, or data. Use the app name from the plan and neutral sample data you invent.
- User instructions and modifications override anything observed in a reference. Excluded elements must not appear.
- Accessible, responsive, and visually deliberate: semantic landmarks, labelled controls, visible focus, keyboard-operable, usable at 380px wide. Follow the plan's theme tokens through CSS custom properties.
- Keep the code readable for someone who will maintain it: small modules, clear names, brief comments only where intent is not obvious.
- Do not write README.md, PROVENANCE.md, package.json or server.mjs; the studio adds those.

Output protocol — follow it exactly, with no Markdown code fences around files:
=== FILE: relative/path.ext ===
(entire file content)
=== END FILE ===
To remove a file: === DELETE: relative/path.ext ===
Finish with:
=== NOTES ===
A short plain-language summary for the user: what you built or changed, anything from the plan you could not fully implement, and any assumption you made where the plan was marked as not observed.`;

/** Parse the delimiter protocol. Tolerates stray prose between blocks. */
export function parseFileProtocol(text) {
  const files = {};
  const deletes = [];
  const rejected = [];
  const re = /^=== FILE: (.+?) ===[ \t]*\r?\n([\s\S]*?)\r?\n=== END FILE ===[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) {
    const rel = safeRelPath(m[1].trim());
    if (!rel || RESERVED.has(rel)) rejected.push(m[1].trim());
    else files[rel] = m[2].endsWith('\n') ? m[2] : m[2] + '\n';
  }
  const del = /^=== DELETE: (.+?) ===[ \t]*$/gm;
  while ((m = del.exec(text))) {
    const rel = safeRelPath(m[1].trim());
    if (rel) deletes.push(rel);
  }
  const n = text.lastIndexOf('=== NOTES ===');
  const notes = n >= 0 ? text.slice(n + 13).trim() : '';
  return { files, deletes, notes, rejected };
}

async function runModel({ system, content, onProgress }) {
  const settings = loadSettings();
  const stream = client().beta.messages.stream({
    model: settings.model || 'claude-opus-5-5',
    max_tokens: 64000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default', // if a safety classifier declines, retry on Anthropic's recommended model
    thinking: { type: 'adaptive' },
    output_config: { effort: settings.effort || 'high' },
    system,
    messages: [{ role: 'user', content }],
  });
  let text = '';
  let lastCount = -1;
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
      const headers = text.match(/^=== FILE: .+? ===/gm) || [];
      const count = headers.length;
      if (count !== lastCount) {
        lastCount = count;
        const current = headers.at(-1)?.slice(10, -4);
        onProgress?.(current ? `Claude is writing ${current}` : 'Claude is planning the build');
      }
    }
  }
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw Object.assign(new Error(`Claude declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : '.'}`), { code: 'refusal' });
  }
  const full = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text: full || text, truncated: message.stop_reason === 'max_tokens', model: message.model, usage: message.usage };
}

/** Turn SDK errors into messages a non-developer can act on. */
export function explainError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check it in Settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the selected model.';
  if (e instanceof Anthropic.NotFoundError) return 'The selected model was not found. Choose another model in Settings.';
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached. Wait a minute and try again.';
  if (e instanceof Anthropic.BadRequestError) return `The request was rejected: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your network connection.';
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ''}: ${e.message}`;
  return e.message;
}

function screenshotBlocks(project) {
  const blocks = [];
  for (const ref of project.references) {
    if (!ref.screenshot) continue;
    const included = (ref.elements ?? []).some((el) => (project.selections[el.id]?.mode ?? 'include') !== 'exclude' && ['design', 'layout', 'section'].includes(el.category));
    if (!included) continue;
    try {
      const data = fs.readFileSync(evidencePath(project.id, ref.screenshot)).toString('base64');
      blocks.push({ type: 'text', text: `Screenshot of reference “${ref.label}” (captured by REA). Use it only to understand layout, spacing and visual rhythm for the elements selected from this reference; do not copy its text, branding or data.` });
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    } catch {
      /* screenshot missing on disk; continue without it */
    }
    if (blocks.length >= 6) break;
  }
  return blocks;
}

const filesBlock = (files) => Object.entries(files).filter(([f]) => !RESERVED.has(f)).map(([f, c]) => `=== FILE: ${f} ===\n${c.replace(/\n$/, '')}\n=== END FILE ===`).join('\n');

export async function buildWithClaude(project, plan, onProgress) {
  const content = [
    ...screenshotBlocks(project),
    { type: 'text', text: `Build the complete application described by this approved plan.\n\n${planBrief(project, plan)}\n\nWrite every file needed, then the NOTES section.` },
  ];
  const r = await runModel({ system: SYSTEM, content, onProgress });
  const parsed = parseFileProtocol(r.text);
  if (!parsed.files['index.html']) throw Object.assign(new Error(r.truncated ? 'Claude ran out of output space before finishing. Reduce the number of selected features or split the build into steps.' : 'Claude did not return an index.html. Try building again.'), { code: 'bad_generation' });
  const notes = [];
  if (parsed.notes) notes.push(parsed.notes);
  if (r.truncated) notes.push('Warning: the response hit the output limit, so the last file may be incomplete.');
  if (parsed.rejected.length) notes.push(`Ignored files with unsafe or reserved paths: ${parsed.rejected.join(', ')}`);
  return { files: parsed.files, notes, model: r.model, usage: r.usage };
}

export async function refineWithClaude(project, plan, currentFiles, request, verifyReport, onProgress) {
  const problems = verifyReport?.problems?.length ? `\n\nThe last automated check of this version reported:\n${verifyReport.problems.map((p) => `- ${p.kind}: ${p.text}`).join('\n')}` : '';
  const content = [
    { type: 'text', text: `Here is the current application.\n\n${filesBlock(currentFiles)}\n\nThe approved plan it was built from, for context:\n\n${planBrief(project, plan)}${problems}` },
    { type: 'text', text: `Change request from the user:\n\n${request}\n\nMake exactly this change and keep everything else working. Return only the files you add or change, each in full, plus any DELETE lines, then NOTES.` },
  ];
  const r = await runModel({ system: SYSTEM, content, onProgress });
  const parsed = parseFileProtocol(r.text);
  if (!Object.keys(parsed.files).length && !parsed.deletes.length) throw Object.assign(new Error(parsed.notes || 'Claude returned no file changes for this request.'), { code: 'no_changes' });
  const files = { ...currentFiles, ...parsed.files };
  for (const d of parsed.deletes) if (d !== 'index.html') delete files[d];
  const notes = [];
  if (parsed.notes) notes.push(parsed.notes);
  if (r.truncated) notes.push('Warning: the response hit the output limit, so the last file may be incomplete.');
  return { files, notes, model: r.model, usage: r.usage };
}

/** Ask Claude to explain, in plain language, how it would apply a plan revision. Text only. */
export async function reviewPlanWithClaude(project, plan, instruction) {
  const r = await runModel({
    system: 'You help a non-technical person review a build plan for a custom application before it is implemented. Be concrete and brief. Plain prose, no Markdown headings. Never claim something was observed in a reference unless the plan marks it verified.',
    content: [{ type: 'text', text: `${planBrief(project, plan)}\n\nThe user says: ${instruction}\n\nIn under 180 words: say how the build will honour this, flag any conflict with the selected elements or anything that depends on details never observed, and ask at most one clarifying question if one is truly needed.` }],
  });
  return r.text.trim();
}
