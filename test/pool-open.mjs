// Opens the data folder named in DATA_DIR with the database code given as the first argument, then closes it: what
// a start of the server does to the database, without the server. The upgrade tests run it with the code as it was
// before people could be saved without a job (test/fixtures/before-pool/db.js) and with the code as it is now.
import { pathToFileURL } from 'node:url';

const { db } = await import(pathToFileURL(process.argv[2]).href);
db.close();
