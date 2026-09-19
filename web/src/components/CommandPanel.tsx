import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  COMMAND_EXAMPLES,
  COMMAND_HELP,
  parseMapCommand,
  type MapCommand,
} from "@/lib/map-commands";

/**
 * Command panel — ⌘K.
 *
 * Adapted from OSIRIS's. The panel is deliberately dumb: it parses with a
 * fixed grammar, hands the result to the page, and prints whatever the page
 * says happened. It never interprets, never retries, and never guesses. When
 * parseMapCommand returns null the answer is "I don't know that one", because
 * a navigation control that acts on a half-understood instruction is worse
 * than one that declines.
 *
 * Every executed command prints a receipt. That is the entire point of the
 * log: the reader has just told the map to do something they cannot fully see
 * the result of (a level swap eight zoom levels away, an overlay off-screen),
 * so the panel states what it did.
 *
 * Speech is optional and never authoritative. The transcript lands in the
 * input for the reader to READ and submit themselves — auto-submitting a
 * transcript means a misheard word silently moves the map.
 */

/** Minimal shape of the Web Speech API; it is not in the DOM lib. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

/** One thing the reader can pick when a command was ambiguous. */
export interface CommandOption {
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/** What the page reports back. A bare string is the common case. */
export interface CommandReply {
  text: string;
  options?: CommandOption[];
}

interface Line {
  role: "you" | "sys";
  text: string;
  options?: CommandOption[];
}

const SPEECH_NOTE =
  "Speech is handled by your browser, which may send audio to its own "
  + "service. Typing works the same.";

/** Handle the page uses to open the panel from a button. */
export interface CommandHandle { open: () => void }

export default function CommandPanel({
  onCommand, controls,
}: {
  onCommand: (c: MapCommand) => CommandReply | string | Promise<CommandReply | string>;
  /** Assigned an { open } handle on mount, cleared on unmount. */
  controls?: React.MutableRefObject<CommandHandle | null>;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const speech = useRef<Recognition | null>(null);
  const log = useRef<HTMLDivElement | null>(null);

  const [value, setValue] = useState("");
  const [lines, setLines] = useState<Line[]>([{ role: "sys", text: COMMAND_HELP }]);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voice, setVoice] = useState(false);

  const say = (text: string, options?: CommandOption[]) =>
    setLines((old) => [...old.slice(-29), { role: "sys", text, options }]);

  /**
   * Drop the recogniser. Handlers are nulled BEFORE abort() because abort()
   * fires onend synchronously in some engines, and a live handler there sets
   * state on a panel the reader has just closed.
   */
  const stopSpeech = useCallback(() => {
    const r = speech.current;
    if (r) {
      r.onresult = null;
      r.onerror = null;
      r.onend = null;
      try { r.abort(); } catch { /* already dead */ }
      speech.current = null;
    }
    setListening(false);
  }, []);

  const open = useCallback(() => {
    const w = window as SpeechWindow;
    setVoice(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    if (!dialog.current?.open) dialog.current?.showModal();
    // focus after the dialog is actually in the top layer
    requestAnimationFrame(() => input.current?.focus());
  }, []);

  const close = useCallback(() => {
    stopSpeech();
    if (dialog.current?.open) dialog.current.close();
  }, [stopSpeech]);

  useEffect(() => {
    if (!controls) return;
    controls.current = { open };
    return () => { controls.current = null; };
  }, [controls, open]);

  // ⌘K / Ctrl+K anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !e.repeat) {
        e.preventDefault();
        if (dialog.current?.open) close();
        else open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Escape closes the native dialog without going through close(); the
  // recogniser has to be torn down on that path too.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const onClose = () => stopSpeech();
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, [stopSpeech]);

  // Unmount: the listener above is gone by then, so tear down here as well.
  useEffect(() => stopSpeech, [stopSpeech]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines]);

  const submit = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setLines((old) => [...old.slice(-29), { role: "you", text }]);
    setValue("");

    const cmd = parseMapCommand(text);
    if (!cmd) {
      say(`I don't know “${text}”. ${COMMAND_HELP}`);
      return;
    }
    if (cmd.type === "help") {
      say(COMMAND_HELP);
      return;
    }
    setBusy(true);
    try {
      const reply = await onCommand(cmd);
      if (typeof reply === "string") say(reply);
      else say(reply.text, reply.options);
    } catch (err) {
      say(err instanceof Error ? err.message : "That command failed.");
    } finally {
      setBusy(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [busy, onCommand]);

  const listen = useCallback(() => {
    if (listening) { stopSpeech(); return; }
    const w = window as SpeechWindow;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) { say("This browser has no speech recognition."); return; }

    const r = new Ctor();
    speech.current = r;
    r.lang = "en-US";
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => {
      const said = e.results?.[0]?.[0]?.transcript ?? "";
      // Into the box, NOT straight to submit. The reader confirms.
      if (said) {
        setValue(said);
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    r.onerror = (e) => {
      setListening(false);
      say(e.error === "not-allowed" || e.error === "service-not-allowed"
        ? "Microphone permission was denied. Typing still works."
        : e.error === "no-speech"
          ? "I didn't catch anything."
          : `Speech failed (${e.error}). Typing still works.`);
    };
    r.onend = () => setListening(false);
    try {
      r.start();
      setListening(true);
    } catch {
      setListening(false);
      say("Could not start the microphone.");
    }
  }, [listening, stopSpeech]);

  return (
    <dialog
      ref={dialog}
      onClick={(e) => { if (e.target === dialog.current) close(); }}
      className="w-[min(92vw,34rem)] rounded-lg border border-cyan-400/25 bg-slate-950/95 p-0 text-slate-200 shadow-[0_0_60px_rgba(0,0,0,0.6)] backdrop:bg-slate-950/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-300">
          Commands
        </span>
        <button
          onClick={close}
          aria-label="Close commands"
          className="rounded px-1.5 font-mono text-[12px] text-slate-500 hover:text-slate-200"
        >
          ✕
        </button>
      </div>

      <div ref={log} className="max-h-[42vh] min-h-[9rem] overflow-y-auto px-3 py-2.5">
        {lines.map((l, i) => (
          <div key={i} className={l.role === "you" ? "mb-2 text-right" : "mb-2"}>
            <span
              className={`inline-block max-w-[92%] rounded-[4px] px-2 py-1 text-left text-[11.5px] leading-relaxed ${
                l.role === "you"
                  ? "bg-cyan-400/15 font-mono text-cyan-100"
                  : "text-slate-300"
              }`}
            >
              {l.text}
            </span>
            {l.options?.length ? (
              <div className="mt-1.5 flex flex-col items-start gap-1">
                {l.options.map((o, j) => (
                  <button
                    key={j}
                    onClick={async () => { setBusy(true); try { await o.run(); } finally { setBusy(false); } }}
                    className="flex w-full items-baseline gap-2 rounded-[3px] border border-white/10 px-2 py-1 text-left font-mono text-[11px] text-slate-200 transition-colors hover:border-cyan-400/50 hover:bg-cyan-400/10"
                  >
                    <span className="truncate">{o.label}</span>
                    {o.hint && (
                      <span className="ml-auto shrink-0 text-[9px] uppercase tracking-[0.14em] text-slate-500">
                        {o.hint}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {busy && (
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
            working…
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1 border-t border-white/10 px-3 py-2">
        {COMMAND_EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => { setValue(ex); input.current?.focus(); }}
            className="rounded-[3px] border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 transition-colors hover:border-cyan-400/50 hover:text-cyan-200"
          >
            {ex}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void submit(value); }}
        className="flex items-center gap-2 border-t border-white/10 px-3 py-2"
      >
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="fly to Texas · show senate · 2016"
          aria-label="Map command"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-slate-100 outline-none placeholder:text-slate-600"
        />
        {voice && (
          <button
            type="button"
            onClick={listen}
            aria-pressed={listening}
            title={listening ? "Stop listening" : "Speak a command"}
            className={`rounded-[3px] border px-2 py-1 transition-colors ${
              listening
                ? "border-cyan-400 bg-cyan-400/20 text-cyan-200"
                : "border-white/10 text-slate-400 hover:text-slate-200"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
            </svg>
          </button>
        )}
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="rounded-[3px] bg-cyan-400 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-950 transition-colors hover:bg-cyan-300 disabled:opacity-40"
        >
          Run
        </button>
      </form>

      {voice && (
        <p className="border-t border-white/5 px-3 py-1.5 font-mono text-[9px] leading-relaxed text-slate-600">
          {listening ? "Listening — speak, then check the text before running. " : ""}
          {SPEECH_NOTE}
        </p>
      )}
    </dialog>
  );
}
