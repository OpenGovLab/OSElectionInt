import { useEffect, useRef, useState } from "react";

import { apiService } from "@/lib/api";

/**
 * Ask questions about the election data.
 *
 * Answers are grounded in the same records the map is drawn from — the backend
 * resolves the entities in a question, fetches the matching rows and gives the
 * model only those. The record counts are shown with each answer so a reader
 * can see the answer had something behind it, and the model is instructed to
 * refuse rather than guess.
 */

interface Msg {
  role: "user" | "assistant";
  text: string;
  sources?: Record<string, number>;
  error?: boolean;
}

const SUGGESTIONS = [
  "Who is running in TX-28 in 2026?",
  "What Senate seats are up in Michigan?",
  "How did Pennsylvania vote for president in 2016?",
  "Tell me about Henry Cuellar's voting record",
];

/**
 * Money, percentages and margins are the payload of almost every answer, and
 * set in running prose they slide past the eye. Lifting them into tabular
 * figures with a faint tint makes an answer scannable: a reader looking for
 * "how much" finds it without reading the sentence.
 *
 * Deliberately ONE colour for all of them. D+12 and R+12 are tinted the same
 * slate-cyan here, never blue and red — that ramp is the choropleth's, it
 * encodes a continuous margin, and borrowing it for a text badge would imply
 * the prose is painted on the same scale the map is.
 */
const FIGURE_SRC =
  "\\$[\\d,]+(?:\\.\\d+)?\\s?[MBK]?\\b|\\b\\d+(?:\\.\\d+)?%|\\b[DR]\\+\\d+(?:\\.\\d+)?\\b|\\b\\d{1,3}(?:,\\d{3})+\\b";
/** Splitting needs /g; testing a piece must not, or lastIndex leaks between
 *  calls and every other figure silently fails to highlight. */
const FIGURE_SPLIT = new RegExp(`(${FIGURE_SRC})`, "g");
const FIGURE_ONE = new RegExp(`^(?:${FIGURE_SRC})$`);

function Figures({ text }: { text: string }) {
  const parts = text.split(FIGURE_SPLIT).filter((p) => p !== "");
  return (
    <>
      {parts.map((p, i) =>
        FIGURE_ONE.test(p) ? (
          <span
            key={i}
            className="rounded-[3px] bg-cyan-400/10 px-[3px] font-mono text-[10.5px] tabular-nums text-cyan-700 dark:text-cyan-300"
          >
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Inline markdown: **bold**, `code`, and figure highlighting inside both. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) {
          // Names arrive bold. They are not wired to anything yet, but they
          // are the thing a reader wants to click, so they are styled as if
          // they were rather than as flat weight.
          return (
            <strong
              key={i}
              className="font-semibold text-slate-900 decoration-cyan-400/40 decoration-dotted underline-offset-2 hover:underline dark:text-white"
            >
              <Figures text={p.slice(2, -2)} />
            </strong>
          );
        }
        if (p.startsWith("`") && p.endsWith("`")) {
          return (
            <code
              key={i}
              className="rounded-[3px] bg-slate-200/70 px-1 font-mono text-[10.5px] text-slate-700 dark:bg-slate-700/70 dark:text-slate-200"
            >
              {p.slice(1, -1)}
            </code>
          );
        }
        return <Figures key={i} text={p} />;
      })}
    </>
  );
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

/**
 * Group lines into blocks before rendering.
 *
 * The previous renderer emitted one <span class="block"> per line, which gave
 * every line identical spacing — a paragraph, a heading and a list item all
 * read as the same undifferentiated wall. Grouping first is what lets a list
 * be a list and a paragraph have rhythm.
 */
function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    const last = out[out.length - 1];

    if (!t) {
      // Blank line closes whatever was open; paragraphs keep their own break.
      if (last?.kind === "p") out.push({ kind: "p", lines: [] });
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      out.push({ kind: "h", level: h[1].length, text: h[2] });
      continue;
    }

    const ul = /^[-*•]\s+(.*)$/.exec(t);
    if (ul) {
      if (last?.kind === "ul") last.items.push(ul[1]);
      else out.push({ kind: "ul", items: [ul[1]] });
      continue;
    }

    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ol) {
      if (last?.kind === "ol") last.items.push(ol[1]);
      else out.push({ kind: "ol", items: [ol[1]] });
      continue;
    }

    if (last?.kind === "p" && last.lines.length) last.lines.push(t);
    else out.push({ kind: "p", lines: [t] });
  }
  return out.filter((b) => b.kind !== "p" || b.lines.length > 0);
}

function Rendered({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2 leading-[1.65]">
      {blocks.map((b, i) => {
        if (b.kind === "h") {
          return (
            <p
              key={i}
              className={`font-mono uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400 ${
                b.level <= 2 ? "text-[10px]" : "text-[9.5px]"
              } ${i > 0 ? "pt-1" : ""}`}
            >
              <Inline text={b.text} />
            </p>
          );
        }
        if (b.kind === "ul" || b.kind === "ol") {
          return (
            <ul key={i} className="space-y-1">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-1.5">
                  <span className="shrink-0 select-none font-mono text-[10px] text-cyan-600/70 dark:text-cyan-400/70">
                    {b.kind === "ol" ? `${j + 1}.` : "▸"}
                  </span>
                  <span className="min-w-0">
                    <Inline text={it} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            <Inline text={b.lines.join(" ")} />
          </p>
        );
      })}
    </div>
  );
}

/**
 * What the answer was built from.
 *
 * This is the trust signal, so it is legible rather than hidden — but quiet,
 * because it is provenance and not the answer. An answer with no records
 * behind it renders no chips at all, which is the honest thing for it to look
 * like.
 */
function SourceChips({ sources }: { sources: Record<string, number> }) {
  const entries = Object.entries(sources).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const total = entries.reduce((n, [, v]) => n + v, 0);
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1 border-t border-black/5 pt-1.5 dark:border-white/10"
      title={`Grounded in ${total} record${total === 1 ? "" : "s"} from the election corpus — the same rows the map is drawn from. The model was given only these.`}
    >
      <span className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
        grounded in
      </span>
      {entries.map(([k, n]) => (
        <span
          key={k}
          className="rounded-[3px] border border-cyan-400/25 bg-cyan-400/5 px-1.5 py-[1px] font-mono text-[8.5px] uppercase tracking-[0.1em] text-cyan-700 dark:text-cyan-300/90"
        >
          <span className="tabular-nums">{n}</span> {k}
        </span>
      ))}
    </div>
  );
}

export default function ElectionChat({
  ocdId, placeName, onBack,
}: { ocdId?: string; placeName?: string; onBack: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Scroll the message list itself rather than an element into view: on phones
  // the page scrolls below the map, and scrollIntoView drags the whole document
  // down so the reader lands in the site footer instead of the answer.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setQ("");
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setBusy(true);
    try {
      const r = await apiService({
        method: "post",
        url: "/us-election/chat",
        data: { question, ocd_id: ocdId },
      });
      const d = (r as { data?: { data?: { answer?: string; sources?: Record<string, unknown[]> } } })
        ?.data?.data;
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(d?.sources ?? {})) {
        if (Array.isArray(v) && v.length) counts[k] = v.length;
      }
      setMsgs((m) => [...m, {
        role: "assistant",
        text: d?.answer || "No answer came back.",
        sources: counts,
      }]);
    } catch {
      setMsgs((m) => [...m, {
        role: "assistant", error: true,
        text: "That question could not be answered right now. The election data "
          + "service may be busy — try again in a moment.",
      }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b border-black/5 px-3 py-2.5 dark:border-white/5">
        <button onClick={onBack} aria-label="Back"
          className="mt-0.5 rounded-md px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">←</button>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Ask about this election</h2>
          <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">
            {placeName ? `Focused on ${placeName}` : "Grounded in certified results, FEC filings and voting records"}
          </p>
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {msgs.length === 0 && (
          <div>
            <p className="mb-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              Answers come only from the data behind this map — past certified
              results, FEC filings and congressional voting records. It will say
              so when it does not know, and it will not predict winners.
            </p>
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)}
                className="mb-1.5 block w-full rounded-lg border border-black/10 px-3 py-2 text-left text-[11px] text-slate-700 transition-colors hover:border-cyan-400/40 hover:bg-cyan-400/5 dark:border-white/10 dark:text-slate-200 dark:hover:bg-cyan-400/5">
                {s}
              </button>
            ))}
          </div>
        )}

        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[88%] rounded-xl rounded-br-sm bg-slate-900 px-3 py-1.5 text-[11px] leading-relaxed text-white dark:bg-white dark:text-slate-900">
                {m.text}
              </div>
            </div>
          ) : (
            // A fade-in, not a typewriter. The response arrives whole, and
            // animating it character by character would be staging a live
            // generation that is not happening.
            <div key={i} className="eios-answer">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-cyan-400" />
                <span className="font-mono text-[8.5px] uppercase tracking-[0.2em] text-cyan-600/80 dark:text-cyan-400/70">
                  {m.error ? "unavailable" : "answer"}
                </span>
              </div>
              <div className={`rounded-xl px-3 py-2 text-[11px] ${
                m.error
                  ? "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300"
                  : "bg-slate-100 text-slate-800 dark:bg-slate-800/80 dark:text-slate-100"}`}>
                <Rendered text={m.text} />
                {m.sources && <SourceChips sources={m.sources} />}
              </div>
            </div>
          ),
        )}

        {busy && (
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
            reading the records…
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(q); }}
        className="flex shrink-0 gap-1.5 border-t border-black/5 p-2 dark:border-white/5"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about a race, a candidate, a result…"
          className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-xs text-slate-800 outline-none placeholder:text-slate-400 focus:border-cyan-500/60 dark:border-white/10 dark:bg-slate-800 dark:text-slate-100"
        />
        <button type="submit" disabled={busy || !q.trim()}
          className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900">
          Ask
        </button>
      </form>
    </div>
  );
}
