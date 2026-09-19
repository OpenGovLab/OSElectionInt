const mongoose = require("mongoose");

/**
 * One database, one connection.
 *
 * The parent app is multi-tenant: it keeps several connections and picks one
 * per request from an X-Site header, which is why every query there routes
 * through getModelForLanguage(collection, lang, country). OSElectionInt serves
 * a single tenant, so that indirection would be ceremony — but the controller
 * is copied from there and calls it on every query, so the shape is kept and
 * the arguments are ignored. Keeping the signature means the controller can be
 * diffed against its origin, and a fix in either can be carried across.
 */
const conn = mongoose.createConnection(
  process.env.MONGODB_URL
    || "mongodb://localhost:27017/google_news_database_en_usa",
  { serverSelectionTimeoutMS: 10000 },
);

conn.on("connected", () => console.log("[db] connected"));
conn.on("error", (e) => console.error("[db] error:", e.message));

// Every collection here is written by python/us_election and read as-is, so a
// strict schema would only be a second place to keep the field list correct.
const loose = new mongoose.Schema({}, { strict: false, versionKey: false });
const models = new Map();

const getModelForLanguage = (collectionName) => {
  if (!models.has(collectionName)) {
    models.set(collectionName, conn.model(collectionName, loose, collectionName));
  }
  return models.get(collectionName);
};

module.exports = { conn, getModelForLanguage };
