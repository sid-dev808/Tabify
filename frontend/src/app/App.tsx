import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { User } from "firebase/auth";
import {
  Mic, RotateCcw, Check, Download, Edit3, Search, ChevronRight, Trash2,
  CheckCircle, Music2, AlertTriangle, Save, Play, Square, Upload, Pencil,
} from "lucide-react";

import {
  transcribeRecording, downloadTranscription, deleteJob, checkBackend,
  triggerDownload, BACKEND_URL,
} from "../api";
import { isFirebaseConfigured, missingFirebaseKeys } from "../firebase";
import { watchAuthState } from "../auth";
import { ensureUserProfile } from "../users";
import {
  deleteTranscription, renameTranscription, saveTranscription, subscribeToTranscriptions,
  type TranscriptionRecord,
} from "../transcriptions";

import AuthScreen from "./screens/AuthScreen";
import ProfileScreen from "./screens/ProfileScreen";
import { Btn, Document, Field, NavBar, Notice, Screen, Spinner } from "./components/Shell";
import { SheetSVG, TabSVG, WaveformCanvas, rendererFor } from "./components/Notation";
import { notesToMidiBlob } from "./lib/midi";
import { ScorePlayer, type PlayableNote } from "./lib/playback";
import { downloadBlob, svgBlob, svgToPdfBlob, svgToPngBlob } from "./lib/exporters";
import {
  CARD_PALETTE, EMPTY_SCORE, FORMATS, INSTRUMENTS, STATUS_MSGS,
  buildScore, buildScoreFromStoredNotes, fmtDate, fmtTime, formatById, instrumentById,
  rebuildAfterEdit, staffTop, tabTop, toStoredNotes, transposeEvent,
  type ApiNote, type Format, type LaidOutEvent, type Score,
} from "./lib/score";

type Step =
  | "dashboard" | "instrument" | "record" | "confirm" | "format"
  | "generate" | "review" | "edit" | "download" | "profile" | "project";

/* ─── SETUP GATE ─── */
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
        <div className="flex items-center gap-2 text-[#5e5a70] text-sm"><Spinner />{label}</div>
      </div>
    </Screen>
  );
}

/* ─── SHARED: PLAYBACK ───
   Hearing the transcription is the fastest way to judge whether it is right,
   so the same control appears on review, edit and saved projects. */
function PlaybackBar({ score, onHighlight, compact = false }: {
  score: Score; onHighlight: (ids: number[]) => void; compact?: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<ScorePlayer | null>(null);

  const notes: PlayableNote[] = useMemo(
    () => score.events
      .filter(e => e.kind === "note")
      .map(e => ({ id: e.id, midi: e.midi, start: e.start, end: e.end })),
    [score.events]
  );

  useEffect(() => () => { playerRef.current?.dispose(); }, []);

  // Never keep playing into a screen the user has left, or a re-transcribed score.
  useEffect(() => {
    playerRef.current?.stop();
    setPlaying(false);
    onHighlight([]);
  }, [score, onHighlight]);

  async function toggle() {
    const player = playerRef.current ?? (playerRef.current = new ScorePlayer());
    if (playing) {
      player.stop();
      setPlaying(false);
      onHighlight([]);
      return;
    }
    setPlaying(true);
    await player.play(
      notes,
      ids => onHighlight(ids),
      () => { setPlaying(false); onHighlight([]); }
    );
  }

  if (notes.length === 0) return null;

  return (
    <button
      onClick={toggle}
      className={`inline-flex items-center gap-2 rounded-full transition-colors ${
        compact ? "px-3.5 py-1.5 text-xs" : "px-5 py-2.5 text-sm"
      } ${playing
        ? "bg-[#3b82f6]/18 text-[#7fb0ff] border border-[#3b82f6]/35"
        : "bg-white/7 hover:bg-white/11 text-[#f0ece4] border border-white/10"}`}
    >
      {playing ? <Square size={compact ? 11 : 13} /> : <Play size={compact ? 11 : 13} />}
      {playing ? "Stop" : "Hear it"}
    </button>
  );
}

/* ─── SHARED: EXPORT ─── */
function ExportButtons({ wrapRef, score, format, name, onError }: {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  score: Score; format: Format; name: string;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  // Page breaks are only allowed in the gaps between staff systems, so a PDF
  // never slices a stave in half.
  const breaks = useMemo(
    () => Array.from({ length: Math.max(0, score.systems - 1) },
      (_, i) => (format === "tab" ? tabTop(i + 1) : staffTop(i + 1)) - 26),
    [score.systems, format]
  );

  async function run(kind: "pdf" | "png" | "svg") {
    const svg = wrapRef.current?.querySelector("svg");
    if (!svg) { onError("Nothing to export yet."); return; }
    onError(null);
    setBusy(kind);
    try {
      if (kind === "svg") {
        downloadBlob(svgBlob(svg as SVGSVGElement), `${name}.svg`);
      } else if (kind === "png") {
        downloadBlob(await svgToPngBlob(svg as SVGSVGElement, 2), `${name}.png`);
      } else {
        downloadBlob(await svgToPdfBlob(svg as SVGSVGElement, breaks, 2), `${name}.pdf`);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Btn variant="primary" onClick={() => run("pdf")} disabled={busy !== null}
        icon={busy === "pdf" ? <Spinner /> : <Download size={14} />}>
        PDF
      </Btn>
      {(["png", "svg"] as const).map(kind => (
        <button key={kind} onClick={() => run(kind)} disabled={busy !== null}
          className="px-3 py-2 rounded-full text-xs text-[#9490a0] hover:text-[#f0ece4] hover:bg-white/5 transition-colors disabled:opacity-40 uppercase tracking-wider">
          {busy === kind ? "…" : kind}
        </button>
      ))}
    </div>
  );
}

/* ─── SCREEN: DASHBOARD ─── */
function DashboardScreen({
  user, projects, loading, error, search, setSearch, onStart, onOpenProject, onProfile, backendOnline,
}: {
  user: User; projects: TranscriptionRecord[]; loading: boolean; error: string | null;
  search: string; setSearch: (s: string) => void;
  onStart: () => void; onOpenProject: (p: TranscriptionRecord) => void; onProfile: () => void;
  backendOnline: boolean | null;
}) {
  const filtered = projects.filter(p =>
    [p.name, p.instrumentName, p.formatName].some(v => (v ?? "").toLowerCase().includes(search.toLowerCase()))
  );
  const firstName = (user.displayName || user.email || "").split(/[@ ]/)[0];

  return (
    <Screen>
      <NavBar
        right={
          <button onClick={onProfile} title="Profile"
            className="w-8 h-8 rounded-full bg-[#f0c040]/15 border border-[#f0c040]/25 text-[#f0c040] text-sm font-medium hover:bg-[#f0c040]/25 transition-colors"
            style={{ fontFamily: "Fraunces,serif" }}>
            {(user.displayName || user.email || "?").trim().charAt(0).toUpperCase()}
          </button>
        }
      />

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
          className="text-6xl md:text-7xl font-light text-[#f0ece4] tracking-tight mb-4">Tabify</h1>
        <p className="text-[#9490a0] text-[15px] max-w-xs leading-relaxed mb-3">
          {firstName ? `Welcome back, ${firstName}. ` : ""}Record or upload your music. Get sheet
          music, TAB, MIDI, and more.
        </p>

        {backendOnline === false && (
          <p className="text-[#e8917c] text-xs max-w-sm leading-relaxed mb-5">
            Can't reach the transcription server at <span className="font-mono">{BACKEND_URL}</span>.
            Run <span className="font-mono">./start_script.sh</span> from the repo root.
          </p>
        )}

        <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={onStart}
          className="mt-7 px-10 py-4 bg-[#f0c040] hover:bg-[#f8cc50] text-black rounded-full text-[15px] font-semibold tracking-wide transition-colors duration-200 shadow-[0_8px_32px_rgba(240,192,64,0.4)]">
          Start Recording
        </motion.button>
      </div>

      <div className="pb-10 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-5">
            <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-[17px] text-[#f0ece4] font-medium">
              Your Transcriptions
            </h2>
            {projects.length > 0 && (
              <div className="relative">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9490a0]" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                  className="bg-white/5 border border-white/8 rounded-full pl-8 pr-4 py-1.5 text-sm text-[#f0ece4] placeholder:text-[#5e5a70] outline-none focus:border-[#f0c040]/50 transition-colors w-44" />
              </div>
            )}
          </div>

          {error ? <Notice kind="error">{error}</Notice>
          : loading ? (
            <div className="flex items-center gap-2 text-[#5e5a70] text-sm py-6"><Spinner />Loading your transcriptions…</div>
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
                <motion.button key={p.id} whileHover={{ y: -3 }} transition={{ duration: 0.2 }}
                  onClick={() => onOpenProject(p)}
                  className="flex-none w-52 rounded-2xl overflow-hidden border border-white/6 bg-[#0e0e14] hover:border-white/12 transition-colors text-left">
                  <div className="h-24 flex items-center justify-center"
                    style={{ background: `linear-gradient(135deg, ${p.color}44, ${p.color}18)` }}>
                    <span className="text-4xl select-none">{instrumentById(p.instrument)?.emoji ?? "🎵"}</span>
                  </div>
                  <div className="p-3.5">
                    <p className="text-[#f0ece4] text-[13px] font-medium mb-0.5 truncate">{p.name}</p>
                    <p className="text-[#9490a0] text-[11px] mb-2.5">
                      {p.noteCount} notes · ♩={Math.round(p.bpm)}
                    </p>
                    <div className="flex justify-between text-[10px] text-[#5e5a70]">
                      <span>{p.instrumentName}</span><span>{fmtDate(p.createdAtMs)}</span>
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
        <p className="text-[#9490a0] text-sm mb-10 text-center">Helps us generate more accurate notation.</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-2xl">
          {INSTRUMENTS.map(inst => (
            <motion.button key={inst.id} whileHover={{ scale: 1.03, y: -2 }} whileTap={{ scale: 0.97 }}
              onClick={() => onSelect(inst.id)}
              className="flex flex-col items-center gap-2.5 p-5 rounded-2xl bg-[#0e0e14] border border-white/6 hover:border-[#f0c040]/35 hover:bg-[#191921] transition-all duration-200 group">
              <span className="text-3xl group-hover:scale-110 transition-transform duration-200 select-none">{inst.emoji}</span>
              <span className="text-[#f0ece4] text-[13px] font-medium">{inst.name}</span>
              <span className="text-[#5e5a70] text-[10px]">{inst.desc}</span>
            </motion.button>
          ))}
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: RECORD OR UPLOAD ─── */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;   // matches the backend's cap

function RecordScreen({ onBack, instrument, onFinish }: {
  onBack: () => void; instrument: string;
  onFinish: (seconds: number, blob: Blob, filename: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [time, setTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [reading, setReading] = useState(false);
  const inst = instrumentById(instrument);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setTime(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

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
          ? "No microphone found. Plug one in, or upload an audio file instead."
          : "Couldn't start recording. Check your microphone, or upload an audio file instead."
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
      if (blob.size === 0) { setError("That take came out empty. Try recording again."); return; }
      const ext = (recorder.mimeType || "audio/webm").includes("mp4") ? "mp4"
        : (recorder.mimeType || "").includes("ogg") ? "ogg" : "webm";
      onFinish(finalTime, blob, `recording.${ext}`);
    };
    recorder.stop();
    setRecording(false);
  }

  /* Uploading matters as much as recording: it's how you test the same passage
     twice, and how someone without an instrument to hand can try the app. */
  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);

    if (!/^audio\//.test(file.type) && !/\.(wav|mp3|m4a|aac|ogg|flac|webm|aiff?)$/i.test(file.name)) {
      setError("That doesn't look like an audio file. Try a .wav, .mp3, .m4a, .ogg or .flac.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(0)} MB — the limit is 32 MB. Try a shorter clip.`);
      return;
    }

    setReading(true);
    try {
      const seconds = await new Promise<number>(resolve => {
        const url = URL.createObjectURL(file);
        const audio = new Audio();
        const done = (value: number) => { URL.revokeObjectURL(url); resolve(value); };
        audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0);
        audio.onerror = () => done(0);
        audio.src = url;
      });
      onFinish(Math.round(seconds), file, file.name);
    } finally {
      setReading(false);
    }
  }

  return (
    <Screen>
      <NavBar onBack={onBack} title="Record" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-7">
        <div className="flex items-center gap-3 px-5 py-2.5 bg-white/5 rounded-full border border-white/8">
          <span className="text-xl select-none">{inst?.emoji}</span>
          <span className="text-[#f0ece4] text-sm">{inst?.name}</span>
        </div>

        <div className="w-full max-w-sm h-16">
          {time > 0 || recording ? <WaveformCanvas active={recording} analyser={analyser} /> : (
            <div className="h-full flex items-center justify-center">
              <p className="text-[#3c3850] text-sm">Press record to begin</p>
            </div>
          )}
        </div>

        <span className="text-4xl text-[#f0ece4] tracking-[0.18em] tabular-nums"
          style={{ fontFamily: "JetBrains Mono, monospace" }}>{fmtTime(time)}</span>

        <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
          onClick={() => (recording ? stopRecording() : startRecording())}
          className={`flex items-center gap-3 px-9 py-4 rounded-full text-[15px] font-semibold transition-all duration-300 ${recording
            ? "bg-white/7 border border-white/10 text-[#f0ece4]"
            : "bg-[#e8603c] hover:bg-[#f07050] text-white shadow-[0_8px_28px_rgba(232,96,60,0.45)]"}`}>
          {recording
            ? <><span className="w-3 h-3 rounded-full bg-[#e8603c] animate-pulse" />Finish Recording</>
            : <><Mic size={17} />Record</>}
        </motion.button>

        {recording && <p className="text-[#3c3850] text-sm animate-pulse">Play near the microphone</p>}

        {!recording && (
          <>
            <div className="flex items-center gap-3 w-full max-w-xs">
              <div className="flex-1 h-px bg-white/8" />
              <span className="text-[#3c3850] text-[11px] uppercase tracking-widest">or</span>
              <div className="flex-1 h-px bg-white/8" />
            </div>
            <button onClick={() => fileInputRef.current?.click()} disabled={reading}
              className="flex items-center gap-2.5 px-6 py-3 rounded-full bg-white/5 hover:bg-white/9 border border-white/10 text-[#f0ece4] text-sm transition-colors disabled:opacity-50">
              {reading ? <><Spinner />Reading file…</> : <><Upload size={15} />Upload an audio file</>}
            </button>
            <input ref={fileInputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aac"
              className="hidden" onChange={e => { void handleFile(e.target.files?.[0]); e.target.value = ""; }} />
            <p className="text-[#3c3850] text-xs -mt-3">wav, mp3, m4a, ogg or flac · up to 32 MB</p>
          </>
        )}

        {error && <div className="max-w-sm w-full"><Notice kind="error">{error}</Notice></div>}
      </div>
    </Screen>
  );
}

/* ─── SCREEN: CONFIRM TAKE ─── */
function ConfirmScreen({ onBack, onRetry, onContinue, duration, audioBlob, filename }: {
  onBack: () => void; onRetry: () => void; onContinue: () => void;
  duration: number; audioBlob: Blob | null; filename: string;
}) {
  const audioUrl = useMemo(() => (audioBlob ? URL.createObjectURL(audioBlob) : null), [audioBlob]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  const uploaded = !filename.startsWith("recording.");

  return (
    <Screen>
      <NavBar onBack={onBack} title="Review Take" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-10">
        <div className="w-full max-w-sm">
          <div className="bg-[#0e0e14] rounded-2xl p-6 border border-white/6">
            <div className="flex justify-between items-center mb-4 gap-3">
              <span className="text-[#9490a0] text-xs uppercase tracking-widest truncate">
                {uploaded ? filename : "Recording"}
              </span>
              <span className="text-[#f0c040] text-sm shrink-0" style={{ fontFamily: "JetBrains Mono, monospace" }}>
                {fmtTime(duration)}
              </span>
            </div>
            <WaveformCanvas active={false} />
            {audioUrl && <audio controls src={audioUrl} className="w-full mt-4 h-9" />}
          </div>
        </div>

        <div className="text-center">
          <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-2xl text-[#f0ece4] mb-2">
            Is this your final take?
          </h2>
          <p className="text-[#9490a0] text-sm">Listen back, {uploaded ? "pick another file" : "record again"} to replace, or confirm to continue.</p>
        </div>

        <div className="flex items-center gap-4">
          <Btn variant="secondary" onClick={onRetry} icon={<RotateCcw size={14} />}>
            {uploaded ? "Choose Another" : "Record Again"}
          </Btn>
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
        <p className="text-[#9490a0] text-sm mb-10 text-center">You can switch view and re-export later.</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 w-full max-w-xl">
          {FORMATS.map(f => (
            <motion.button key={f.id} whileHover={{ scale: 1.02, y: -1 }} whileTap={{ scale: 0.98 }}
              onClick={() => onSelect(f.id)}
              className="flex items-start gap-4 p-5 rounded-2xl bg-[#0e0e14] border border-white/6 hover:border-white/14 text-left transition-all duration-200 group">
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

/* ─── SCREEN: GENERATE ─── */
function GenerateScreen({ format, audioBlob, filename, instrument, onBack, onDone }: {
  format: Format; audioBlob: Blob | null; filename: string; instrument: string;
  onBack: () => void; onDone: (jobId: string, score: Score) => void;
}) {
  const [progress, setProgress] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [score, setScore] = useState<Score>(EMPTY_SCORE);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const fmtInfo = formatById(format);
  const Renderer = rendererFor(format);

  useEffect(() => {
    if (!audioBlob) { setError("No recording found — please record again."); return; }
    let cancelled = false;
    let noteInt: ReturnType<typeof setInterval> | undefined;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;

    const prog = setInterval(() => setProgress(p => (p < 90 ? p + (90 - p) * 0.05 : p)), 80);

    transcribeRecording(audioBlob, instrument, filename)
      .then(({ job_id, notes: apiNotes }: { job_id: string; notes: ApiNote[]; duration: number }) => {
        if (cancelled) return;
        clearInterval(prog);
        setProgress(100);

        const built = buildScore(apiNotes);
        setScore(built);

        if (built.noteCount === 0) {
          setError("No notes were detected in that recording. Try playing louder, or closer to the mic.");
          return;
        }

        let count = 0;
        const total = built.events.length;
        const revealMs = Math.max(20, Math.min(140, 3000 / total));
        noteInt = setInterval(() => {
          count++;
          setRevealed(c => Math.min(c + 1, total));
          docRef.current?.scrollTo({ top: docRef.current.scrollHeight, behavior: "smooth" });
          if (count >= total) {
            if (noteInt) clearInterval(noteInt);
            doneTimer = setTimeout(() => onDone(job_id, built), 400);
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
  }, [audioBlob, filename, instrument, onDone]);

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
            style={{ background: `${fmtInfo.color}1e`, color: fmtInfo.color }}>{fmtInfo.name}</span>
        </div>

        <div ref={docRef}
          className="flex-1 overflow-y-auto rounded-2xl bg-white shadow-[0_24px_72px_rgba(0,0,0,0.6)] p-8 min-h-0"
          style={{ scrollbarWidth: "none" }}>
          <Renderer score={score} revealed={revealed} />
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: REVIEW ─── */
function ReviewScreen({ score, format, onBack, onEdit, onAccept }: {
  score: Score; format: Format; onBack: () => void; onEdit: () => void; onAccept: () => void;
}) {
  const [highlight, setHighlight] = useState<number[]>([]);
  const Renderer = rendererFor(format);
  const onHighlight = useCallback((ids: number[]) => setHighlight(ids), []);

  return (
    <Screen>
      <NavBar onBack={onBack} title="Review" />
      <div className="flex-1 flex flex-col px-6 py-6 max-w-3xl mx-auto w-full min-h-0">
        <Document>
          <Renderer score={score} highlight={highlight} />
        </Document>
        <p className="text-center text-[#5e5a70] text-xs mt-3">
          {score.noteCount} notes · {score.measures} bars · ♩={Math.round(score.tempo.bpm)}
          {score.tempo.confidence < 0.45 && " (tempo is a guess — a steadier take detects better)"}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 mt-4 shrink-0">
          <PlaybackBar score={score} onHighlight={onHighlight} />
          <Btn variant="secondary" onClick={onEdit} icon={<Edit3 size={14} />}>Edit Music</Btn>
          <Btn variant="primary" onClick={onAccept} icon={<CheckCircle size={14} />}>Accept Music</Btn>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: EDIT ─── */
function EditScreen({ score, setScore, format, onBack, onContinue, onDelete }: {
  score: Score; setScore: (next: Score) => void; format: Format;
  onBack: () => void; onContinue: () => void; onDelete: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number[]>([]);
  const sel = selected !== null ? score.events.find(e => e.id === selected && e.kind === "note") ?? null : null;
  const Renderer = rendererFor(format);
  const onHighlight = useCallback((ids: number[]) => setHighlight(ids), []);

  /* Every edit re-derives the whole score, so rests and bar lines stay
     consistent with the notes instead of drifting out of sync. */
  function apply(mutate: (events: LaidOutEvent[]) => LaidOutEvent[]) {
    setScore(rebuildAfterEdit(mutate(score.events), score.tempo));
  }

  const shiftPitch = (semitones: number) => {
    if (selected === null) return;
    apply(events => events.map(e => (e.id === selected ? transposeEvent(e, semitones) : e)));
  };

  const removeSelected = () => {
    if (selected === null) return;
    apply(events => events.filter(e => e.id !== selected));
    setSelected(null);
  };

  // Arrow keys are how anyone actually edits a score.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (selected === null) return;
      if (e.key === "ArrowUp")        { e.preventDefault(); shiftPitch(e.shiftKey ? 12 : 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); shiftPitch(e.shiftKey ? -12 : -1); }
      else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); removeSelected(); }
      else if (e.key === "Escape")    { setSelected(null); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Screen>
      <NavBar onBack={onBack} title="Edit Music" />
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6 min-h-0" style={{ scrollbarWidth: "none" }}>
          <div className="rounded-2xl bg-white shadow-[0_24px_72px_rgba(0,0,0,0.6)] p-8 max-w-3xl mx-auto">
            <Renderer score={score} selected={selected} highlight={highlight}
              onNote={id => setSelected(id === selected ? null : id)} editable />
          </div>
          <p className="text-center text-[#3c3850] text-xs mt-4">
            {sel ? "↑ ↓ to move by semitone · shift for an octave · delete to remove" : "Tap any note to select and edit it"}
          </p>
        </div>

        <div className="md:w-60 border-t md:border-t-0 md:border-l border-white/5 bg-[#060608] p-5 flex flex-col gap-5 shrink-0">
          {sel ? (
            <>
              <div className="bg-[#0e0e12] rounded-xl p-3 border border-white/6 text-center">
                <p style={{ fontFamily: "Fraunces,serif" }} className="text-[#f0c040] text-3xl font-light">{sel.pitch}</p>
                <p className="text-[#5e5a70] text-[10px] mt-1">
                  bar {sel.measure + 1} · beat {(sel.beat + 1).toFixed(sel.beat % 1 ? 2 : 0)}
                </p>
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
                Select a note in the score to change its pitch.
              </p>
            </div>
          )}

          <div className="mt-auto flex flex-col gap-2">
            <div className="flex justify-center"><PlaybackBar score={score} onHighlight={onHighlight} compact /></div>
            <Btn variant="primary" onClick={onContinue} className="w-full justify-center">Continue to Download</Btn>
            <Btn variant="danger" onClick={onDelete} icon={<Trash2 size={13} />} className="w-full justify-center">
              Discard Take
            </Btn>
          </div>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: DOWNLOAD & SAVE ─── */
function DownloadScreen({ format, jobId, score, instrument, onFinish }: {
  format: Format; jobId: string | null; score: Score; instrument: string;
  onFinish: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<null | "download" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const fmtInfo = formatById(format);
  const inst = instrumentById(instrument);
  const placeholder = `${inst?.name ?? "Recording"} — ${new Date().toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  })}`;
  const isNotation = format === "sheet" || format === "tab";
  const Renderer = rendererFor(format);
  const finalName = () => name.trim() || placeholder;

  async function saveOnly() {
    setError(null);
    setBusy("save");
    try { await onFinish(finalName()); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't save."); setBusy(null); }
  }

  async function downloadAudioFormat() {
    setError(null);
    setBusy("download");
    try {
      const label = finalName();
      if (format === "midi") {
        // Prefer the backend's MIDI (it carries basic-pitch's pitch bends); if
        // that job has expired, rebuild the file from the notes we hold.
        try {
          if (!jobId) throw new Error("no job");
          await downloadTranscription(jobId, "midi", `${label}.mid`);
        } catch {
          const url = URL.createObjectURL(notesToMidiBlob(
            score.events.filter(e => e.kind === "note").map(e => ({ start: e.start, end: e.end, midi: e.midi }))
          ));
          triggerDownload(url, `${label}.mid`);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        }
      } else {
        if (!jobId) throw new Error("The audio for this take is no longer on the server. Record again to export WAV.");
        await downloadTranscription(jobId, "wav", `${label}.wav`);
      }
      await onFinish(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
      setBusy(null);
    }
  }

  return (
    <Screen>
      <NavBar title="Download" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-sm">
          <div className="rounded-2xl bg-[#0e0e14] border border-white/6 overflow-hidden mb-5">
            {isNotation ? (
              <div ref={wrapRef} className="bg-white p-2 max-h-44 overflow-hidden">
                <Renderer score={score} />
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
            <Field label="Project name" type="text" value={name} placeholder={placeholder}
              onChange={e => setName(e.target.value)} />
          </div>

          {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}

          {isNotation ? (
            <div className="flex flex-col gap-3">
              <div className="flex justify-center">
                <ExportButtons wrapRef={wrapRef} score={score} format={format} name={finalName()} onError={setError} />
              </div>
              <Btn variant="secondary" onClick={saveOnly} disabled={busy !== null} className="w-full justify-center">
                {busy === "save" ? <><Spinner />Saving…</> : <><Save size={14} />Save to my transcriptions</>}
              </Btn>
            </div>
          ) : (
            <>
              <motion.button onClick={downloadAudioFormat} disabled={busy !== null}
                whileHover={busy ? {} : { scale: 1.02 }} whileTap={busy ? {} : { scale: 0.98 }}
                className="w-full py-4 rounded-full font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2.5 disabled:cursor-not-allowed"
                style={{
                  background: busy ? "#1e1e26" : fmtInfo.color,
                  color: busy ? "#5e5a70" : "#0b0b0f",
                  boxShadow: busy ? "none" : `0 8px 28px ${fmtInfo.color}44`,
                }}>
                {busy === "download" ? <><Spinner />Preparing…</> : <><Download size={15} />Download {fmtInfo.name}</>}
              </motion.button>
              <button onClick={saveOnly} disabled={busy !== null}
                className="w-full mt-3 py-2.5 text-[#9490a0] hover:text-[#f0ece4] transition-colors text-xs flex items-center justify-center gap-2 disabled:opacity-50">
                {busy === "save" ? <><Spinner />Saving…</> : <><Save size={13} />Save without downloading</>}
              </button>
            </>
          )}

          <p className="text-center text-[#3c3850] text-[11px] mt-4 leading-relaxed">
            Saving keeps this take in your account — you can reopen and re-export it any time.
          </p>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: SAVED TRANSCRIPTION ───
   Rebuilt from the notes stored in Firestore, so it keeps working long after
   the server-side job and its temp files have expired. */
function ProjectScreen({ record, onBack, onDelete, onRename }: {
  record: TranscriptionRecord; onBack: () => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}) {
  const [view, setView] = useState<"sheet" | "tab">(record.format === "tab" ? "tab" : "sheet");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(record.name);
  const [highlight, setHighlight] = useState<number[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const score = useMemo(() => buildScoreFromStoredNotes(record.notes), [record.notes]);
  const Renderer = view === "tab" ? TabSVG : SheetSVG;
  const onHighlight = useCallback((ids: number[]) => setHighlight(ids), []);

  function exportMidi() {
    setError(null);
    try {
      const url = URL.createObjectURL(notesToMidiBlob(
        score.events.filter(e => e.kind === "note").map(e => ({ start: e.start, end: e.end, midi: e.midi }))
      ));
      triggerDownload(url, `${record.name}.mid`);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  }

  async function saveName() {
    try { await onRename(record.id, draftName); setRenaming(false); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't rename."); }
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try { await onDelete(record.id); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't delete that transcription."); setDeleting(false); }
  }

  return (
    <Screen>
      <NavBar onBack={onBack} title="Saved" />
      <div className="flex-1 flex flex-col px-6 py-6 max-w-3xl mx-auto w-full min-h-0">
        <div className="flex items-start justify-between gap-4 mb-4 shrink-0">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-2">
                <input autoFocus value={draftName} onChange={e => setDraftName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") void saveName(); if (e.key === "Escape") { setDraftName(record.name); setRenaming(false); } }}
                  className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-lg text-[#f0ece4] outline-none focus:border-[#f0c040]/50" />
                <Btn variant="secondary" onClick={saveName}>Save</Btn>
                <Btn variant="ghost" onClick={() => { setDraftName(record.name); setRenaming(false); }}>Cancel</Btn>
              </div>
            ) : (
              <button onClick={() => setRenaming(true)}
                className="group flex items-center gap-2 text-left max-w-full" title="Rename">
                <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-2xl text-[#f0ece4] truncate">
                  {record.name}
                </h2>
                <Pencil size={13} className="text-[#3c3850] group-hover:text-[#9490a0] transition-colors shrink-0" />
              </button>
            )}
            <p className="text-[#5e5a70] text-xs mt-1">
              {record.instrumentName} · {record.noteCount} notes · ♩={Math.round(record.bpm)} · {fmtTime(record.durationSeconds)} · {fmtDate(record.createdAtMs)}
            </p>
          </div>
          <div className="flex rounded-full bg-white/5 border border-white/8 p-0.5 shrink-0">
            {(["sheet", "tab"] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded-full text-xs transition-colors ${
                  view === v ? "bg-[#f0c040] text-black font-medium" : "text-[#9490a0] hover:text-[#f0ece4]"}`}>
                {v === "sheet" ? "Sheet" : "TAB"}
              </button>
            ))}
          </div>
        </div>

        <div ref={wrapRef} className="flex-1 min-h-0">
          <Document>
            <Renderer score={score} title={record.name} highlight={highlight} />
          </Document>
        </div>

        {error && <div className="mt-4"><Notice kind="error">{error}</Notice></div>}

        <div className="flex flex-wrap items-center justify-center gap-3 mt-5 shrink-0">
          <PlaybackBar score={score} onHighlight={onHighlight} />
          <ExportButtons wrapRef={wrapRef} score={score} format={view} name={record.name} onError={setError} />
          <Btn variant="secondary" onClick={exportMidi}>MIDI</Btn>
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
  const [filename, setFilename] = useState("recording.webm");
  const [jobId, setJobId] = useState<string | null>(null);
  const [score, setScore] = useState<Score>(EMPTY_SCORE);

  /* saved work */
  const [projects, setProjects] = useState<TranscriptionRecord[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [, bumpProfile] = useState(0);

  const jobIdRef = useRef<string | null>(null);
  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);

  const resetSession = useCallback(() => {
    if (jobIdRef.current) void deleteJob(jobIdRef.current);
    jobIdRef.current = null;
    setAudioBlob(null);
    setFilename("recording.webm");
    setJobId(null);
    setScore(EMPTY_SCORE);
    setRecDuration(0);
  }, []);

  /* ─── auth session ─── */
  useEffect(() => {
    if (!isFirebaseConfigured) { setAuthReady(true); return; }
    return watchAuthState(nextUser => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) void ensureUserProfile(nextUser).catch(() => {});
    });
  }, []);

  const uid = user?.uid ?? null;

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

    return subscribeToTranscriptions(
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
  }, [uid]);

  /* ─── backend reachability ─── */
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    void checkBackend().then(ok => { if (alive) setBackendOnline(ok); });
    return () => { alive = false; };
  }, [uid]);

  /* ─── actions ─── */
  const handleGenerated = useCallback((newJobId: string, built: Score) => {
    setJobId(newJobId);
    jobIdRef.current = newJobId;
    setScore(built);
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
      notes: toStoredNotes(score.events),
      bpm: score.tempo.bpm,
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

  const renameProject = useCallback(async (id: string, name: string) => {
    if (!uid) return;
    await renameTranscription(uid, id, name);
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
        <motion.div key={activeStep}
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}>

          {activeStep === "dashboard" && (
            <DashboardScreen
              user={user} projects={projects} loading={projectsLoading} error={projectsError}
              search={search} setSearch={setSearch} backendOnline={backendOnline}
              onStart={() => { resetSession(); setStep("instrument"); }}
              onOpenProject={p => { setOpenProjectId(p.id); setStep("project"); }}
              onProfile={() => setStep("profile")}
            />
          )}

          {activeStep === "profile" && (
            <ProfileScreen user={user} projectCount={projects.length}
              onBack={() => setStep("dashboard")}
              onProfileChange={() => bumpProfile(v => v + 1)} />
          )}

          {activeStep === "project" && openProject && (
            <ProjectScreen record={openProject}
              onBack={() => { setOpenProjectId(null); setStep("dashboard"); }}
              onDelete={removeProject} onRename={renameProject} />
          )}

          {activeStep === "instrument" && (
            <InstrumentScreen onBack={() => setStep("dashboard")}
              onSelect={id => { setInstrument(id); setStep("record"); }} />
          )}

          {activeStep === "record" && (
            <RecordScreen onBack={() => setStep("instrument")} instrument={instrument}
              onFinish={(sec, blob, name) => {
                setRecDuration(sec); setAudioBlob(blob); setFilename(name); setStep("confirm");
              }} />
          )}

          {activeStep === "confirm" && (
            <ConfirmScreen onBack={() => setStep("record")} onRetry={() => setStep("record")}
              onContinue={() => setStep("format")} duration={recDuration}
              audioBlob={audioBlob} filename={filename} />
          )}

          {activeStep === "format" && (
            <FormatScreen onBack={() => setStep("confirm")}
              onSelect={f => { setFormat(f); setStep("generate"); }} />
          )}

          {activeStep === "generate" && (
            <GenerateScreen format={format} audioBlob={audioBlob} filename={filename}
              instrument={instrument} onBack={() => setStep("format")} onDone={handleGenerated} />
          )}

          {activeStep === "review" && (
            <ReviewScreen score={score} format={format} onBack={() => setStep("format")}
              onEdit={() => setStep("edit")} onAccept={() => setStep("download")} />
          )}

          {activeStep === "edit" && (
            <EditScreen score={score} setScore={setScore} format={format}
              onBack={() => setStep("review")} onContinue={() => setStep("download")}
              onDelete={() => { resetSession(); setStep("dashboard"); }} />
          )}

          {activeStep === "download" && (
            <DownloadScreen format={format} jobId={jobId} score={score}
              instrument={instrument} onFinish={saveProject} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
