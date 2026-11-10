// Opens the data folder named in DATA_DIR with the database code given as the first argument, then closes it: what
// a start of the server does to the database, without the server. The upgrade tests run it with the code as it was
// before people could be saved without a job (test/fixtures/before-pool*/db.js) and with the code as it is now.
//
// With STOP_AT=n the process is killed outright just before the n-th statement that can change the database, as a
// start cut off at that point would be: nothing after it runs, and nothing is tidied up. With DISK_FULL=1 the disk
// runs out in the middle of the upgrade (see below).
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

// With DISK_FULL=1 the disk "fills up" while the first table is being copied into its rebuilt form. SQLite then does
// two things, and both are done here as it does them: it undoes the transaction by itself, and it fails the
// statement with "database or disk is full". (Seen on a real full disk; nothing less than one makes SQLite do it.)
if (process.env.DISK_FULL) {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (/^INSERT INTO \w+__new /.test(sql)) {
      exec.call(this, 'ROLLBACK');
      throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full' });
    }
    return exec.call(this, sql);
  };
}

const { db } = await import(pathToFileURL(process.argv[2]).href);
db.close();
