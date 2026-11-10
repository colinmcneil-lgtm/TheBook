// The Book's API on its own, for the to-do tests: the same routes and the same database code as the real server,
// without the pages, plus one extra route that only exists here: POST /test/clock tells the to-do module what time
// it is. People go on the To prep list seven days before an interview and on To debrief when it has ended, so the
// tests have to let days pass without waiting. Only the to-do module's clock moves; everything else in the server
// keeps the real time.
import express from 'express';
import { api } from '../server/api.js';
import { db } from '../server/db.js';
import { setTodoClock } from '../server/todos.js';

const app = express();
app.post('/test/clock', express.json(), (req, res) => {
  const at = req.body?.now ? new Date(req.body.now) : null;
  if (at && Number.isNaN(at.getTime())) return res.status(400).json({ error: 'Not a time.' });
  setTodoClock(at ? () => new Date(at) : null);
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
