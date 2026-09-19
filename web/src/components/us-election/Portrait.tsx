import { useEffect, useState } from "react";

/**
 * A candidate's face, or their initials.
 *
 * Portraits come from two public-domain sources, linked by
 * python/us_election/link_portraits.py: the unitedstates/images set for
 * anyone who has served in Congress, and Wikimedia Commons for presidents
 * and governors, who have no Bioguide ID to key on.
 *
 * Coverage is partial by construction — a first-time state-house candidate
 * has no free portrait anywhere — so the initials fallback is the NORMAL
 * outcome, not an error state, and has to look deliberate rather than
 * broken. It is also what renders when a linked image 404s, which happens:
 * a Bioguide ID can exist for someone the photo set never covered.
 */

const initials = (name: string) =>
  name
    .replace(/[^A-Za-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !["Jr", "Sr", "II", "III", "IV"].includes(w))
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

/** The ring carries party, so the fallback is never a colourless grey disc. */
const ring = (party?: string) =>
  party === "DEM" ? "ring-blue-500/70"
    : party === "REP" ? "ring-red-500/70"
      : "ring-slate-400/60";

const tint = (party?: string) =>
  party === "DEM" ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
    : party === "REP" ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";

export default function Portrait({
  src, name, party, size = 32, className = "",
}: {
  src?: string | null;
  name: string;
  party?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A recycled component instance (the sheet swaps candidates in place) must
  // not keep the previous person's failure and hide a face that does load.
  useEffect(() => { setFailed(false); }, [src]);

  const box = { width: size, height: size };
  const shell =
    `shrink-0 overflow-hidden rounded-full ring-1 ${ring(party)} ${className}`;

  if (!src || failed) {
    return (
      <span
        style={box}
        aria-hidden
        className={`${shell} ${tint(party)} flex items-center justify-center font-semibold`}
      >
        <span style={{ fontSize: Math.max(9, Math.round(size * 0.36)) }}>
          {initials(name)}
        </span>
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      style={box}
      loading="lazy"
      decoding="async"
      // These are third-party CDNs; there is no reason to hand them the
      // reader's page URL along with the request for a face.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${shell} bg-slate-100 object-cover dark:bg-slate-800`}
    />
  );
}
