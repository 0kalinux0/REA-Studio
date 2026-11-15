// The studio owns one dedicated Chromium-family browser with a loopback debugging port.
// REA attaches to it passively (REA never launches or drives a browser itself); the studio
// uses the same port to open pages, trigger reloads and run its own clearly-labelled probes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, loadSettings } from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const env = process.env.REA_STUDIO_CHROME || process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    win32: [
      `${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['LOCALAPPDATA'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/brave-browser',
      '/usr/bin/microsoft-edge',
      '/opt/pw-browsers/chromium',
    ],
  }[process.platform] || [];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let state = null; // { child, port, endpoint, headless }

async function reachable(endpoint) {
  try {
    const r = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureBrowser() {
  const settings = loadSettings();
  if (state && state.headless === settings.headless && (await reachable(state.endpoint))) return state;
  await stopBrowser();
  const exe = findChrome();
  if (!exe) {
    throw Object.assign(new Error('No Chrome-family browser found. Install Chrome/Chromium/Edge/Brave or set REA_STUDIO_CHROME to its executable.'), { code: 'no_browser' });
  }
  const port = await freePort();
  const profile = path.join(DATA_DIR, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--window-size=1366,900',
  ];
  if (settings.headless) args.push('--headless=new');
  if (process.platform === 'linux' && os.userInfo().uid === 0) args.push('--no-sandbox');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) args.push(`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>;127.0.0.1;localhost');
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: 'ignore', detached: false });
  child.on('exit', () => {
    if (state?.child === child) state = null;
  });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (await reachable(endpoint)) {
      state = { child, port, endpoint, headless: settings.headless, exe };
      return state;
    }
    await sleep(250);
  }
  child.kill();
  throw Object.assign(new Error('The browser started but its DevTools port never opened.'), { code: 'browser_no_devtools' });
}

export async function stopBrowser() {
  if (!state) return;
  const { child } = state;
  state = null;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}
process.on('exit', () => state?.child.kill());

/** Minimal CDP session over the page WebSocket (Node's built-in WebSocket). */
export function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    ws.onerror = () => reject(new Error('CDP connection failed'));
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('CDP connection closed'));
      pending.clear();
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const l of listeners) l(msg);
      }
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}, timeoutMs = 15_000) {
          const id = nextId++;
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP ${method} timed out`));
            }, timeoutMs);
            pending.set(id, { resolve: (v) => (clearTimeout(t), res(v)), reject: (e) => (clearTimeout(t), rej(e)) });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
  });
}

/** Evaluate an expression in the page and return its JSON-serialisable value. */
export async function evaluate(session, expression) {
  const r = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluation failed');
  return r.result?.value;
}

/**
 * Open a new tab, optionally recording console errors and failed requests from the very first
 * request, then navigate and wait for the page to settle.
 */
export async function openPage(url, { settleMs = 1200, timeoutMs = 30_000, record = false } = {}) {
  const b = await ensureBrowser();
  const res = await fetch(`${b.endpoint}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Browser refused to open a tab (${res.status})`);
  const target = await res.json();
  const session = await cdpSession(target.webSocketDebuggerUrl);
  const problems = [];
  await session.send('Page.enable');
  if (record) {
    await session.send('Runtime.enable');
    await session.send('Log.enable');
    await session.send('Network.enable');
    session.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        problems.push({ kind: 'exception', text: d.exception?.description?.split('\n')[0] || d.text });
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        problems.push({ kind: 'console.error', text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        problems.push({ kind: 'log', text: `${m.params.entry.text} ${m.params.entry.url || ''}`.trim().slice(0, 300) });
      } else if (m.method === 'Network.loadingFailed' && !m.params.canceled) {
        problems.push({ kind: 'network', text: m.params.errorText });
      }
    });
  }
  const loaded = new Promise((resolve) => {
    const off = session.on((m) => {
      if (m.method === 'Page.loadEventFired') {
        off();
        resolve(true);
      }
    });
    setTimeout(() => resolve(false), timeoutMs);
  });
  const nav = await session.send('Page.navigate', { url }, timeoutMs);
  if (nav.errorText) {
    session.close();
    await closePage(target.id);
    throw Object.assign(new Error(`Could not load ${url}: ${nav.errorText}`), { code: 'navigation_failed' });
  }
  const didLoad = await loaded;
  await sleep(settleMs);
  return { endpoint: b.endpoint, targetId: target.id, session, problems, loadEventSeen: didLoad };
}

export async function closePage(targetId) {
  if (!state) return;
  try {
    await fetch(`${state.endpoint}/json/close/${targetId}`, { signal: AbortSignal.timeout(3000) });
  } catch {
    /* tab already gone */
  }
}

export function browserStatus() {
  return { running: Boolean(state), executable: findChrome(), endpoint: state?.endpoint ?? null, headless: state?.headless ?? loadSettings().headless };
}
