/**
 * In-process response cache.
 *
 * The parent app uses Redis because it runs several replicas that should share
 * a cache. This is one process, so a Map is the whole requirement — and it
 * removes Redis from the list of things that must be running before the
 * dashboard will start.
 *
 * Entries are capped and evicted oldest-first so a long-lived process cannot
 * grow without bound on bbox queries, which have effectively unlimited
 * distinct keys.
 */
const MAX_ENTRIES = 500;
const store = new Map();

const cacheMiddleware = (seconds = 3600) => (req, res, next) => {
  const key = req.originalUrl || req.url;
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) {
    res.set("X-Cache", "HIT");
    return res.json(hit.body);
  }
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
      store.set(key, { body, expires: Date.now() + seconds * 1000 });
    }
    res.set("X-Cache", "MISS");
    return json(body);
  };
  next();
};

module.exports = cacheMiddleware;
