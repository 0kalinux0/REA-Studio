#!/usr/bin/env node
// Starts REA Studio and opens it in your browser.
import { spawn } from 'node:child_process';
import { startServer } from '../server/index.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: rea-studio [--port 4600] [--no-open]\n\nEnvironment:\n  REA_STUDIO_DATA     where projects are stored (default ./data)\n  REA_STUDIO_CHROME   path to a Chrome-family browser\n  ANTHROPIC_API_KEY enables the Claude build engine (or set it in Settings)');
  process.exit(0);
}
const port = Number(flag('--port') || process.env.PORT || 4600);

try {
  const server = await startServer({ port });
  console.log(`REA Studio is running at ${server.url}`);
  console.log(`Generated apps are previewed from ${server.previewOrigin}`);
  if (!args.includes('--no-open')) {
    const cmd = process.platform === 'darwin' ? ['open', [server.url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', server.url]] : ['xdg-open', [server.url]];
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (e) {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} (or ${port + 1}) is already in use. Try: npm start -- --port 4700` : e);
  process.exit(1);
}
