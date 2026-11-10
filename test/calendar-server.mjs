// The Book's API on its own, for the calendar tests: the same routes and the same database code as the real server,
// without the pages. The real server (server/index.js) either serves the built pages, which needs NODE_ENV=production,
// or starts the development page builder, which opens a port of its own. The calendar tests need neither, and they
// need NODE_ENV to be something other than production, because reading calendar files from a folder
// (CALENDAR_TEST_FILES) is refused in production.
import express from 'express';
import { api } from '../server/api.js';
import { db } from '../server/db.js';

const app = express();
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
