// Opens the data folder named in DATA_DIR with the database code given as the first argument, then closes it: what
// a start of the server does to the database, without the server. The upgrade tests run it with the code as it was
// before people could be saved without a job (test/fixtures/before-pool*/db.js) and with the code as it is now.
//
// With STOP_AT=n the process is killed outright just before the n-th statement that can change the database, as a
// start cut off at that point would be: nothing after it runs, and nothing is tidied up.
import { pathToFileURL } from 'node:url';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const stopAt = Number(process.env.STOP_AT) || 0;
if (stopAt) {
  let seen = 0;
  const counted = (original) => function (...args) {
    if (++seen === stopAt) {
      process.kill(process.pid, 'SIGKILL');
      for (;;) { /* wait here for the kill to land, so that nothing more is written */ }
    }
    return original.apply(this, args);
  };
  DatabaseSync.prototype.exec = counted(DatabaseSync.prototype.exec);
  StatementSync.prototype.run = counted(StatementSync.prototype.run);
}

const { db } = await import(pathToFileURL(process.argv[2]).href);
db.close();
