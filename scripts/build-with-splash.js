#!/usr/bin/env node
/**
 * build-with-splash.js
 * Starts a "Building…" page on port 8000, runs `next build`, then shuts down.
 */
const http = require('http');
const { spawn } = require('child_process');

const PORT = 8000;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="5" />
  <title>9Router — Building…</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #0f0f0f;
      color: #e5e5e5;
      font-family: system-ui, sans-serif;
      gap: 1.5rem;
    }
    .spinner {
      width: 52px; height: 52px;
      border: 4px solid #333;
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.6rem; font-weight: 600; }
    p  { font-size: 0.95rem; color: #888; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <h1>Building 9Router…</h1>
  <p>This page will refresh automatically when the build is ready.</p>
</body>
</html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`[build-splash] Serving building page at http://localhost:${PORT}`);
  runBuild();
});

function runBuild() {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'next.cmd' : 'next';
  const args = ['build', '--webpack'];

  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, NODE_ENV: 'production' },
  });

  child.on('close', (code) => {
    console.log(`[build-splash] Build finished (exit ${code}). Stopping splash server.`);
    server.close(() => process.exit(code ?? 0));
  });
}
