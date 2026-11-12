#!/usr/bin/env node
/**
 * 本地預覽伺服器（零依賴）。
 *
 *   node src/dev-server.mjs                 # http://127.0.0.1:8790/
 *   PORT=9000 node src/dev-server.mjs
 *   BASE=/jyut6din2-apk node src/dev-server.mjs   # 模擬 GitHub Pages 子路徑
 *
 * 只提供 public/ 內的靜態檔案；搜尋與詞條資料都是預先產生的 JSON。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'public');
const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = (process.env.BASE || '').replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gz': 'application/gzip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (BASE) {
    if (pathname === BASE || pathname === `${BASE}/`) {
      pathname = '/';
    } else if (pathname.startsWith(`${BASE}/`)) {
      pathname = pathname.slice(BASE.length);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(ROOT, pathname));

  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    fs.readFile(file, (readErr, buf) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Read error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': buf.length,
      });
      res.end(buf);
    });
  });
});

server.listen(PORT, HOST, () => {
  const base = BASE ? `${BASE}/` : '/';
  const url = `http://${HOST}:${PORT}${base}`;
  console.log(`預覽：${url}`);
  console.log(`根目錄：${ROOT}`);

  if (process.env.OPEN_BROWSER) {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      console.log('（無法自動開啟瀏覽器，請手動打開上面的網址）');
    }
  }
});
