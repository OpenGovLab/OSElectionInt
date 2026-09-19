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

/** Minimal markdown: **bold**, bullet lines, blank-line paragraphs. */
function Rendered({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const t = line.trim();
        if (!t) return <span key={i} className="block h-1.5" />;
        const bullet = /^[-*•]\s+/.test(t);
        const body = bullet ? t.replace(/^[-*•]\s+/, "") : t;
        const parts = body.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
        return (
          <span key={i} className={`block ${bullet ? "pl-3 -indent-2" : ""}`}>
            {bullet && <span className="text-slate-400">• </span>}
            {parts.map((p, j) =>
              p.startsWith("**") && p.endsWith("**")
                ? <strong key={j}>{p.slice(2, -2)}</strong>
                : <span key={j}>{p}</span>)}
          </span>
        );
      })}
    </>
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
            <p className="mb-2 text-[11px] text-slate-500 dark:text-slate-400">
              Answers come only from the data behind this map — past certified
              results, FEC filings and congressional voting records. It will say
              so when it does not know, and it will not predict winners.
            </p>
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)}
                className="mb-1.5 block w-full rounded-lg border border-black/10 px-3 py-2 text-left text-[11px] text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-slate-800">
                {s}
              </button>
            ))}
          </div>
        )}

        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            <div className={`max-w-[92%] rounded-xl px-3 py-2 text-[11px] leading-relaxed ${
              m.role === "user"
                ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                : m.error
                  ? "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300"
                  : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"}`}>
              <Rendered text={m.text} />
              {m.sources && Object.keys(m.sources).length > 0 && (
                <span className="mt-1.5 block border-t border-black/5 pt-1 text-[9px] text-slate-500 dark:border-white/10 dark:text-slate-400">
                  built from {Object.entries(m.sources).map(([k, n]) => `${n} ${k}`).join(" · ")}
                </span>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
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
          className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-xs text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-500 dark:border-white/10 dark:bg-slate-800 dark:text-slate-100"
        />
        <button type="submit" disabled={busy || !q.trim()}
          className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900">
          Ask
        </button>
      </form>
    </div>
  );
}
