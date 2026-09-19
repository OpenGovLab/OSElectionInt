import assert from "node:assert/strict";
import test from "node:test";

import { parseMapCommand } from "./map-commands";

/**
 * Grammar tests.
 *
 * NOTE: this project has no test runner wired yet (package.json has dev,
 * build and preview only). These are written against `node:test` so they run
 * unchanged once one is added. `node --test` cannot execute them directly
 * today: the file is TypeScript and map-commands.ts imports through the `@/`
 * alias, so it needs a transform and an alias resolver — vitest with the
 * existing vite config would supply both.
 *
 * Every expectation below was verified against the real parser before it was
 * written down, rather than asserted from reading the regexes.
 */

test("recognises each command type", () => {
  assert.deepEqual(parseMapCommand("help"), { type: "help" });
  assert.deepEqual(parseMapCommand("reset view"), { type: "reset" });
  assert.deepEqual(parseMapCommand("zoom in"), { type: "zoom", delta: 1 });
  assert.deepEqual(parseMapCommand("zoom out"), { type: "zoom", delta: -1 });
  assert.deepEqual(parseMapCommand("globe"), { type: "projection", globe: true });
  assert.deepEqual(parseMapCommand("2d"), { type: "projection", globe: false });
  assert.deepEqual(parseMapCommand("play timeline"), { type: "play" });
  assert.deepEqual(parseMapCommand("satellite"),
    { type: "basemap", basemap: "satellite" });
  assert.deepEqual(parseMapCommand("2016"), { type: "year", year: 2016 });
  assert.deepEqual(parseMapCommand("show senate"),
    { type: "office", office: "us_senate" });
  assert.deepEqual(parseMapCommand("show counties"),
    { type: "level", level: "county" });
  assert.deepEqual(parseMapCommand("show news"),
    { type: "layer", layer: "news", enabled: true });
});

test("accepts the alias forms", () => {
  // offices
  assert.deepEqual(parseMapCommand("potus"), { type: "office", office: "president" });
  assert.deepEqual(parseMapCommand("gubernatorial"),
    { type: "office", office: "governor" });
  // layers, including the on/off synonyms
  assert.deepEqual(parseMapCommand("show booths"),
    { type: "layer", layer: "polls", enabled: true });
  assert.deepEqual(parseMapCommand("turn on polls"),
    { type: "layer", layer: "polls", enabled: true });
  assert.deepEqual(parseMapCommand("hide news"),
    { type: "layer", layer: "news", enabled: false });
  // a two-word level that must not be read as the "house" office
  assert.deepEqual(parseMapCommand("show state house"),
    { type: "level", level: "sldl" });
  // a bare year and a navigated one are the same command
  assert.deepEqual(parseMapCommand("go to 2016"), { type: "year", year: 2016 });
});

test("office wins over level where the word is ambiguous", () => {
  // "congressional" is both an office adjective and a level name. The office
  // reading is the documented precedence.
  assert.deepEqual(parseMapCommand("show congressional"),
    { type: "office", office: "us_house" });
});

test("parses coordinates and rejects out-of-range ones", () => {
  assert.deepEqual(parseMapCommand("go to 30.2672, -97.7431"),
    { type: "coordinates", lat: 30.2672, lng: -97.7431 });
  // latitude past the pole and longitude past the antimeridian
  assert.equal(parseMapCommand("go to 200, 300"), null);
  assert.equal(parseMapCommand("go to 91, 0"), null);
  assert.equal(parseMapCommand("go to 0, 181"), null);
});

test("keeps the original casing of a place name", () => {
  assert.deepEqual(parseMapCommand("fly to Texas"),
    { type: "locate", query: "Texas" });
  assert.deepEqual(parseMapCommand("fly to Travis County"),
    { type: "locate", query: "Travis County" });
  // A stripped politeness prefix shortens the lowercased string but not the
  // original, so the slice that recovers the casing works from the END.
  assert.deepEqual(parseMapCommand("please fly to Ohio"),
    { type: "locate", query: "Ohio" });
});

test("an unresolvable place is still a place command, not a null", () => {
  // "show me" is a locate prefix, so this parses rather than returning null.
  // That is correct: the grammar's job is to classify, and the failure to
  // find anything called "everything about texas politics" belongs to the
  // resolver, which says so plainly. Asserting null here would have encoded
  // the opposite expectation.
  assert.deepEqual(parseMapCommand("show me everything about texas politics"), {
    type: "locate", query: "everything about texas politics",
  });
});

test("returns null rather than guessing", () => {
  assert.equal(parseMapCommand("banana"), null);
  assert.equal(parseMapCommand(""), null);
  assert.equal(parseMapCommand("   "), null);
  // A word that exists on Object.prototype must not match a command table.
  assert.equal(parseMapCommand("show constructor"), null);
  assert.equal(parseMapCommand("show toString"), null);
});
