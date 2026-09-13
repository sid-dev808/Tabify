import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { User } from "firebase/auth";
import {
  Mic, RotateCcw, Check, Download, Edit3, Search, ChevronRight, Trash2,
  CheckCircle, Music2, AlertTriangle, Save, FileMusic,
} from "lucide-react";

import {
  transcribeRecording, downloadTranscription, deleteJob, checkBackend,
  triggerDownload, BACKEND_URL,
} from "../api";
import { isFirebaseConfigured, missingFirebaseKeys } from "../firebase";
import { watchAuthState } from "../auth";
import { ensureUserProfile } from "../users";
import {
  deleteTranscription, saveTranscription, subscribeToTranscriptions,
  type TranscriptionRecord,
} from "../transcriptions";

import AuthScreen from "./screens/AuthScreen";
import ProfileScreen from "./screens/ProfileScreen";
import { Btn, Document, Field, NavBar, Notice, Screen, Spinner } from "./components/Shell";
import { SheetSVG, TabSVG, WaveformCanvas, rendererFor } from "./components/Notation";
import { notesToMidiBlob } from "./lib/midi";
import {
  CARD_PALETTE, FORMATS, INSTRUMENTS, STATUS_MSGS,
  buildScoreFromApiNotes, buildScoreFromStoredNotes, fmtDate, fmtTime,
  formatById, instrumentById, toStoredNotes, transposeNote,
  type ApiNote, type Dur, type Format, type Note,
} from "./lib/score";

type Step =
  | "dashboard" | "instrument" | "record" | "confirm" | "format"
  | "generate" | "review" | "edit" | "download" | "profile" | "project";

/* ─── SETUP GATE ───
   Without .env.local the Firebase SDK fails with an opaque error, so say
   exactly which keys are missing and where they come from instead. */
function SetupScreen() {
  return (
    <Screen>
      <NavBar title="Setup" />
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="max-w-lg w-full rounded-2xl bg-[#0e0e14] border border-white/6 p-7">
          <div className="flex items-center gap-2.5 mb-4 text-[#f0c040]">
            <AlertTriangle size={18} />
            <h1 style={{ fontFamily: "Fraunces,serif" }} className="text-xl text-[#f0ece4]">
              Firebase isn't configured yet
            </h1>
          </div>
          <p className="text-[#9490a0] text-sm leading-relaxed mb-4">
            Create <code className="text-[#f0c040]">frontend/.env.local</code> (copy{" "}
            <code className="text-[#f0c040]">.env.example</code>) and paste the config from
            Firebase console → Project settings → Your apps, then restart{" "}
            <code className="text-[#f0c040]">npm run dev</code>.
          </p>
          <p className="text-[#5e5a70] text-[11px] uppercase tracking-widest mb-2">Missing keys</p>
          <ul className="flex flex-col gap-1.5 mb-5">
            {missingFirebaseKeys.map(key => (
              <li key={key} className="font-mono text-[12px] text-[#e8917c] bg-[#e8603c]/8 rounded-lg px-3 py-1.5">
                {key}
              </li>
            ))}
          </ul>
          <p className="text-[#5e5a70] text-xs leading-relaxed">
            Full walkthrough in <code className="text-[#9490a0]">SETUP.md</code> at the repo root.
          </p>
        </div>
      </div>
    </Screen>
  );
}

function Splash({ label = "Loading…" }: { label?: string }) {
  return (
    <Screen>
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div className="w-11 h-11 rounded-xl bg-[#3b82f6] flex items-center justify-center shadow-[0_0_18px_rgba(59,130,246,0.5)]">
          <Music2 size={20} className="text-white" />
        </div>
        <div className="flex items-center gap-2 text-[#5e5a70] text-sm">
          <Spinner />{label}
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: DASHBOARD ─── */
function DashboardScreen({
  user, projects, loading, error, search, setSearch, onStart, onOpenProject, onProfile, backendOnline,
}: {
  user: User;
  projects: TranscriptionRecord[];
  loading: boolean;
  error: string | null;
  search: string;
  setSearch: (s: string) => void;
  onStart: () => void;
  onOpenProject: (p: TranscriptionRecord) => void;
  onProfile: () => void;
  backendOnline: boolean | null;
}) {
  const filtered = projects.filter(p =>
    [p.name, p.instrumentName, p.formatName].some(v =>
      (v ?? "").toLowerCase().includes(search.toLowerCase())
    )
  );
  const firstName = (user.displayName || user.email || "").split(/[@ ]/)[0];

  return (
    <Screen>
      <NavBar
        right={
          <button
            onClick={onProfile}
            title="Profile"
            className="w-8 h-8 rounded-full bg-[#f0c040]/15 border border-[#f0c040]/25 text-[#f0c040] text-sm font-medium hover:bg-[#f0c040]/25 transition-colors"
            style={{ fontFamily: "Fraunces,serif" }}
          >
            {(user.displayName || user.email || "?").trim().charAt(0).toUpperCase()}
          </button>
        }
      />

      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pt-14 pb-10 text-center">
        <div className="relative w-80 mb-10 pointer-events-none select-none">
          {[0, 1, 2, 3, 4].map(i => (
            <div key={i} className="h-px mb-3 last:mb-0" style={{ background: "rgba(240,192,64,0.28)" }} />
          ))}
          <motion.span animate={{ y: [-6, 6, -6] }} transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            className="absolute -top-3 left-[14%] text-4xl drop-shadow-[0_0_8px_rgba(240,192,64,0.9)]"
            style={{ fontFamily: "serif", color: "#f0c040" }}>♩</motion.span>
          <motion.span animate={{ y: [5, -5, 5] }} transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
            className="absolute top-0 left-[52%] text-3xl drop-shadow-[0_0_8px_rgba(48,216,160,0.9)]"
            style={{ fontFamily: "serif", color: "#30d8a0" }}>♪</motion.span>
          <motion.span animate={{ y: [-4, 6, -4] }} transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut", delay: 0.9 }}
            className="absolute -top-2 right-[10%] text-3xl drop-shadow-[0_0_8px_rgba(59,130,246,0.9)]"
            style={{ fontFamily: "serif", color: "#60a5fa" }}>♫</motion.span>
          <motion.span animate={{ y: [3, -5, 3] }} transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 1.6 }}
            className="absolute top-1 left-[32%] text-2xl drop-shadow-[0_0_6px_rgba(167,139,250,0.85)]"
            style={{ fontFamily: "serif", color: "#a78bfa" }}>♬</motion.span>
        </div>

        <h1 style={{ fontFamily: "Fraunces,serif" }}
          className="text-6xl md:text-7xl font-light text-[#f0ece4] tracking-tight mb-4">
          Tabify
        </h1>
        <p className="text-[#9490a0] text-[15px] max-w-xs leading-relaxed mb-3">
          {firstName ? `Welcome back, ${firstName}. ` : ""}Record your music. Get instant sheet
          music, TAB, MIDI, and more.
        </p>

        {backendOnline === false && (
          <p className="text-[#e8917c] text-xs max-w-sm leading-relaxed mb-5">
            Can't reach the transcription server at{" "}
            <span className="font-mono">{BACKEND_URL}</span>. Start the Flask backend before recording.
          </p>
        )}

        <motion.button
          whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
          onClick={onStart}
          className="mt-7 px-10 py-4 bg-[#f0c040] hover:bg-[#f8cc50] text-black rounded-full text-[15px] font-semibold tracking-wide transition-colors duration-200 shadow-[0_8px_32px_rgba(240,192,64,0.4)]"
        >
          Start Recording
        </motion.button>
      </div>

      {/* Saved transcriptions */}
      <div className="pb-10 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-5">
            <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-[17px] text-[#f0ece4] font-medium">
              Your Transcriptions
            </h2>
            {projects.length > 0 && (
              <div className="relative">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9490a0]" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="bg-white/5 border border-white/8 rounded-full pl-8 pr-4 py-1.5 text-sm text-[#f0ece4] placeholder:text-[#5e5a70] outline-none focus:border-[#f0c040]/50 transition-colors w-44"
                />
              </div>
            )}
          </div>

          {error ? (
            <Notice kind="error">{error}</Notice>
          ) : loading ? (
            <div className="flex items-center gap-2 text-[#5e5a70] text-sm py-6">
              <Spinner />Loading your transcriptions…
            </div>
          ) : projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 py-10 px-6 text-center">
              <p className="text-[#9490a0] text-sm mb-1">Nothing saved yet.</p>
              <p className="text-[#5e5a70] text-xs">
                Transcriptions you save will appear here, on any device you sign in from.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-[#5e5a70] text-sm py-6">No transcriptions match your search.</p>
          ) : (
            <div className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: "none" }}>
              {filtered.map(p => (
                <motion.button
                  key={p.id}
                  whileHover={{ y: -3 }}
                  transition={{ duration: 0.2 }}
                  onClick={() => onOpenProject(p)}
                  className="flex-none w-52 rounded-2xl overflow-hidden border border-white/6 bg-[#0e0e14] hover:border-white/12 transition-colors text-left"
                >
                  <div className="h-24 flex items-center justify-center"
                    style={{ background: `linear-gradient(135deg, ${p.color}44, ${p.color}18)` }}>
                    <span className="text-4xl select-none">
                      {instrumentById(p.instrument)?.emoji ?? "🎵"}
                    </span>
                  </div>
                  <div className="p-3.5">
                    <p className="text-[#f0ece4] text-[13px] font-medium mb-0.5 truncate">{p.name}</p>
                    <p className="text-[#9490a0] text-[11px] mb-2.5">
                      {p.formatName} · {p.noteCount} notes
                    </p>
                    <div className="flex justify-between text-[10px] text-[#5e5a70]">
                      <span>{p.instrumentName}</span>
                      <span>{fmtDate(p.createdAtMs)}</span>
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: INSTRUMENT SELECT ─── */
function InstrumentScreen({ onBack, onSelect }: { onBack: () => void; onSelect: (id: string) => void }) {
  return (
    <Screen>
      <NavBar onBack={onBack} title="Select Instrument" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-2xl text-[#f0ece4] mb-2 text-center">
          What are you playing?
        </h2>
        <p className="text-[#9490a0] text-sm mb-10 text-center">
          Helps us generate more accurate notation.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-2xl">
          {INSTRUMENTS.map(inst => (
            <motion.button key={inst.id}
              whileHover={{ scale: 1.03, y: -2 }} whileTap={{ scale: 0.97 }}
              onClick={() => onSelect(inst.id)}
              className="flex flex-col items-center gap-2.5 p-5 rounded-2xl bg-[#0e0e14] border border-white/6 hover:border-[#f0c040]/35 hover:bg-[#191921] transition-all duration-200 group"
            >
              <span className="text-3xl group-hover:scale-110 transition-transform duration-200 select-none">
                {inst.emoji}
              </span>
              <span className="text-[#f0ece4] text-[13px] font-medium">{inst.name}</span>
              <span className="text-[#5e5a70] text-[10px]">{inst.desc}</span>
            </motion.button>
          ))}
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: RECORD ─── */
function RecordScreen({ onBack, instrument, onFinish }: {
  onBack: () => void; instrument: string; onFinish: (sec: number, blob: Blob) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [time, setTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const inst = instrumentById(instrument);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setTime(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // Always release the microphone when leaving this screen.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close().catch(() => {});
  }, []);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const node = audioCtx.createAnalyser();
      node.fftSize = 256;
      source.connect(node);
      audioCtxRef.current = audioCtx;
      setAnalyser(node);

      const mimeType = ["audio/webm", "audio/ogg", "audio/mp4"].find(t => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start();
      recorderRef.current = recorder;
      setTime(0);
      setRecording(true);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setError(
        name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in your browser's site settings and try again."
          : name === "NotFoundError"
          ? "No microphone found. Plug one in and try again."
          : "Couldn't start recording. Check your microphone and try again."
      );
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const finalTime = time;
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close().catch(() => {});
      setAnalyser(null);
      if (blob.size === 0) {
        setError("That take came out empty. Try recording again.");
        return;
      }
      onFinish(finalTime, blob);
    };
    recorder.stop();
    setRecording(false);
  }

  return (
    <Screen>
      <NavBar onBack={onBack} title="Record" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-8">
        <div className="flex items-center gap-3 px-5 py-2.5 bg-white/5 rounded-full border border-white/8">
          <span className="text-xl select-none">{inst?.emoji}</span>
          <span className="text-[#f0ece4] text-sm">{inst?.name}</span>
        </div>

        <div className="w-full max-w-sm h-16">
          {time > 0 || recording ? (
            <WaveformCanvas active={recording} analyser={analyser} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-[#3c3850] text-sm">Press record to begin</p>
            </div>
          )}
        </div>

        <span className="text-4xl text-[#f0ece4] tracking-[0.18em] tabular-nums"
          style={{ fontFamily: "JetBrains Mono, monospace" }}>
          {fmtTime(time)}
        </span>

        <motion.button
          whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
          onClick={() => (recording ? stopRecording() : startRecording())}
          className={`flex items-center gap-3 px-9 py-4 rounded-full text-[15px] font-semibold transition-all duration-300 ${recording
            ? "bg-white/7 border border-white/10 text-[#f0ece4]"
            : "bg-[#e8603c] hover:bg-[#f07050] text-white shadow-[0_8px_28px_rgba(232,96,60,0.45)]"
          }`}
        >
          {recording ? (
            <><span className="w-3 h-3 rounded-full bg-[#e8603c] animate-pulse" />Finish Recording</>
          ) : (
            <><Mic size={17} />Record</>
          )}
        </motion.button>

        {recording && <p className="text-[#3c3850] text-sm animate-pulse">Play near the microphone</p>}
        {error && <div className="max-w-sm w-full"><Notice kind="error">{error}</Notice></div>}
      </div>
    </Screen>
  );
}

/* ─── SCREEN: CONFIRM TAKE ─── */
function ConfirmScreen({ onBack, onRetry, onContinue, duration, audioBlob }: {
  onBack: () => void; onRetry: () => void; onContinue: () => void;
  duration: number; audioBlob: Blob | null;
}) {
  const audioUrl = useMemo(() => (audioBlob ? URL.createObjectURL(audioBlob) : null), [audioBlob]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  return (
    <Screen>
      <NavBar onBack={onBack} title="Review Take" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-10">
        <div className="w-full max-w-sm">
          <div className="bg-[#0e0e14] rounded-2xl p-6 border border-white/6">
            <div className="flex justify-between items-center mb-4">
              <span className="text-[#9490a0] text-xs uppercase tracking-widest">Recording</span>
              <span className="text-[#f0c040] text-sm" style={{ fontFamily: "JetBrains Mono, monospace" }}>
                {fmtTime(duration)}
              </span>
            </div>
            <WaveformCanvas active={false} />
            {audioUrl && (
              <audio controls src={audioUrl} className="w-full mt-4 h-9" />
            )}
          </div>
        </div>

        <div className="text-center">
          <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-2xl text-[#f0ece4] mb-2">
            Is this your final take?
          </h2>
          <p className="text-[#9490a0] text-sm">Listen back, record again to replace, or confirm to continue.</p>
        </div>

        <div className="flex items-center gap-4">
          <Btn variant="secondary" onClick={onRetry} icon={<RotateCcw size={14} />}>Record Again</Btn>
          <Btn variant="primary" onClick={onContinue} icon={<Check size={14} />}>Confirm Take</Btn>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: FORMAT SELECT ─── */
function FormatScreen({ onBack, onSelect }: { onBack: () => void; onSelect: (f: Format) => void }) {
  return (
    <Screen>
      <NavBar onBack={onBack} title="Output Format" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-2xl text-[#f0ece4] mb-2 text-center">
          Choose output format
        </h2>
        <p className="text-[#9490a0] text-sm mb-10 text-center">You can change this later from a saved project.</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 w-full max-w-xl">
          {FORMATS.map(f => (
            <motion.button key={f.id}
              whileHover={{ scale: 1.02, y: -1 }} whileTap={{ scale: 0.98 }}
              onClick={() => onSelect(f.id)}
              className="flex items-start gap-4 p-5 rounded-2xl bg-[#0e0e14] border border-white/6 hover:border-white/14 text-left transition-all duration-200 group"
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-none"
                style={{ background: `${f.color}1e` }}>
                <span style={{ color: f.color, fontFamily: "serif" }}>{f.symbol}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[#f0ece4] font-medium text-sm">{f.name}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full border"
                    style={{ color: f.color, borderColor: `${f.color}55` }}>{f.ext}</span>
                </div>
                <p className="text-[#5e5a70] text-xs leading-relaxed">{f.desc}</p>
              </div>
              <ChevronRight size={13} className="text-[#3c3850] group-hover:text-[#9490a0] self-center transition-colors flex-none" />
            </motion.button>
          ))}
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: GENERATE ───
   The real transcription happens here: the recorded blob goes to Flask, and
   the returned note events are laid out and revealed onto the staff. */
function GenerateScreen({ format, audioBlob, instrument, onBack, onDone }: {
  format: Format; audioBlob: Blob | null; instrument: string;
  onBack: () => void; onDone: (jobId: string, notes: Note[]) => void;
}) {
  const [progress, setProgress] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const fmtInfo = formatById(format);
  const Renderer = rendererFor(format);

  useEffect(() => {
    if (!audioBlob) { setError("No recording found — please record again."); return; }
    let cancelled = false;
    let noteInt: ReturnType<typeof setInterval> | undefined;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;

    // Ease toward 90% while the request is in flight, then snap to 100% when
    // the transcription actually lands — no fake fixed-duration progress.
    const prog = setInterval(() => setProgress(p => (p < 90 ? p + (90 - p) * 0.05 : p)), 80);

    transcribeRecording(audioBlob, instrument)
      .then(({ job_id, notes: apiNotes }: { job_id: string; notes: ApiNote[]; duration: number }) => {
        if (cancelled) return;
        clearInterval(prog);
        setProgress(100);

        const mapped = buildScoreFromApiNotes(apiNotes);
        setNotes(mapped);

        if (mapped.length === 0) {
          setError("No notes were detected in that recording. Try playing louder or closer to the mic.");
          return;
        }

        let count = 0;
        const revealMs = Math.max(30, Math.min(175, 3500 / mapped.length));
        noteInt = setInterval(() => {
          count++;
          setRevealed(c => Math.min(c + 1, mapped.length));
          docRef.current?.scrollTo({ top: docRef.current.scrollHeight, behavior: "smooth" });
          if (count >= mapped.length) {
            if (noteInt) clearInterval(noteInt);
            doneTimer = setTimeout(() => onDone(job_id, mapped), 400);
          }
        }, revealMs);
      })
      .catch((err: Error) => {
        if (!cancelled) { clearInterval(prog); setError(err.message || "Transcription failed. Please try again."); }
      });

    return () => {
      cancelled = true;
      clearInterval(prog);
      if (noteInt) clearInterval(noteInt);
      if (doneTimer) clearTimeout(doneTimer);
    };
  }, [audioBlob, instrument, onDone]);

  if (error) {
    return (
      <Screen>
        <NavBar title="Generating" />
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5 text-center">
          <div className="max-w-sm w-full"><Notice kind="error">{error}</Notice></div>
          <Btn variant="secondary" onClick={onBack}>Back to Formats</Btn>
        </div>
      </Screen>
    );
  }

  const statusIdx = Math.min(STATUS_MSGS.length - 1, Math.floor((progress / 100) * STATUS_MSGS.length));

  return (
    <Screen>
      <NavBar title="Generating" />
      <div className="flex-1 flex flex-col px-6 py-6 max-w-3xl mx-auto w-full min-h-0">
        <div className="mb-5 shrink-0">
          <div className="flex justify-between mb-2">
            <span className="text-[#9490a0] text-sm">{STATUS_MSGS[statusIdx]}</span>
            <span style={{ fontFamily: "JetBrains Mono, monospace" }} className="text-[#f0c040] text-xs">
              {Math.round(progress)}%
            </span>
          </div>
          <div className="h-0.5 bg-white/6 rounded-full overflow-hidden">
            <div className="h-full bg-[#f0c040] rounded-full transition-all duration-75" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="flex items-center gap-2 mb-4 shrink-0">
          <span className="text-xs text-[#5e5a70]">Output:</span>
          <span className="px-2.5 py-0.5 rounded-full text-xs font-medium"
            style={{ background: `${fmtInfo.color}1e`, color: fmtInfo.color }}>
            {fmtInfo.name}
          </span>
        </div>

        <div ref={docRef}
          className="flex-1 overflow-y-auto rounded-2xl bg-white shadow-[0_24px_72px_rgba(0,0,0,0.6)] p-8 min-h-0"
          style={{ scrollbarWidth: "none" }}>
          <Renderer revealed={revealed} notes={notes} selected={null} />
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: REVIEW ─── */
function ReviewScreen({ notes, format, onBack, onEdit, onAccept }: {
  notes: Note[]; format: Format; onBack: () => void; onEdit: () => void; onAccept: () => void;
}) {
  const Renderer = rendererFor(format);
  return (
    <Screen>
      <NavBar onBack={onBack} title="Review" />
      <div className="flex-1 flex flex-col px-6 py-6 max-w-3xl mx-auto w-full min-h-0">
        <Document>
          <Renderer revealed={notes.length} notes={notes} selected={null} />
        </Document>
        <p className="text-center text-[#5e5a70] text-xs mt-3">
          {notes.length} notes transcribed from your recording
        </p>
        <div className="flex items-center justify-center gap-4 mt-4 shrink-0">
          <Btn variant="secondary" onClick={onEdit} icon={<Edit3 size={14} />}>Edit Music</Btn>
          <Btn variant="primary" onClick={onAccept} icon={<CheckCircle size={14} />}>Accept Music</Btn>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: EDIT ───
   Real transcriptions cover any pitch, so editing moves notes by semitone
   rather than snapping to a fixed nine-note list. */
function EditScreen({ notes, setNotes, format, onBack, onContinue, onDelete }: {
  notes: Note[]; setNotes: (updater: (prev: Note[]) => Note[]) => void; format: Format;
  onBack: () => void; onContinue: () => void; onDelete: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const sel = selected !== null ? notes.find(n => n.id === selected) ?? null : null;
  const Renderer = rendererFor(format);

  function shiftPitch(semitones: number) {
    if (selected === null) return;
    setNotes(prev => prev.map(n => (n.id === selected ? transposeNote(n, semitones) : n)));
  }

  function setDur(d: Dur) {
    if (selected === null) return;
    setNotes(prev => prev.map(n => (n.id === selected ? { ...n, dur: d } : n)));
  }

  function removeSelected() {
    if (selected === null) return;
    setNotes(prev => prev.filter(n => n.id !== selected));
    setSelected(null);
  }

  return (
    <Screen>
      <NavBar onBack={onBack} title="Edit Music" />
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6 min-h-0" style={{ scrollbarWidth: "none" }}>
          <div className="rounded-2xl bg-white shadow-[0_24px_72px_rgba(0,0,0,0.6)] p-8 max-w-3xl mx-auto">
            <Renderer
              revealed={notes.length}
              notes={notes}
              selected={selected}
              onNote={id => setSelected(id === selected ? null : id)}
              editable
            />
          </div>
          {!sel && (
            <p className="text-center text-[#3c3850] text-xs mt-4">Tap any note to select and edit it</p>
          )}
        </div>

        <div className="md:w-60 border-t md:border-t-0 md:border-l border-white/5 bg-[#060608] p-5 flex flex-col gap-5 shrink-0">
          {sel ? (
            <>
              <div className="bg-[#0e0e12] rounded-xl p-3 border border-white/6 text-center">
                <p style={{ fontFamily: "Fraunces,serif" }} className="text-[#f0c040] text-3xl font-light">
                  {sel.pitch}
                </p>
                <p className="text-[#5e5a70] text-[10px] mt-1">Selected note</p>
              </div>

              <div>
                <p className="text-[#5e5a70] text-[10px] uppercase tracking-widest mb-2">Pitch</p>
                <div className="flex items-center gap-2 mb-2">
                  <button onClick={() => shiftPitch(-1)}
                    className="w-8 h-8 rounded-full bg-white/6 hover:bg-white/10 text-[#f0ece4] transition-colors flex items-center justify-center text-base leading-none">−</button>
                  <span className="flex-1 text-center text-[#f0ece4] text-sm font-medium">semitone</span>
                  <button onClick={() => shiftPitch(1)}
                    className="w-8 h-8 rounded-full bg-white/6 hover:bg-white/10 text-[#f0ece4] transition-colors flex items-center justify-center text-base leading-none">+</button>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => shiftPitch(-12)}
                    className="flex-1 text-xs py-1.5 rounded-lg text-[#9490a0] hover:bg-white/5 hover:text-[#f0ece4] transition-colors">− octave</button>
                  <button onClick={() => shiftPitch(12)}
                    className="flex-1 text-xs py-1.5 rounded-lg text-[#9490a0] hover:bg-white/5 hover:text-[#f0ece4] transition-colors">+ octave</button>
                </div>
              </div>

              <div>
                <p className="text-[#5e5a70] text-[10px] uppercase tracking-widest mb-2">Duration</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["q", "h", "w"] as Dur[]).map(d => (
                    <button key={d} onClick={() => setDur(d)}
                      className={`py-2 rounded-lg text-[11px] font-medium transition-colors ${
                        sel.dur === d
                          ? "bg-[#f0c040]/18 text-[#f0c040] border border-[#f0c040]/28"
                          : "bg-white/5 text-[#9490a0] hover:bg-white/8 hover:text-[#f0ece4]"
                      }`}>
                      {d === "q" ? "¼" : d === "h" ? "½" : "○"}
                    </button>
                  ))}
                </div>
              </div>

              <button onClick={removeSelected}
                className="text-[#e07a62] hover:text-[#f08a70] text-xs transition-colors self-start">
                Remove this note
              </button>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center">
                <Edit3 size={18} className="text-[#3c3850]" />
              </div>
              <p className="text-[#3c3850] text-[13px] leading-relaxed">
                Select a note in the score to edit its pitch and duration.
              </p>
            </div>
          )}

          <div className="mt-auto flex flex-col gap-2">
            <Btn variant="primary" onClick={onContinue} className="w-full justify-center">
              Continue to Download
            </Btn>
            <Btn variant="danger" onClick={onDelete} icon={<Trash2 size={13} />} className="w-full justify-center">
              Discard Take
            </Btn>
          </div>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SHARED EXPORT HELPERS ─── */
function exportSvg(wrap: HTMLDivElement | null, filename: string) {
  const svgEl = wrap?.querySelector("svg");
  if (!svgEl) throw new Error("Nothing to export yet.");
  const svgString = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${filename}.svg`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportMidiLocally(notes: Note[], filename: string) {
  const url = URL.createObjectURL(notesToMidiBlob(notes));
  triggerDownload(url, `${filename}.mid`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ─── SCREEN: DOWNLOAD & SAVE ─── */
function DownloadScreen({ format, jobId, notes, instrument, onFinish }: {
  format: Format; jobId: string | null; notes: Note[]; instrument: string;
  onFinish: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<null | "download" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);

  const fmtInfo = formatById(format);
  const inst = instrumentById(instrument);
  const placeholder = `${inst?.name ?? "Recording"} — ${new Date().toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  })}`;
  const isNotation = format === "sheet" || format === "tab";
  const Renderer = rendererFor(format);

  async function run(withDownload: boolean) {
    setError(null);
    setBusy(withDownload ? "download" : "save");
    const finalName = name.trim() || placeholder;

    try {
      if (withDownload) {
        if (isNotation) {
          exportSvg(svgWrapRef.current, finalName);
        } else if (format === "midi") {
          // Prefer the backend's MIDI (it carries basic-pitch's pitch bends);
          // if that job has expired, rebuild the file from the notes we hold.
          try {
            if (!jobId) throw new Error("no job");
            await downloadTranscription(jobId, "midi", `${finalName}.mid`);
          } catch {
            exportMidiLocally(notes, finalName);
          }
        } else {
          if (!jobId) throw new Error("The audio for this take is no longer on the server. Record again to export WAV.");
          await downloadTranscription(jobId, "wav", `${finalName}.wav`);
        }
      }
      await onFinish(finalName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
      setBusy(null);
    }
  }

  return (
    <Screen>
      <NavBar title="Download" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-xs">
          <div className="rounded-2xl bg-[#0e0e14] border border-white/6 overflow-hidden mb-5">
            {isNotation ? (
              <div ref={svgWrapRef} className="bg-white p-2 max-h-44 overflow-hidden">
                <Renderer revealed={notes.length} notes={notes} selected={null} />
              </div>
            ) : (
              <div className="h-24 flex items-center justify-center"
                style={{ background: `linear-gradient(135deg, ${fmtInfo.color}28, ${fmtInfo.color}10)` }}>
                <span style={{ color: fmtInfo.color, fontFamily: "serif" }} className="text-5xl opacity-90 select-none">
                  {fmtInfo.symbol}
                </span>
              </div>
            )}
            <div className="p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[#f0ece4] font-medium text-sm">{fmtInfo.name}</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full"
                  style={{ background: `${fmtInfo.color}1e`, color: fmtInfo.color }}>{fmtInfo.ext}</span>
              </div>
              <p className="text-[#5e5a70] text-xs">{fmtInfo.desc}</p>
            </div>
          </div>

          <div className="mb-4">
            <Field
              label="Project name"
              type="text"
              value={name}
              placeholder={placeholder}
              onChange={e => setName(e.target.value)}
            />
          </div>

          {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}

          <motion.button
            onClick={() => run(true)}
            disabled={busy !== null}
            whileHover={busy ? {} : { scale: 1.02 }}
            whileTap={busy ? {} : { scale: 0.98 }}
            className="w-full py-4 rounded-full font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2.5 disabled:cursor-not-allowed"
            style={{
              background: busy ? "#1e1e26" : fmtInfo.color,
              color: busy ? "#5e5a70" : "#0b0b0f",
              boxShadow: busy ? "none" : `0 8px 28px ${fmtInfo.color}44`,
            }}
          >
            {busy === "download"
              ? <><Spinner />Preparing…</>
              : <><Download size={15} />Download {fmtInfo.name}</>}
          </motion.button>

          <button
            onClick={() => run(false)}
            disabled={busy !== null}
            className="w-full mt-3 py-2.5 text-[#9490a0] hover:text-[#f0ece4] transition-colors text-xs flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {busy === "save" ? <><Spinner />Saving…</> : <><Save size={13} />Save to my transcriptions without downloading</>}
          </button>

          <p className="text-center text-[#3c3850] text-[11px] mt-4 leading-relaxed">
            Either way this take is saved to your account, so you can come back to it later.
          </p>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: SAVED TRANSCRIPTION ───
   Rebuilt from the notes stored in Firestore, so it keeps working long after
   the server-side job (and its temp files) have expired. */
function ProjectScreen({ record, onBack, onDelete }: {
  record: TranscriptionRecord; onBack: () => void; onDelete: (id: string) => Promise<void>;
}) {
  const [view, setView] = useState<"sheet" | "tab">(record.format === "tab" ? "tab" : "sheet");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const svgWrapRef = useRef<HTMLDivElement>(null);

  const notes = useMemo(() => buildScoreFromStoredNotes(record.notes), [record.notes]);
  const Renderer = view === "tab" ? TabSVG : SheetSVG;

  function download(kind: "svg" | "midi") {
    setError(null);
    try {
      if (kind === "svg") exportSvg(svgWrapRef.current, record.name);
      else exportMidiLocally(notes, record.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await onDelete(record.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that transcription.");
      setDeleting(false);
    }
  }

  return (
    <Screen>
      <NavBar onBack={onBack} title="Saved" />
      <div className="flex-1 flex flex-col px-6 py-6 max-w-3xl mx-auto w-full min-h-0">
        <div className="flex items-start justify-between gap-4 mb-4 shrink-0">
          <div className="min-w-0">
            <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-2xl text-[#f0ece4] truncate">
              {record.name}
            </h2>
            <p className="text-[#5e5a70] text-xs mt-1">
              {record.instrumentName} · {record.noteCount} notes · {fmtTime(record.durationSeconds)} · {fmtDate(record.createdAtMs)}
            </p>
          </div>
          <div className="flex rounded-full bg-white/5 border border-white/8 p-0.5 shrink-0">
            {(["sheet", "tab"] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded-full text-xs transition-colors ${
                  view === v ? "bg-[#f0c040] text-black font-medium" : "text-[#9490a0] hover:text-[#f0ece4]"
                }`}>
                {v === "sheet" ? "Sheet" : "TAB"}
              </button>
            ))}
          </div>
        </div>

        <div ref={svgWrapRef} className="flex-1 min-h-0">
          <Document>
            <Renderer revealed={notes.length} notes={notes} selected={null} title={record.name} />
          </Document>
        </div>

        {error && <div className="mt-4"><Notice kind="error">{error}</Notice></div>}

        <div className="flex flex-wrap items-center justify-center gap-3 mt-5 shrink-0">
          <Btn variant="secondary" onClick={() => download("svg")} icon={<Download size={14} />}>
            Export {view === "tab" ? "TAB" : "Sheet"} (.svg)
          </Btn>
          <Btn variant="secondary" onClick={() => download("midi")} icon={<FileMusic size={14} />}>
            Export MIDI
          </Btn>
          {!confirming ? (
            <Btn variant="danger" onClick={() => setConfirming(true)} icon={<Trash2 size={13} />}>Delete</Btn>
          ) : (
            <>
              <Btn variant="danger" onClick={remove} disabled={deleting}>
                {deleting ? <><Spinner />Deleting…</> : "Confirm delete"}
              </Btn>
              <Btn variant="ghost" onClick={() => setConfirming(false)}>Cancel</Btn>
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

/* ─── MAIN APP ─── */
export default function App() {
  /* auth */
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  /* flow */
  const [step, setStep] = useState<Step>("dashboard");
  const [instrument, setInstrument] = useState("piano");
  const [format, setFormat] = useState<Format>("sheet");
  const [recDuration, setRecDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [score, setScore] = useState<Note[]>([]);

  /* saved work */
  const [projects, setProjects] = useState<TranscriptionRecord[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  // Firebase mutates the User object in place on updateProfile, so a bump
  // here is all that is needed to show a freshly changed display name.
  const [, bumpProfile] = useState(0);

  // Mirrored in a ref so cleanup can release the server job without making
  // resetSession depend on the current jobId.
  const jobIdRef = useRef<string | null>(null);
  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);

  const resetSession = useCallback(() => {
    if (jobIdRef.current) void deleteJob(jobIdRef.current);
    jobIdRef.current = null;
    setAudioBlob(null);
    setJobId(null);
    setScore([]);
    setRecDuration(0);
  }, []);

  /* ─── auth session ─── */
  useEffect(() => {
    if (!isFirebaseConfigured) { setAuthReady(true); return; }
    return watchAuthState(nextUser => {
      setUser(nextUser);
      setAuthReady(true);
      // Keep users/{uid} in step with the auth record on every sign-in.
      if (nextUser) void ensureUserProfile(nextUser).catch(() => {});
    });
  }, []);

  const uid = user?.uid ?? null;

  // Signing out (or switching accounts) must not leave another user's take in memory.
  useEffect(() => {
    setStep("dashboard");
    setOpenProjectId(null);
    setSearch("");
    resetSession();
  }, [uid, resetSession]);

  /* ─── live list of saved transcriptions ─── */
  useEffect(() => {
    if (!uid) { setProjects([]); setProjectsLoading(false); return; }

    setProjectsLoading(true);
    setProjectsError(null);

    const unsubscribe = subscribeToTranscriptions(
      uid,
      records => { setProjects(records); setProjectsLoading(false); setProjectsError(null); },
      err => {
        setProjectsLoading(false);
        setProjectsError(
          /permission|insufficient/i.test(err.message)
            ? "Firestore denied the read. Publish the rules from firestore.rules in the Firebase console, then reload."
            : `Couldn't load your transcriptions: ${err.message}`
        );
      }
    );
    return unsubscribe;
  }, [uid]);

  /* ─── backend reachability (shown on the dashboard) ─── */
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    void checkBackend().then(ok => { if (alive) setBackendOnline(ok); });
    return () => { alive = false; };
  }, [uid]);

  /* ─── actions ─── */
  const handleGenerated = useCallback((newJobId: string, notes: Note[]) => {
    setJobId(newJobId);
    jobIdRef.current = newJobId;
    setScore(notes);
    setStep("review");
  }, []);

  const saveProject = useCallback(async (name: string) => {
    if (!uid) return;
    await saveTranscription(uid, {
      name,
      instrument,
      instrumentName: instrumentById(instrument)?.name ?? "Unknown",
      format,
      formatName: formatById(format).name,
      durationSeconds: recDuration,
      color: CARD_PALETTE[projects.length % CARD_PALETTE.length],
      notes: toStoredNotes(score),
    });
    resetSession();
    setStep("dashboard");
  }, [uid, instrument, format, recDuration, score, projects.length, resetSession]);

  const removeProject = useCallback(async (id: string) => {
    if (!uid) return;
    await deleteTranscription(uid, id);
    setOpenProjectId(null);
    setStep("dashboard");
  }, [uid]);

  /* ─── gates ─── */
  if (!isFirebaseConfigured) return <SetupScreen />;
  if (!authReady) return <Splash label="Starting Tabify…" />;
  if (!user) return <AuthScreen />;

  const openProject = projects.find(p => p.id === openProjectId) ?? null;
  const activeStep: Step = step === "project" && !openProject ? "dashboard" : step;

  return (
    <div className="dark">
      <AnimatePresence mode="wait">
        <motion.div
          key={activeStep}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}
        >
          {activeStep === "dashboard" && (
            <DashboardScreen
              user={user}
              projects={projects}
              loading={projectsLoading}
              error={projectsError}
              search={search}
              setSearch={setSearch}
              backendOnline={backendOnline}
              onStart={() => { resetSession(); setStep("instrument"); }}
              onOpenProject={p => { setOpenProjectId(p.id); setStep("project"); }}
              onProfile={() => setStep("profile")}
            />
          )}

          {activeStep === "profile" && (
            <ProfileScreen
              user={user}
              projectCount={projects.length}
              onBack={() => setStep("dashboard")}
              onProfileChange={() => bumpProfile(v => v + 1)}
            />
          )}

          {activeStep === "project" && openProject && (
            <ProjectScreen
              record={openProject}
              onBack={() => { setOpenProjectId(null); setStep("dashboard"); }}
              onDelete={removeProject}
            />
          )}

          {activeStep === "instrument" && (
            <InstrumentScreen
              onBack={() => setStep("dashboard")}
              onSelect={id => { setInstrument(id); setStep("record"); }}
            />
          )}

          {activeStep === "record" && (
            <RecordScreen
              onBack={() => setStep("instrument")}
              instrument={instrument}
              onFinish={(sec, blob) => { setRecDuration(sec); setAudioBlob(blob); setStep("confirm"); }}
            />
          )}

          {activeStep === "confirm" && (
            <ConfirmScreen
              onBack={() => setStep("record")}
              onRetry={() => setStep("record")}
              onContinue={() => setStep("format")}
              duration={recDuration}
              audioBlob={audioBlob}
            />
          )}

          {activeStep === "format" && (
            <FormatScreen
              onBack={() => setStep("confirm")}
              onSelect={f => { setFormat(f); setStep("generate"); }}
            />
          )}

          {activeStep === "generate" && (
            <GenerateScreen
              format={format}
              audioBlob={audioBlob}
              instrument={instrument}
              onBack={() => setStep("format")}
              onDone={handleGenerated}
            />
          )}

          {activeStep === "review" && (
            <ReviewScreen
              notes={score}
              format={format}
              onBack={() => setStep("format")}
              onEdit={() => setStep("edit")}
              onAccept={() => setStep("download")}
            />
          )}

          {activeStep === "edit" && (
            <EditScreen
              notes={score}
              setNotes={setScore}
              format={format}
              onBack={() => setStep("review")}
              onContinue={() => setStep("download")}
              onDelete={() => { resetSession(); setStep("dashboard"); }}
            />
          )}

          {activeStep === "download" && (
            <DownloadScreen
              format={format}
              jobId={jobId}
              notes={score}
              instrument={instrument}
              onFinish={saveProject}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
