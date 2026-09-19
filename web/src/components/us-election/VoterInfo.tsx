import { useEffect, useState } from "react";

import { apiService } from "@/lib/api";

/**
 * How to vote where you are looking.
 *
 * This shows LINKS, not rules. ID requirements, registration deadlines and
 * early-voting windows change, they differ by county inside a state, and a
 * reader who acts on a stale one can lose their vote — so the office that
 * decides them is what gets surfaced, and it is always right by definition.
 *
 * The links themselves are verified before they are stored: usa.gov's own
 * directory had four dead entries when this was built, and a dead link here is
 * worse than no link, because it reads as "there is nowhere to go".
 */

interface Office {
  _id: string;
  name: string;
  election_office_url: string;
  url_corrected?: boolean;
}

/** "ocd-division/country:us/state:tx/county:harris" -> "TX" */
export function stateOf(ocdId: string): string | null {
  const m = /\/state:([a-z]{2})\b/.exec(ocdId || "");
  return m ? m[1].toUpperCase() : null;
}

export default function VoterInfo({ ocdId }: { ocdId: string }) {
  const [office, setOffice] = useState<Office | null>(null);
  const [state, setState] = useState<string | null>(null);

  useEffect(() => {
    const st = stateOf(ocdId);
    setState(st);
    setOffice(null);
    if (!st) return;
    let alive = true;
    apiService({ method: "get", url: `/us-election/voter-info?state=${st}` })
      .then((r) => { if (alive) setOffice(r?.data?.data?.office ?? null); })
      .catch(() => { /* the panel simply does not appear */ });
    return () => { alive = false; };
  }, [ocdId]);

  if (!state || !office) return null;

  return (
    <section className="mb-4 rounded-xl border border-emerald-600/25 bg-emerald-50/70 px-3 py-2.5 dark:border-emerald-400/20 dark:bg-emerald-950/30">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-400">
        Voting in {office.name}
      </h3>
      <a
        href={office.election_office_url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 block truncate text-xs font-semibold text-emerald-900 underline decoration-emerald-600/40 underline-offset-2 hover:decoration-emerald-600 dark:text-emerald-200"
      >
        {office.name} election office ↗
      </a>
      <p className="mt-1 text-[10px] leading-relaxed text-emerald-900/70 dark:text-emerald-200/70">
        Registration, ID requirements, deadlines and your polling place are set
        by the state and can differ by county. We link to the office that
        decides them rather than copying rules that go stale.
      </p>
    </section>
  );
}
