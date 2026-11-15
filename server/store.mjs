// Disk-backed project store. One directory per project:
//   <data>/projects/<id>/project.json      project state
//   <data>/projects/<id>/evidence/*        raw REA Evidence + screenshots
//   <data>/projects/<id>/versions/<n>/     generated source for version n
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.REA_STUDIO_DATA || path.join(process.cwd(), 'data'));
const PROJECTS = path.join(DATA_DIR, 'projects');
const SETTINGS = path.join(DATA_DIR, 'settings.json');

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const ID_RE = /^[a-z]+_[0-9a-f]{10}$/;

function assertId(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Invalid id'), { status: 400 });
}

export function projectDir(id) {
  assertId(id);
  return path.join(PROJECTS, id);
}
export const evidenceDir = (id) => path.join(projectDir(id), 'evidence');
export function versionDir(id, n) {
  if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('Invalid version'), { status: 400 });
  return path.join(projectDir(id), 'versions', String(n));
}

async function writeJsonAtomic(file, value, mode) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  await fsp.rename(tmp, file);
}

// ---- settings ----
const DEFAULT_SETTINGS = { apiKey: '', model: 'claude-opus-5-5', effort: 'high', headless: true, styleProbe: true };

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export async function saveSettings(patch) {
  const next = { ...loadSettings() };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in patch) next[k] = patch[k];
  await writeJsonAtomic(SETTINGS, next, 0o600);
  return next;
}
/** Settings safe to send to the browser: the key itself never leaves the server. */
export function publicSettings() {
  const s = loadSettings();
  const envKey = Boolean(process.env.ANTHROPIC_API_KEY);
  return { model: s.model, effort: s.effort, headless: s.headless, styleProbe: s.styleProbe, hasApiKey: Boolean(s.apiKey) || envKey, apiKeySource: s.apiKey ? 'settings' : envKey ? 'environment' : null };
}

// ---- projects ----
export async function listProjects() {
  let ids = [];
  try {
    ids = await fsp.readdir(PROJECTS);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    try {
      const p = JSON.parse(await fsp.readFile(path.join(PROJECTS, id, 'project.json'), 'utf8'));
      out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, references: p.references.length, versions: p.versions.length });
    } catch {
      /* skip unreadable project */
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function createProject({ name, brief }) {
  const now = new Date().toISOString();
  const project = {
    id: newId('prj'),
    name: String(name || 'Untitled project').slice(0, 120),
    brief: String(brief || ''),
    createdAt: now,
    updatedAt: now,
    references: [],
    selections: {},
    directives: { appearance: '', layout: '', navigation: '', functionality: '' },
    plan: null,
    versions: [],
    activity: [],
  };
  await saveProject(project);
  return project;
}

export async function loadProject(id) {
  try {
    return JSON.parse(await fsp.readFile(path.join(projectDir(id), 'project.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('Project not found'), { status: 404 });
    throw e;
  }
}

export async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(projectDir(project.id), 'project.json'), project);
  return project;
}

// Serialise read-modify-write cycles per project so concurrent jobs don't clobber each other.
const locks = new Map();
export function updateProject(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(async () => {
      const project = await loadProject(id);
      const result = await fn(project);
      await saveProject(project);
      return result === undefined ? project : result;
    });
  locks.set(id, run);
  return run;
}

export async function deleteProject(id) {
  await fsp.rm(projectDir(id), { recursive: true, force: true });
}

export function logActivity(project, kind, message) {
  project.activity.push({ at: new Date().toISOString(), kind, message });
  if (project.activity.length > 200) project.activity.splice(0, project.activity.length - 200);
}

// ---- evidence ----
export async function writeEvidence(projectId, name, data) {
  const dir = evidenceDir(projectId);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(name));
  await fsp.writeFile(file, Buffer.isBuffer(data) ? data : JSON.stringify(data));
  return path.basename(name);
}
export function evidencePath(projectId, name) {
  const base = path.basename(String(name));
  return path.join(evidenceDir(projectId), base);
}

// ---- versions ----
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** Normalise a generated file path; rejects traversal, absolute paths and odd names. */
export function safeRelPath(rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.length > 8) return null;
  for (const p of parts) if (p === '..' || !SAFE_SEGMENT.test(p) || p.length > 100) return null;
  return parts.join('/');
}

export async function writeVersionFiles(projectId, n, files) {
  const dir = versionDir(projectId, n);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const safe = safeRelPath(rel);
    if (!safe) continue;
    const file = path.join(dir, safe);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
}

export async function readVersionFiles(projectId, n) {
  const dir = versionDir(projectId, n);
  const out = {};
  async function walk(d, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') throw Object.assign(new Error('Version not found'), { status: 404 });
      throw e;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else if (e.isFile()) out[rel] = await fsp.readFile(path.join(d, e.name), 'utf8');
    }
  }
  await walk(dir, '');
  return out;
}

export function diffFiles(before, after) {
  const changes = [];
  for (const f of Object.keys(after)) {
    if (!(f in before)) changes.push({ file: f, change: 'added' });
    else if (before[f] !== after[f]) changes.push({ file: f, change: 'modified' });
  }
  for (const f of Object.keys(before)) if (!(f in after)) changes.push({ file: f, change: 'removed' });
  return changes.sort((a, b) => a.file.localeCompare(b.file));
}
