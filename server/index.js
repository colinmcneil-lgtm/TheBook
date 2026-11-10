import express from 'express';
import path from 'node:path';
import { api } from './api.js';
import { db } from './db.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// How many reverse proxies sit in front of the app. This decides whose address rate limits apply to, so it must be
// right: 0 when the app is reached directly, 1 behind a platform's proxy (Railway, Render, Fly), 2 with a CDN as well.
// Those platforms are detected automatically; set TRUST_PROXY to override.
const onPlatform = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RENDER || process.env.FLY_APP_NAME);
const requested = (process.env.TRUST_PROXY || '').trim().toLowerCase();
function proxySetting() {
  if (!requested) return onPlatform ? 1 : false;
  if (/^\d+$/.test(requested)) return Number(requested) || false;
  if (requested === 'true') return 1;
  if (requested === 'false') return false;
  return requested; // a list of proxy addresses or subnets
}
try {
  app.set('trust proxy', proxySetting());
} catch {
  console.error(`TRUST_PROXY="${process.env.TRUST_PROXY}" is not valid (use a number of proxies, or a list of their addresses). Trusting none.`);
  app.set('trust proxy', false);
}
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  // Browsers ignore this header on plain http, so honouring the proxy's word for "https" is safe even when the proxy is not trusted.
  if (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (isProd) {
    // The dev server needs inline scripts and a websocket for hot reload, so the policy is production-only.
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  }
  next();
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store'); // candidate data must not sit in shared caches
  next();
});
app.use('/api', api);

if (isProd) {
  app.use(express.static(path.resolve('dist'), { index: false, maxAge: '1h' }));
  // Built files have their contents in their names, and each release has new ones. A name that is not there is an
  // old tab asking for a file from before the last release: say so plainly, rather than sending the page in its place.
  app.use('/assets', (req, res) => res.status(404).type('text/plain').send('Not found'));
  // The page itself names those files, so it is checked with the server on every visit and a tab opened after a
  // release always starts from the current ones.
  app.get(/.*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.resolve('dist/index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const server = app.listen(PORT, () => console.log(`The Book is running on http://localhost:${PORT}`));

// Stop cleanly when the host asks (deploys, restarts): finish open requests, then close the database.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => { db.close(); process.exit(0); });
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
