// Thin wrapper around the REA CLI (the `rea-agents` package built from github.com/morluto/rea).
// Every analysis fact the studio shows as "verified" comes back through run() as REA Evidence.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

export function reaScript() {
  if (process.env.MINDFLOW_REA_SCRIPT) return process.env.MINDFLOW_REA_SCRIPT;
  const pkg = require.resolve('rea-agents/package.json');
  return path.join(path.dirname(pkg), 'scripts', 'rea.mjs');
}

export function reaVersion() {
  try {
    return JSON.parse(fs.readFileSync(require.resolve('rea-agents/package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

export class ReaError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ReaError';
    Object.assign(this, detail);
  }
}

/**
 * Run one REA CLI command with --json and return the parsed result.
 * REA reports failures as a JSON object with `code`/`category`; those are thrown as ReaError
 * so callers can record the gap instead of mistaking it for Evidence.
 */
export function run(args, { timeoutMs = 120_000, onProgress, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [reaScript(), ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(child);
    const out = [];
    let errText = '';
    let errBuf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ReaError(`rea ${args[0]} timed out after ${timeoutMs} ms`, { code: 'studio_timeout', command: args[0] }));
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      errBuf += d.toString();
      let nl;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl);
        errBuf = errBuf.slice(nl + 1);
        try {
          const j = JSON.parse(line);
          if (j.rea_progress) onProgress?.(j.rea_progress);
          else errText += line + '\n';
        } catch {
          errText += line + '\n';
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ReaError(`Could not start REA: ${e.message}`, { code: 'studio_spawn_failed', command: args[0] }));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8').trim();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return reject(new ReaError(`rea ${args[0]} returned no JSON (exit ${exitCode}). ${errText.trim().slice(0, 400)}`, { code: 'studio_bad_output', command: args[0] }));
      }
      if (json && typeof json === 'object' && !json.evidence_id && json.code && (json.category || json.message)) {
        const reason = json.details?.reason ? ` (${json.details.reason})` : '';
        return reject(new ReaError(`${json.message}${reason}`, { code: json.code, category: json.category, details: json.details, command: args[0] }));
      }
      resolve(json);
    });
  });
}

/** Compact provenance record kept on the project for every Evidence object we rely on. */
export function evidenceRecord(ev, file) {
  return {
    evidenceId: ev.evidence_id ?? null,
    operation: ev.operation ?? null,
    provider: ev.provider?.id ?? null,
    confidence: ev.confidence ?? null,
    authority: ev.authority ?? null,
    limitations: ev.limitations ?? [],
    file,
  };
}
