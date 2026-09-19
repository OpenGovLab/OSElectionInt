import { LEVELS, OFFICES } from "@/config/usElectionMap";
import { OVERLAYS } from "@/config/usElectionLayers";

/**
 * A fixed command grammar for the map.
 *
 * Adapted from OSIRIS's command panel. The important property, and the reason
 * it is worth having next to an Ask panel that already talks to a model: this
 * parser uses NO AI. It is a handful of regexes over a closed vocabulary, so
 * it is instant, free, works offline, and — the part that matters — it either
 * recognises a command exactly or does nothing at all. A navigation control
 * that silently guesses wrong is worse than one that says "I don't know that".
 *
 * Ask answers questions about the DATA. This drives the INTERFACE. Keeping
 * them separate means neither has to be reliable at the other's job.
 */

export type MapCommand =
  | { type: "locate"; query: string }
  | { type: "coordinates"; lat: number; lng: number }
  | { type: "zoom"; delta: number }
  | { type: "reset" }
  | { type: "projection"; globe: boolean }
  | { type: "basemap"; basemap: "light" | "dark" | "satellite" }
  | { type: "office"; office: string }
  | { type: "level"; level: string }
  | { type: "year"; year: number }
  | { type: "play" }
  | { type: "layer"; layer: string; enabled: boolean }
  | { type: "help" };

/** Spoken and typed aliases for the overlay registry. */
const LAYER_WORDS: Record<string, string> = {
  news: "news", coverage: "news", stories: "news",
  races: "races", contests: "races", money: "races",
  homes: "homes", "home towns": "homes", hometowns: "homes",
  polls: "polls", "polling places": "polls", booths: "polls",
};

/** Office aliases. The registry ids are us_senate / us_house / etc. */
const OFFICE_WORDS: Record<string, string> = {
  president: "president", presidential: "president", potus: "president",
  senate: "us_senate", "us senate": "us_senate", senator: "us_senate",
  house: "us_house", "us house": "us_house", congress: "us_house",
  congressional: "us_house", governor: "governor", governors: "governor",
  gubernatorial: "governor",
};

const LEVEL_WORDS: Record<string, string> = {
  states: "state", state: "state",
  counties: "county", county: "county",
  districts: "cd", district: "cd", congressional: "cd", cd: "cd",
  "state senate": "sldu", sldu: "sldu",
  "state house": "sldl", sldl: "sldl",
};

/**
 * Own-property lookup. Object.hasOwn needs an es2022 lib target and this
 * project targets lower; going through the prototype keeps a word like
 * "constructor" from matching a command.
 */
const has = (o: Record<string, string>, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);

/** Parse one line. Returns null when nothing matches — never a guess. */
export function parseMapCommand(input: string): MapCommand | null {
  const text = input.trim().replace(/^\//, "").replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  const lower = text.toLowerCase().replace(/^(?:please|can you|could you) /, "");
  if (!lower) return null;

  if (lower === "help" || lower === "commands") return { type: "help" };
  if (/^(?:reset(?: view)?|home|go home|show (?:the )?(?:whole )?(?:us|country))$/.test(lower)) {
    return { type: "reset" };
  }
  if (/^zoom (in|out)$/.test(lower)) {
    return { type: "zoom", delta: lower.endsWith("in") ? 1 : -1 };
  }
  if (/^(?:show |switch to |go )?(?:3d|globe)( view| mode)?$/.test(lower)) {
    return { type: "projection", globe: true };
  }
  if (/^(?:show |switch to |go )?(?:2d|flat|mercator)( view| map| mode)?$/.test(lower)) {
    return { type: "projection", globe: false };
  }
  if (/^(?:play|animate)(?: the)?(?: timeline| years| cycles)?$/.test(lower)) {
    return { type: "play" };
  }

  const base = lower.match(/^(?:show |switch to |use )?(satellite|dark|light)(?: (?:basemap|map|imagery|view))?$/);
  if (base) {
    return { type: "basemap", basemap: base[1] as "light" | "dark" | "satellite" };
  }

  // "show 2016" / "year 2016" / "go to 2016"
  const year = lower.match(/^(?:show |go to |jump to |year )?((?:19|20)\d{2})$/);
  if (year) return { type: "year", year: Number(year[1]) };

  const layer = lower.match(/^(show|hide|enable|disable|turn on|turn off) (.+?)(?: layer)?$/);
  if (layer && has(LAYER_WORDS, layer[2])) {
    return {
      type: "layer",
      layer: LAYER_WORDS[layer[2]],
      enabled: ["show", "enable", "turn on"].includes(layer[1]),
    };
  }

  // Office before level: "show congressional" is ambiguous, and the office
  // reading is the one a reader means far more often.
  const office = lower.match(/^(?:show |switch to )?(.+?)(?: (?:race|races|results|map))?$/);
  if (office && has(OFFICE_WORDS, office[1])) {
    return { type: "office", office: OFFICE_WORDS[office[1]] };
  }
  const level = lower.match(/^(?:show |switch to |by )?(.+?)(?: level| layer)?$/);
  if (level && has(LEVEL_WORDS, level[1])) {
    return { type: "level", level: LEVEL_WORDS[level[1]] };
  }

  const place = lower.match(/^(?:fly to|go to|navigate to|locate|find|show me|take me to) (.+)$/);
  if (place) {
    const coords = place[1].match(
      /^([+-]?\d+(?:\.\d+)?)[,\s]+([+-]?\d+(?:\.\d+)?)$/);
    if (coords) {
      const lat = Number(coords[1]);
      const lng = Number(coords[2]);
      return Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        ? { type: "coordinates", lat, lng } : null;
    }
    // Keep the ORIGINAL casing for the search: division names are proper
    // nouns and the lookup is case-sensitive on the display name.
    const raw = text.slice(text.length - place[1].length);
    return { type: "locate", query: raw };
  }
  return null;
}

export const COMMAND_EXAMPLES = [
  "fly to Texas",
  "show senate",
  "show counties",
  "show news",
  "2016",
  "globe",
  "play timeline",
  "satellite",
];

export const COMMAND_HELP =
  "Try “fly to Texas”, “show senate”, “show counties”, “show news”, “2016”, "
  + "“globe”, “play timeline”, “satellite”, “zoom in”, or “reset view”. "
  + "Commands are exact — nothing is guessed. For questions about the data, use Ask.";

/** Exposed so the panel can show what is actually available, not a fixed list. */
export const KNOWN = { OFFICES, LEVELS, OVERLAYS };
