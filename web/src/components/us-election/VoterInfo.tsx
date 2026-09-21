import { useEffect, useState } from "react";

import { apiService } from "@/lib/api";

/**
 * How to vote where you are looking.
 *
 * This is the one panel in the product where being unclear has a direct
 * consequence: someone turns up unable to vote. Three rules follow from that.
 *
 * Rules are shown VERBATIM. Every string here is the source's own wording,
 * never shortened or smoothed — "Begins 17 days before Election Day (unless
 * the 17th day is a national holiday or weekend...)" keeps its exception
 * because the exception is the part that catches people. Paraphrasing a legal
 * rule into something tidier always makes it more confident than the source.
 *
 * The official links stay visible throughout rather than sitting at the
 * bottom. They are the authority, they are right by definition, and they keep
 * working when this summary goes stale.
 *
 * `voter_id.strictness` is null for all 51 states and nothing is rendered for
 * it. That taxonomy is NCSL's, NCSL blocks automated access, and inferring
 * "strict photo ID" from prose would be guessing at the single field where a
 * wrong answer turns a voter away.
 */

interface Sourced {
  source?: string | null;
  source_url?: string | null;
  checked_at?: string | null;
}

interface Office {
  _id: string;
  name: string;
  election_office_url?: string | null;
  caveat?: string | null;
  enriched_at?: string | null;
  checked_at?: string | null;
  voter_id?: (Sourced & {
    in_person?: string | null;
    absentee?: string | null;
    /** Always null — see the note above. Deliberately unused. */
    strictness?: string | null;
    strictness_note?: string | null;
  }) | null;
  registration?: (Sourced & {
    deadlines?: string | null;
    election_day_registration?: string | null;
    same_day?: boolean | null;
  }) | null;
  mail_voting?: (Sourced & {
    application_deadline?: string | null;
    ballot_due?: string | null;
    rules?: string | null;
    no_excuse?: boolean | null;
    rules_source_url?: string | null;
  }) | null;
  early_voting?: (Sourced & {
    offered?: boolean | null;
    begins?: string | null;
    ends?: string | null;
    more_info?: string | null;
  }) | null;
  official_links?: {
    election_office?: string | null;
    ballot_tracker?: string | null;
    note?: string | null;
  } | null;
}

/** "ocd-division/country:us/state:tx/county:harris" -> "TX" */
export function stateOf(ocdId: string): string | null {
  const m = /\/state:([a-z]{2})\b/.exec(ocdId || "");
  return m ? m[1].toUpperCase() : null;
}

/** Stroke idiom shared with the map toolbar: 24-unit box, no fill. */
const svg = (children: JSX.Element) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5 shrink-0"
    aria-hidden
  >
    {children}
  </svg>
);

const ICON = {
  office: svg(<><path d="M3 21h18" /><path d="M5 21V8l7-4 7 4v13" /><path d="M10 21v-5h4v5" /></>),
  tracker: svg(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>),
  calendar: svg(<><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3.5v3M16 3.5v3" /></>),
  mail: svg(<><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3.5 7.5l8.5 6 8.5-6" /></>),
  id: svg(<><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><circle cx="9" cy="11" r="2.2" /><path d="M14 10h4M14 13.5h4M5.8 16c.6-1.5 1.8-2.2 3.2-2.2s2.6.7 3.2 2.2" /></>),
  clock: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></>),
};

function checkedOn(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A rule shown in full, with the source it came from. */
function Rule({
  icon, label, text, sourceUrl, tone = "normal",
}: {
  icon: JSX.Element;
  label: string;
  text: string;
  sourceUrl?: string | null;
  tone?: "normal" | "lead";
}) {
  return (
    <div className={tone === "lead"
      ? "rounded-md border border-emerald-600/25 bg-white/60 px-2.5 py-2 dark:border-emerald-400/20 dark:bg-emerald-950/40"
      : "px-0.5 py-1.5"}>
      <div className="flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300">
        {icon}
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.16em]">
          {label}
        </span>
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Source for this rule"
            className="ml-auto font-mono text-[8px] uppercase tracking-wider text-emerald-700/60 underline-offset-2 hover:underline dark:text-emerald-400/60"
          >
            source ↗
          </a>
        )}
      </div>
      {/* Verbatim. whitespace-pre-line keeps any line breaks the source had. */}
      <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-slate-700 dark:text-slate-200">
        {text}
      </p>
    </div>
  );
}

/**
 * Long prose behind an expander.
 *
 * Collapsed shows the LABEL only, never a truncated first slice of the rule.
 * Texas's ID text lists every acceptable document; cutting it at n characters
 * would end mid-list and read as though the list were complete.
 */
function Expandable({
  icon, label, text, sourceUrl,
}: {
  icon: JSX.Element;
  label: string;
  text: string;
  sourceUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-emerald-700/15 py-1.5 dark:border-emerald-400/10">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-emerald-800 dark:text-emerald-300"
      >
        {icon}
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.16em]">
          {label}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider text-emerald-700/60 dark:text-emerald-400/60">
          {open ? "hide" : "read"}
        </span>
      </button>
      {open && (
        <>
          <p className="mt-1.5 whitespace-pre-line text-[11px] leading-relaxed text-slate-700 dark:text-slate-200">
            {text}
          </p>
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block font-mono text-[8px] uppercase tracking-wider text-emerald-700/60 underline-offset-2 hover:underline dark:text-emerald-400/60"
            >
              source ↗
            </a>
          )}
        </>
      )}
    </div>
  );
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

  const links = office.official_links ?? {};
  const officeUrl = links.election_office || office.election_office_url || null;
  const tracker = links.ballot_tracker || null;
  const reg = office.registration ?? null;
  const mail = office.mail_voting ?? null;
  const early = office.early_voting ?? null;
  const id = office.voter_id ?? null;
  const checked = checkedOn(office.enriched_at || office.checked_at);

  return (
    <section className="mb-4 rounded-xl border border-emerald-600/25 bg-emerald-50/70 px-3 py-2.5 dark:border-emerald-400/20 dark:bg-emerald-950/30">
      <h3 className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-400">
        Voting in {office.name}
      </h3>

      {/* The authority, kept at the top and always visible. Everything below
          is a compiled summary; these two are the real answer. */}
      {(officeUrl || tracker) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {officeUrl && (
            <a
              href={officeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-[4px] bg-emerald-600 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-white transition-colors hover:bg-emerald-500"
            >
              {ICON.office}
              Check your registration
            </a>
          )}
          {tracker && (
            <a
              href={tracker}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-[4px] border border-emerald-600/50 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-emerald-800 transition-colors hover:bg-emerald-600/10 dark:text-emerald-300"
            >
              {ICON.tracker}
              Track your ballot
            </a>
          )}
        </div>
      )}

      {/* ── the two things that expire ── */}
      {(reg?.deadlines || mail?.application_deadline || mail?.ballot_due) && (
        <div className="mt-2.5 space-y-1.5">
          {reg?.deadlines && (
            <Rule
              tone="lead"
              icon={ICON.calendar}
              label="Register by"
              text={reg.deadlines}
              sourceUrl={reg.source_url}
            />
          )}
          {/* Missing the deadline is not always fatal, so this is surfaced
              rather than left buried in the prose above.

              The label is a QUESTION and the answer is the source's own
              words, because the obvious generated sentence — "<State> offers
              same-day registration" — is false in North Dakota, which has
              `same_day: true` only because it requires no registration at
              all. Asserting it there would have contradicted the verbatim
              text printed directly beneath it. All 25 same-day states carry
              this string, so nothing is lost by refusing to generate one. */}
          {reg?.same_day === true && reg.election_day_registration && (
            <Rule
              icon={ICON.calendar}
              label="If you miss the deadline"
              text={reg.election_day_registration}
              sourceUrl={reg.source_url}
            />
          )}
          {mail?.application_deadline && (
            <Rule
              tone="lead"
              icon={ICON.mail}
              label="Request a mail ballot by"
              text={mail.application_deadline}
              sourceUrl={mail.source_url}
            />
          )}
          {mail?.ballot_due && (
            <Rule
              tone="lead"
              icon={ICON.mail}
              label="Return your mail ballot by"
              text={mail.ballot_due}
              sourceUrl={mail.source_url}
            />
          )}
        </div>
      )}

      {/* ── early voting ── */}
      {early && (early.offered === false || early.begins || early.ends) && (
        <div className="mt-2 border-t border-emerald-700/15 pt-1.5 dark:border-emerald-400/10">
          <div className="flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300">
            {ICON.clock}
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.16em]">
              Early voting
            </span>
            {early.source_url && (
              <a
                href={early.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto font-mono text-[8px] uppercase tracking-wider text-emerald-700/60 underline-offset-2 hover:underline dark:text-emerald-400/60"
              >
                source ↗
              </a>
            )}
          </div>
          {early.offered === false ? (
            <p className="mt-1 text-[11px] leading-relaxed text-slate-700 dark:text-slate-200">
              {early.begins || `${office.name} does not offer early voting.`}
            </p>
          ) : (
            <div className="mt-1 space-y-0.5 text-[11px] leading-relaxed text-slate-700 dark:text-slate-200">
              {early.begins && (
                <p><span className="text-slate-500 dark:text-slate-400">Begins: </span>{early.begins}</p>
              )}
              {early.ends && (
                <p><span className="text-slate-500 dark:text-slate-400">Ends: </span>{early.ends}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── the long prose, behind expanders ── */}
      <div className="mt-1.5">
        {id?.in_person && (
          <Expandable
            icon={ICON.id}
            label="ID to vote in person"
            text={id.in_person}
            sourceUrl={id.source_url}
          />
        )}
        {id?.absentee && (
          <Expandable
            icon={ICON.id}
            label="ID to vote by mail"
            text={id.absentee}
            sourceUrl={id.source_url}
          />
        )}
        {mail?.rules && (
          <Expandable
            icon={ICON.mail}
            label="Who can vote by mail"
            text={mail.rules}
            sourceUrl={mail.rules_source_url || mail.source_url}
          />
        )}
      </div>

      {/* ── provenance, quiet but legible ── */}
      <p className="mt-2 border-t border-emerald-700/15 pt-1.5 text-[9px] leading-relaxed text-emerald-900/60 dark:border-emerald-400/10 dark:text-emerald-200/50">
        {office.caveat
          || "Summary compiled from the cited sources. The state's own election "
            + "office is the authority and governs."}
        {checked ? ` Checked ${checked}.` : ""}
      </p>
    </section>
  );
}
