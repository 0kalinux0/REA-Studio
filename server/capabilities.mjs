// What this installation can and cannot analyse. The matrix below was established by reading
// REA's documentation and running its CLI; "studio" says how far this GUI takes each target.
import * as rea from './rea.mjs';
import { browserStatus } from './browser.mjs';
import { hasCredentials } from './generate/llm.mjs';

export const TARGET_MATRIX = [
  { target: 'Website or web app (http/https URL)', level: 'full', studio: 'Analysed automatically: page structure, accessibility tree, scripts, static routes and endpoints, screenshot.', needs: 'A Chrome-family browser on this machine.', limits: 'One page state per reference. Nothing behind interaction, hover or sign-in unless you sign in first (turn off headless mode in Settings). No CSS from REA — design comes from the studio’s own style probe. No request/response bodies.' },
  { target: 'Electron or JavaScript app folder / .asar', level: 'full', studio: 'Analysed automatically: entry points, windows, IPC channels, renderer bridge APIs, routes, modules.', needs: 'Nothing extra.', limits: 'Static only. The app is never run, so its visual design and runtime behaviour are not observed.' },
  { target: 'Installed desktop application folder', level: 'partial', studio: 'Runtime family is identified (Electron, .NET, Unity, Godot, Unreal…). If it contains an Electron/JS app, that part is analysed fully.', needs: 'Nothing extra.', limits: 'For non-JavaScript runtimes only the runtime candidate and file inventory are reported.' },
  { target: 'Native binary or installer (.exe, .dll, .so, Mach-O, .dmg…)', level: 'unsupported', studio: 'Not turned into a feature inventory.', needs: 'REA can decompile with Hopper, Ghidra, IDA or Kuna from an agent or terminal.', limits: 'Decompiled code is not a UI description; add the features as a manual reference instead.' },
  { target: 'Android APK / device', level: 'unsupported', studio: 'Not integrated.', needs: 'REA supports APKs with caller-supplied JADX, Apktool or adb.', limits: 'Use REA directly, then describe the features as a manual reference.' },
  { target: '.NET assemblies, firmware, packet captures, WASM, and REA’s other static formats', level: 'unsupported', studio: 'Not integrated — they do not describe a user interface.', needs: '—', limits: 'Available through REA’s own CLI and MCP server.' },
  { target: 'Anything you can describe', level: 'manual', studio: 'Add a manual reference: one feature per line. Items are labelled “described by you”.', needs: '—', limits: 'Nothing is verified.' },
];

let cached = null;
export async function capabilities(force = false) {
  if (cached && !force && Date.now() - cached.at < 60_000) return { ...cached.value, browser: browserStatus(), ai: { configured: hasCredentials() } };
  const value = { rea: { version: rea.reaVersion(), ok: false, node: process.version, providers: [], counts: null, error: null }, matrix: TARGET_MATRIX };
  try {
    const d = await rea.run(['doctor'], { timeoutMs: 60_000 });
    value.rea.ok = d.checks?.find((c) => c.name === 'node')?.ok ?? true;
    value.rea.counts = d.identity?.catalog?.counts ?? null;
    value.rea.providers = (d.providerInspections ?? []).map((p) => ({ id: p.id, available: p.available, detail: p.checks?.[0]?.detail ?? '' }));
    const hopper = d.checks?.find((c) => c.name === 'hopper');
    if (hopper) value.rea.providers.unshift({ id: 'hopper', available: hopper.ok, detail: hopper.remediation ?? '' });
  } catch (e) {
    value.rea.error = e.message;
  }
  cached = { at: Date.now(), value };
  return { ...value, browser: browserStatus(), ai: { configured: hasCredentials() } };
}
