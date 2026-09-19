/**
 * Backend selection.
 *
 * DATA_BACKEND picks the storage engine at startup. Mongo is the default, so
 * an existing deployment that sets nothing keeps working exactly as before.
 *
 * The supabase module is required LAZILY, inside its branch. A Mongo
 * deployment then never needs @supabase/supabase-js installed — requiring it
 * at the top would make an optional dependency mandatory for everyone. It
 * still resolves at STARTUP rather than on first request, so a missing module
 * or bad config kills the process with a clear message instead of turning
 * every API call into a 500 an hour later.
 */

const VALID = ["mongo", "supabase"];

const backend = String(process.env.DATA_BACKEND || "mongo").toLowerCase();

let repo;
if (backend === "mongo") {
  repo = require("./mongo");
} else if (backend === "supabase") {
  try {
    repo = require("./supabase");
  } catch (err) {
    throw new Error(
      `DATA_BACKEND=supabase but the Supabase backend could not be loaded: `
      + `${err.message}\n`
      + `Install its dependencies (npm i @supabase/supabase-js) and set `
      + `SUPABASE_URL and SUPABASE_SERVICE_KEY, or set DATA_BACKEND=mongo.`,
    );
  }
} else {
  throw new Error(
    `DATA_BACKEND="${backend}" is not a valid backend. `
    + `Expected one of: ${VALID.join(", ")}.`,
  );
}

console.log(`[data] backend: ${backend}`);

module.exports = repo;
