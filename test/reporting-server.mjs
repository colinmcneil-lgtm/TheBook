// The Book's API on its own, for the reporting tests: the same routes and the same database code as the real server,
// without the pages, plus one extra route that only exists here: POST /test/clock tells the reporting module what
// time it is. The reports count nothing before a start date, so the tests have to act out stories on either side of
// that date, and a year apart, without waiting. Only the reporting module's clock moves; everything else in the
// server keeps the real time.
import express from 'express';
import { api } from '../server/api.js';
import { db, setSetting } from '../server/db.js';
import { setReportClock } from '../server/reporting.js';

// The server notes the day it first ran, with the real clock, to know whether it was there when counting started.
// A story told with a made-up clock says when that was, too.
if (process.env.REPORTS_FIRST_RUN) setSetting('reports_first_run', process.env.REPORTS_FIRST_RUN);

const app = express();
app.post('/test/clock', express.json(), (req, res) => {
  const at = req.body?.now ? new Date(req.body.now) : null;
  if (at && Number.isNaN(at.getTime())) return res.status(400).json({ error: 'Not a time.' });
  setReportClock(at ? () => new Date(at) : null);
  res.json({ ok: true });
});
app.use('/api', api);
const port = Number(process.env.PORT);
const server = app.listen(port, '127.0.0.1', () => console.log(`The Book's API is running on http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => { db.close(); process.exit(0); });
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
