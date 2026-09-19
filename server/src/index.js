require("dotenv").config();

const path = require("path");
const express = require("express");

const routes = require("./routes");

/**
 * ElectionIntOS — the US election dashboard, standalone.
 *
 * One process serves both halves: the API under /api/us-election, and the
 * built web app as static files with an SPA fallback. The parent deployment
 * splits these across two containers behind nginx; here a single port is the
 * whole point, so the dashboard can be run and tested without the rest of the
 * platform standing up.
 *
 * PMTiles are proxied rather than copied. The archive is 53 MB with a content
 * hash in its name, read over HTTP range requests, and duplicating it here
 * would mean two copies drifting apart on the next tile build. TILES_ORIGIN
 * points at whoever already serves it.
 */
const app = express();
const PORT = Number(process.env.PORT) || 3050;
const TILES_ORIGIN = process.env.TILES_ORIGIN || "https://app.perspectivity.co";

app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

app.use("/api/us-election", routes);

/**
 * Range requests matter here and are easy to lose: PMTiles reads slices of a
 * 53 MB archive, so forwarding the Range header and passing back 206 with its
 * Content-Range is the difference between a working map and a 53 MB download
 * per pan.
 */
app.get("/tiles/*", async (req, res) => {
  try {
    const upstream = `${TILES_ORIGIN}${req.originalUrl}`;
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await fetch(upstream, { headers });
    res.status(r.status);
    for (const h of ["content-type", "content-length", "content-range",
                     "accept-ranges", "etag", "cache-control"]) {
      const v = r.headers.get(h);
      if (v) res.set(h, v);
    }
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ success: false, message: `tiles upstream: ${err.message}` });
  }
});

// Built web app. Absent until `npm run build` has run in web/, so say that
// plainly instead of serving a 404 that looks like a routing bug.
const dist = path.join(__dirname, "..", "..", "web", "dist");
const fs = require("fs");
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false }));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  app.get("*", (_req, res) => res.status(503).type("text/plain").send(
    "web/dist not built yet — run `npm run build` in web/, or use `npm run dev` for the Vite server."));
}

app.listen(PORT, () => {
  console.log(`[ElectionIntOS] http://localhost:${PORT}`);
  console.log(`[ElectionIntOS] tiles proxied from ${TILES_ORIGIN}`);
});
