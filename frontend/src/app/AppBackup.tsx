import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Mic, RotateCcw, Check, Download, Edit3, Search,
  ChevronRight, ArrowLeft, Trash2, CheckCircle, Music2,
} from "lucide-react";

import { transcribeRecording, downloadUrl, triggerDownload } from "../api"

/* ─── TYPES ─── */
type Step = "dashboard" | "instrument" | "record" | "confirm" | "format" | "generate" | "review" | "edit" | "download";
type Format = "sheet" | "tab" | "midi" | "wav";
type Dur = "q" | "h" | "w";

interface Project {
  id: string; name: string; date: string; instrument: string;
  format: string; duration: string; color: string;
}
interface Note { sys: number; x: number; y: number; dur: Dur; pitch: string; midi: number; id: number; }
interface ApiNote { start: number; end: number; pitch_midi: number; pitch: string; amplitude: number; }

/* ─── STAFF LAYOUT ─── */
const STAFF_Y = [78, 200];

/* ─── PITCH ↔ STAFF-POSITION HELPERS ───
   Notation is transcribed live from audio, so pitches span an arbitrary
   chromatic range. Accidentals (#) are spelled but share the staff line/space
   of their natural letter, same as real engraving conventions. */
const CHROMA = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const LETTER_STEP: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const E4_DIATONIC = 4 * 7 + LETTER_STEP.E;

function midiToPitchLabel(midi: number) {
  const m = Math.round(midi);
  const idx = ((m % 12) + 12) % 12;
  const octave = Math.floor(m / 12) - 1;
  return `${CHROMA[idx]}${octave}`;
}

function midiToStaffY(midi: number) {
  const m = Math.round(midi);
  const idx = ((m % 12) + 12) % 12;
  const letter = CHROMA[idx][0];
  const octave = Math.floor(m / 12) - 1;
  const diatonic = octave * 7 + LETTER_STEP[letter];
  const y = 48 - 6 * (diatonic - E4_DIATONIC);
  return Math.max(-36, Math.min(84, y));
}

/* ─── TRANSCRIBED-NOTE → SCORE LAYOUT ─── */
function buildScoreFromApiNotes(apiNotes: ApiNote[]): Note[] {
  const sorted = [...apiNotes].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const NOTES_PER_SYSTEM = 12;
  const SYS_X_START = 102;
  const SYS_X_END = 640;

  const durations = sorted.map(n => n.end - n.start).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)] || 0.5;

  return sorted.map((n, i) => {
    const sys = Math.floor(i / NOTES_PER_SYSTEM);
    const posInSystem = i % NOTES_PER_SYSTEM;
    const systemLen = Math.min(NOTES_PER_SYSTEM, sorted.length - sys * NOTES_PER_SYSTEM);
    const span = Math.max(1, systemLen - 1);
    const x = SYS_X_START + posInSystem * ((SYS_X_END - SYS_X_START) / span);
    const rel = n.end - n.start;
    const dur: Dur = rel > median * 1.75 ? "w" : rel > median * 1.15 ? "h" : "q";
    return {
      sys, x, y: midiToStaffY(n.pitch_midi), dur,
      pitch: midiToPitchLabel(n.pitch_midi), midi: n.pitch_midi, id: i,
    };
  });
}

/* ─── GUITAR TAB: STRING/FRET ASSIGNMENT ─── */
const STANDARD_TUNING = [
  { name: "e", midi: 64 }, // string 1 (high E)
  { name: "B", midi: 59 },
  { name: "G", midi: 55 },
  { name: "D", midi: 50 },
  { name: "A", midi: 45 },
  { name: "E", midi: 40 }, // string 6 (low E)
];
const MAX_FRET = 15;

function assignFrets(notes: Note[]) {
  let lastFret: number | null = null;
  return notes.map(note => {
    const midi = Math.round(note.midi);
    const inRange = STANDARD_TUNING
      .map((s, si) => ({ si, fret: midi - s.midi }))
      .filter(c => c.fret >= 0 && c.fret <= MAX_FRET);

    let best: { si: number; fret: number };
    if (inRange.length === 0) {
      // outside playable range on any string — clamp to the closest fret
      best = STANDARD_TUNING
        .map((s, si) => ({ si, fret: Math.max(0, Math.min(MAX_FRET, midi - s.midi)) }))
        .reduce((a, b) => Math.abs(midi - (STANDARD_TUNING[a.si].midi + a.fret)) <=
          Math.abs(midi - (STANDARD_TUNING[b.si].midi + b.fret)) ? a : b);
    } else if (lastFret !== null) {
      best = inRange.reduce((a, b) => {
        const da = Math.abs(a.fret - lastFret!), db = Math.abs(b.fret - lastFret!);
        return da === db ? (a.fret < b.fret ? a : b) : (da < db ? a : b);
      });
    } else {
      best = inRange.reduce((a, b) => (a.fret < b.fret ? a : b));
    }
    lastFret = best.fret;
    return { note, string: best.si, fret: best.fret };
  });
}

const INSTRUMENTS = [
  { id:"guitar",  name:"Guitar",       emoji:"🎸", desc:"Acoustic & Electric" },
  { id:"piano",   name:"Piano",        emoji:"🎹", desc:"Grand & Upright"     },
  { id:"violin",  name:"Violin",       emoji:"🎻", desc:"Classical & Folk"    },
  { id:"bass",    name:"Bass Guitar",  emoji:"🎸", desc:"Electric Bass"       },
  { id:"sax",     name:"Saxophone",    emoji:"🎷", desc:"Alto & Tenor"        },
  { id:"drums",   name:"Drums",        emoji:"🥁", desc:"Kit & Percussion"    },
  { id:"voice",   name:"Voice",        emoji:"🎤", desc:"Vocal & Choir"       },
  { id:"ukulele", name:"Ukulele",      emoji:"🪕", desc:"Soprano & Concert"   },
];

const FORMATS: { id:Format; name:string; desc:string; ext:string; color:string; symbol:string }[] = [
  { id:"sheet", name:"Sheet Music", desc:"Standard notation for any instrument", ext:".SVG",  color:"#f0c040", symbol:"𝄞" },
  { id:"tab",   name:"Guitar TAB",  desc:"Tablature with fret positions",         ext:".SVG",  color:"#30d8a0", symbol:"⑥" },
  { id:"midi",  name:"MIDI",        desc:"Digital instrument data file",           ext:".mid", color:"#a78bfa", symbol:"♫" },
  { id:"wav",   name:"WAV Audio",   desc:"High-quality rendered audio",            ext:".wav", color:"#e8603c", symbol:"◉" },
];

const INITIAL_PROJECTS: Project[] = [
  { id:"1", name:"Nocturne in E Minor",  date:"Jul 18, 2026", instrument:"Piano",  format:"Sheet Music", duration:"2:34", color:"#4a6fa5" },
  { id:"2", name:"Blue Mountain Riff",   date:"Jul 12, 2026", instrument:"Guitar", format:"Guitar TAB",  duration:"1:15", color:"#7a5a9a" },
  { id:"3", name:"Waltz Fragment No. 3", date:"Jul 5, 2026",  instrument:"Violin", format:"Sheet Music", duration:"3:02", color:"#9a5a5a" },
  { id:"4", name:"Sunrise Progression",  date:"Jun 28, 2026", instrument:"Guitar", format:"MIDI",        duration:"0:48", color:"#4a9a6a" },
];

const STATUS_MSGS = [
  "Analyzing audio waveform…",
  "Identifying pitch and rhythm…",
  "Generating notation…",
  "Finalizing document…",
];

/* ─── HELPERS ─── */
function pad2(n: number) { return n.toString().padStart(2, "0"); }
function fmtTime(s: number) { return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; }

/* ─── WAVEFORM CANVAS ─── */
function WaveformCanvas({ active, analyser }: { active: boolean; analyser?: AnalyserNode | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number>(0);
  const bars = useRef<{ h: number; target: number }[]>([]);
  const freqData = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let layoutRaf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const W = c.offsetWidth || 360;
      const H = c.offsetHeight || 64;
      c.width = W * dpr;
      c.height = H * dpr;
      const ctx = c.getContext("2d")!;
      ctx.scale(dpr, dpr);

      const n = 60;
      bars.current = Array.from({ length: n }, () => ({ h: 0.05, target: Math.random() }));
      freqData.current = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;

      function frame() {
        ctx.clearRect(0, 0, W, H);
        const bw = 2.5;
        const gap = (W - n * bw) / (n + 1);

        if (active && analyser && freqData.current) {
          analyser.getByteFrequencyData(freqData.current);
          const bins = freqData.current;
          const step = Math.max(1, Math.floor(bins.length / n));
          bars.current.forEach((bar, i) => {
            const v = bins[Math.min(bins.length - 1, i * step)] / 255;
            bar.h += (Math.max(0.05, v) - bar.h) * 0.35;
          });
        } else {
          bars.current.forEach(bar => {
            if (active && Math.random() < 0.07) bar.target = 0.07 + Math.random() * 0.83;
            bar.h += ((active ? bar.target : 0.03) - bar.h) * (active ? 0.13 : 0.07);
          });
        }

        bars.current.forEach((bar, i) => {
          const bh = Math.max(4, bar.h * H);
          const x = gap + i * (bw + gap);
          const y = (H - bh) / 2;
          ctx.fillStyle = active ? "#f0c040" : "#161420";
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, 1.5);
          else ctx.rect(x, y, bw, bh);
          ctx.fill();
        });
        raf.current = requestAnimationFrame(frame);
      }
      frame();
    });
    return () => { cancelAnimationFrame(layoutRaf); cancelAnimationFrame(raf.current); };
  }, [active, analyser]);

  return <canvas ref={ref} className="w-full h-16" />;
}

/* ─── SHEET MUSIC SVG ─── */
function SheetSVG({
  revealed, notes, selected, onNote, editable,
}: {
  revealed: number; notes: Note[]; selected: number | null;
  onNote?: (id: number) => void; editable?: boolean;
}) {
  const staffLines = [0, 12, 24, 36, 48];
  const barX = [258, 440, 614, 678];

  return (
    <svg viewBox="0 0 688 292" className="w-full" xmlns="http://www.w3.org/2000/svg">
      {/* Document header */}
      <text x="344" y="24" textAnchor="middle" fontFamily="Fraunces, serif" fontSize="14" fill="#1c1818" fontWeight="500" letterSpacing="0.01em">
        Transcribed Score
      </text>
      <text x="344" y="38" textAnchor="middle" fontFamily="Figtree, sans-serif" fontSize="8" fill="#aaa" letterSpacing="0.12em">
        FROM YOUR RECORDING  •  {notes.length} NOTES
      </text>

      {/* Staff systems */}
      {STAFF_Y.map((sY, si) => (
        <g key={si}>
          {staffLines.map(ly => (
            <line key={ly} x1="10" y1={sY + ly} x2="682" y2={sY + ly} stroke="#cac8c2" strokeWidth="0.75" />
          ))}
          <line x1="10" y1={sY} x2="10" y2={sY + 48} stroke="#999" strokeWidth="1" />
          {barX.map((bx, bi) => (
            <line key={bi}
              x1={bx} y1={sY} x2={bx} y2={sY + 48}
              stroke="#999"
              strokeWidth={bi === barX.length - 1 && si === 1 ? 2.8 : 0.9}
            />
          ))}
          {si === 1 && <line x1="672" y1={sY} x2="672" y2={sY + 48} stroke="#999" strokeWidth="0.9" />}
          {/* Treble clef */}
          <text x="13" y={sY + 56} fontSize="60" fill="#5a5a5a" fontFamily="Times New Roman, serif"
            style={{ userSelect: "none" }}>{"𝄞"}</text>
          {/* Time sig */}
          <text x="60" y={sY + 18} fontSize="14" fill="#5a5a5a" fontFamily="Times New Roman, serif" fontWeight="bold">4</text>
          <text x="60" y={sY + 38} fontSize="14" fill="#5a5a5a" fontFamily="Times New Roman, serif" fontWeight="bold">4</text>
          {/* Bar number */}
          <text x="78" y={sY - 5} fontSize="7.5" fill="#ccc" fontFamily="Figtree, sans-serif">{si === 0 ? "1" : "5"}</text>
        </g>
      ))}

      {/* Notes */}
      {notes.slice(0, revealed).map(note => {
        const sY = STAFF_Y[note.sys];
        const cy = sY + note.y;
        const cx = note.x;
        const stemUp = note.y >= 24;
        const open = note.dur !== "q";
        const sel = selected === note.id;
        const col = sel ? "#f0c040" : "#2a2828";
        const isSharp = note.pitch.includes("#");

        return (
          <g key={note.id}
            onClick={() => editable && onNote?.(note.id)}
            style={{ cursor: editable ? "pointer" : "default" }}
          >
            {sel && <circle cx={cx} cy={cy} r="12" fill="#f0c040" opacity="0.18" />}
            {isSharp && (
              <text x={cx - 13} y={cy + 4} fontSize="11" fill={col} fontFamily="serif">♯</text>
            )}
            <ellipse
              cx={cx} cy={cy} rx="6.2" ry="4.6"
              fill={open ? "none" : col}
              stroke={col}
              strokeWidth={open ? "1.7" : "0"}
              transform={`rotate(-18 ${cx} ${cy})`}
            />
            {note.dur !== "w" && (
              stemUp
                ? <line x1={cx + 5.8} y1={cy - 1} x2={cx + 5.8} y2={cy - 31} stroke={col} strokeWidth="1.5" />
                : <line x1={cx - 5.8} y1={cy + 1} x2={cx - 5.8} y2={cy + 31} stroke={col} strokeWidth="1.5" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ─── GUITAR TAB SVG ─── */
function TabSVG({
  revealed, notes, selected, onNote, editable,
}: {
  revealed: number; notes: Note[]; selected: number | null;
  onNote?: (id: number) => void; editable?: boolean;
}) {
  const assigned = useMemo(() => assignFrets(notes), [notes]);
  const STRING_GAP = 10;
  const TAB_TOP = [90, 220];
  const barX = [258, 440, 614, 678];

  return (
    <svg viewBox="0 0 688 292" className="w-full" xmlns="http://www.w3.org/2000/svg">
      <text x="344" y="24" textAnchor="middle" fontFamily="Fraunces, serif" fontSize="14" fill="#1c1818" fontWeight="500" letterSpacing="0.01em">
        Guitar Tablature
      </text>
      <text x="344" y="38" textAnchor="middle" fontFamily="Figtree, sans-serif" fontSize="8" fill="#aaa" letterSpacing="0.12em">
        STANDARD TUNING · E A D G B E
      </text>

      {TAB_TOP.map((topY, si) => (
        <g key={si}>
          {[0, 1, 2, 3, 4, 5].map(li => (
            <line key={li} x1="26" y1={topY + li * STRING_GAP} x2="682" y2={topY + li * STRING_GAP} stroke="#cac8c2" strokeWidth="0.75" />
          ))}
          <line x1="26" y1={topY} x2="26" y2={topY + STRING_GAP * 5} stroke="#999" strokeWidth="1" />
          {barX.map((bx, bi) => (
            <line key={bi}
              x1={bx} y1={topY} x2={bx} y2={topY + STRING_GAP * 5}
              stroke="#999"
              strokeWidth={bi === barX.length - 1 && si === 1 ? 2.8 : 0.9}
            />
          ))}
          {si === 1 && <line x1="672" y1={topY} x2="672" y2={topY + STRING_GAP * 5} stroke="#999" strokeWidth="0.9" />}
          {STANDARD_TUNING.map((s, li) => (
            <text key={li} x="14" y={topY + li * STRING_GAP + 2.6} fontSize="6.5" fill="#9a9690" fontFamily="Figtree, sans-serif">
              {s.name}
            </text>
          ))}
          <text x="78" y={topY - 5} fontSize="7.5" fill="#ccc" fontFamily="Figtree, sans-serif">{si === 0 ? "1" : "5"}</text>
        </g>
      ))}

      {assigned.slice(0, revealed).map(({ note, string, fret }) => {
        const topY = TAB_TOP[note.sys];
        const cy = topY + string * STRING_GAP;
        const cx = note.x;
        const sel = selected === note.id;

        return (
          <g key={note.id}
            onClick={() => editable && onNote?.(note.id)}
            style={{ cursor: editable ? "pointer" : "default" }}
          >
            {sel && <circle cx={cx} cy={cy} r="9" fill="#f0c040" opacity="0.22" />}
            <rect x={cx - 7.5} y={cy - 6} width="15" height="12" fill="white" />
            <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize="9.5" fontFamily="Figtree, sans-serif" fontWeight="600"
              fill={sel ? "#f0c040" : "#2a2828"}>
              {fret}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ─── SHARED LAYOUT BITS ─── */
function Screen({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`min-h-screen bg-black text-[#f0ece4] flex flex-col font-[Figtree,sans-serif] ${className}`}>
      {children}
    </div>
  );
}

function NavBar({ onBack, title }: { onBack?: () => void; title?: string }) {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-white/5 shrink-0">
      {onBack ? (
        <button onClick={onBack}
          className="flex items-center gap-1.5 text-[#9490a0] hover:text-[#f0ece4] transition-colors text-sm">
          <ArrowLeft size={14} /><span>Back</span>
        </button>
      ) : (
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#3b82f6] flex items-center justify-center shadow-[0_0_12px_rgba(59,130,246,0.55)]">
            <Music2 size={14} className="text-white" />
          </div>
          <span style={{ fontFamily: "Fraunces,serif" }} className="text-[#f0ece4] font-medium tracking-wide text-lg">
            Tabify
          </span>
        </div>
      )}
      {title && (
        <span className="text-[10px] text-[#5e5a70] uppercase tracking-[0.15em] font-medium">{title}</span>
      )}
      <div className="w-16" />
    </header>
  );
}

function Btn({
  children, onClick, variant = "primary", disabled = false, className = "", icon,
}: {
  children: ReactNode; onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean; className?: string; icon?: ReactNode;
}) {
  const base = "inline-flex items-center gap-2 px-5 py-2.5 rounded-full font-medium text-sm transition-all duration-200 select-none";
  const map = {
    primary:   "bg-[#f0c040] hover:bg-[#f8cc50] text-black disabled:opacity-40",
    secondary: "bg-white/7 hover:bg-white/11 text-[#f0ece4] border border-white/10",
    ghost:     "text-[#9490a0] hover:text-[#f0ece4] hover:bg-white/5",
    danger:    "bg-[#e8603c]/12 hover:bg-[#e8603c]/22 text-[#e07a62] border border-[#e8603c]/22",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${map[variant]} ${className}`}>
      {icon}{children}
    </button>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex-1 overflow-y-auto rounded-2xl bg-white shadow-[0_24px_72px_rgba(0,0,0,0.65)] p-8"
      style={{ scrollbarWidth: "none" }}
    >
      {children}
    </div>
  );
}

/* ─── SCREEN: DASHBOARD ─── */
function DashboardScreen({ onStart, projects, search, setSearch }: {
  onStart: () => void; projects: Project[];
  search: string; setSearch: (s: string) => void;
}) {
  const filtered = projects.filter(p =>
    [p.name, p.instrument, p.format].some(v => v.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <Screen>
      <NavBar />
      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pt-16 pb-10 text-center">
        {/* Decorative staff */}
        <div className="relative w-80 mb-10 pointer-events-none select-none">
          {[0, 1, 2, 3, 4].map(i => (
            <div key={i} className="h-px mb-3 last:mb-0" style={{ background: "rgba(240,192,64,0.28)" }} />
          ))}
          <motion.span
            animate={{ y: [-6, 6, -6] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            className="absolute -top-3 left-[14%] text-4xl drop-shadow-[0_0_8px_rgba(240,192,64,0.9)]"
            style={{ fontFamily: "serif", color: "#f0c040" }}
          >♩</motion.span>
          <motion.span
            animate={{ y: [5, -5, 5] }}
            transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
            className="absolute top-0 left-[52%] text-3xl drop-shadow-[0_0_8px_rgba(48,216,160,0.9)]"
            style={{ fontFamily: "serif", color: "#30d8a0" }}
          >♪</motion.span>
          <motion.span
            animate={{ y: [-4, 6, -4] }}
            transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut", delay: 0.9 }}
            className="absolute -top-2 right-[10%] text-3xl drop-shadow-[0_0_8px_rgba(59,130,246,0.9)]"
            style={{ fontFamily: "serif", color: "#60a5fa" }}
          >♫</motion.span>
          <motion.span
            animate={{ y: [3, -5, 3] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 1.6 }}
            className="absolute top-1 left-[32%] text-2xl drop-shadow-[0_0_6px_rgba(167,139,250,0.85)]"
            style={{ fontFamily: "serif", color: "#a78bfa" }}
          >♬</motion.span>
        </div>

        <h1 style={{ fontFamily: "Fraunces,serif" }}
          className="text-6xl md:text-7xl font-light text-[#f0ece4] tracking-tight mb-4">
          Tabify
        </h1>
        <p className="text-[#9490a0] text-[15px] max-w-xs leading-relaxed mb-10">
          Record your music. Get instant sheet music, TAB, MIDI, and more.
        </p>

        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={onStart}
          className="px-10 py-4 bg-[#f0c040] hover:bg-[#f8cc50] text-black rounded-full text-[15px] font-semibold tracking-wide transition-colors duration-200 shadow-[0_8px_32px_rgba(240,192,64,0.4)]"
        >
          Start Recording
        </motion.button>
      </div>

      {/* Projects */}
      {projects.length > 0 && (
        <div className="pb-10 px-6">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-[17px] text-[#f0ece4] font-medium">
                Previous Projects
              </h2>
              <div className="relative">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9490a0]" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="bg-white/5 border border-white/8 rounded-full pl-8 pr-4 py-1.5 text-sm text-[#f0ece4] placeholder:text-[#5e5a70] outline-none focus:border-[#f0c040]/50 transition-colors w-44"
                />
              </div>
            </div>

            <div className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: "none" }}>
              {filtered.length === 0 ? (
                <p className="text-[#5e5a70] text-sm py-6">No projects match your search.</p>
              ) : filtered.map(p => (
                <motion.div
                  key={p.id}
                  whileHover={{ y: -3 }}
                  transition={{ duration: 0.2 }}
                  className="flex-none w-52 rounded-2xl overflow-hidden border border-white/6 bg-[#0e0e14] hover:border-white/12 transition-colors cursor-pointer"
                >
                  <div className="h-24 flex items-center justify-center"
                    style={{ background: `linear-gradient(135deg, ${p.color}44, ${p.color}18)` }}>
                    <span className="text-4xl select-none">
                      {INSTRUMENTS.find(i => i.name === p.instrument)?.emoji ?? "🎵"}
                    </span>
                  </div>
                  <div className="p-3.5">
                    <p className="text-[#f0ece4] text-[13px] font-medium mb-0.5 truncate">{p.name}</p>
                    <p className="text-[#9490a0] text-[11px] mb-2.5">{p.format}</p>
                    <div className="flex justify-between text-[10px] text-[#5e5a70]">
                      <span>{p.instrument}</span><span>{p.date}</span>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      )}
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
              whileHover={{ scale: 1.03, y: -2 }}
              whileTap={{ scale: 0.97 }}
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
  const inst = INSTRUMENTS.find(i => i.id === instrument);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setTime(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close().catch(() => {});
    };
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
    } catch {
      setError("Microphone access was denied or unavailable.");
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
      onFinish(finalTime, blob);
    };
    recorder.stop();
    setRecording(false);
  }

  function toggle() {
    if (!recording) startRecording();
    else stopRecording();
  }

  return (
    <Screen>
      <NavBar onBack={onBack} title="Record" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-8">
        {/* Instrument badge */}
        <div className="flex items-center gap-3 px-5 py-2.5 bg-white/5 rounded-full border border-white/8">
          <span className="text-xl select-none">{inst?.emoji}</span>
          <span className="text-[#f0ece4] text-sm">{inst?.name}</span>
        </div>

        {/* Waveform area */}
        <div className="w-full max-w-sm h-16">
          {time > 0 || recording ? (
            <WaveformCanvas active={recording} analyser={analyser} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-[#3c3850] text-sm">Press record to begin</p>
            </div>
          )}
        </div>

        {/* Timer */}
        <span className="text-4xl text-[#f0ece4] tracking-[0.18em] tabular-nums"
          style={{ fontFamily: "JetBrains Mono, monospace" }}>
          {fmtTime(time)}
        </span>

        {/* Record button */}
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={toggle}
          className={`flex items-center gap-3 px-9 py-4 rounded-full text-[15px] font-semibold transition-all duration-300 ${recording
            ? "bg-white/7 border border-white/10 text-[#f0ece4]"
            : "bg-[#e8603c] hover:bg-[#f07050] text-white shadow-[0_8px_28px_rgba(232,96,60,0.45)]"
          }`}
        >
          {recording ? (
            <>
              <span className="w-3 h-3 rounded-full bg-[#e8603c] animate-pulse" />
              Finish Recording
            </>
          ) : (
            <><Mic size={17} />Record</>
          )}
        </motion.button>

        {recording && (
          <p className="text-[#3c3850] text-sm animate-pulse">Play near the microphone</p>
        )}
        {error && (
          <p className="text-[#e07a62] text-sm max-w-xs text-center">{error}</p>
        )}
      </div>
    </Screen>
  );
}

/* ─── SCREEN: CONFIRM ─── */
function ConfirmScreen({ onBack, onRetry, onContinue, duration, audioBlob }: {
  onBack: () => void; onRetry: () => void; onContinue: () => void; duration: number; audioBlob: Blob | null;
}) {
  const audioUrl = useMemo(() => audioBlob ? URL.createObjectURL(audioBlob) : null, [audioBlob]);
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
              <audio src={audioUrl} controls className="w-full mt-4 h-9" />
            )}
          </div>
        </div>

        <div className="text-center">
          <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-2xl text-[#f0ece4] mb-2">
            Is this your final take?
          </h2>
          <p className="text-[#9490a0] text-sm">Record again to replace, or confirm to continue.</p>
        </div>

        <div className="flex items-center gap-4">
          <Btn variant="secondary" onClick={onRetry} icon={<RotateCcw size={14} />}>
            Record Again
          </Btn>
          <Btn variant="primary" onClick={onContinue} icon={<Check size={14} />}>
            Confirm Take
          </Btn>
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
        <p className="text-[#9490a0] text-sm mb-10 text-center">More formats arriving soon.</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 w-full max-w-xl">
          {FORMATS.map(f => (
            <motion.button key={f.id}
              whileHover={{ scale: 1.02, y: -1 }}
              whileTap={{ scale: 0.98 }}
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
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-current"
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
function GenerateScreen({ format, audioBlob, instrument, onBack, onDone }: {
  format: Format; audioBlob: Blob | null; instrument: string;
  onBack: () => void;
  onDone: (jobId: string, notes: Note[]) => void;
}) {
  const [progress, setProgress] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const fmtInfo = FORMATS.find(f => f.id === format)!;
  const Renderer = format === "tab" ? TabSVG : SheetSVG;

  useEffect(() => {
    if (!audioBlob) { setError("No recording found — please record again."); return; }
    let cancelled = false;

    // Progress bar eases toward 90% while the request is in flight, then
    // snaps to 100% once the transcription actually comes back.
    const prog = setInterval(() => {
      setProgress(p => (p < 90 ? p + (90 - p) * 0.05 : p));
    }, 80);

    transcribeRecording(audioBlob, instrument)
      .then(({ job_id, notes: apiNotes }: { job_id: string; notes: ApiNote[]; duration: number }) => {
        if (cancelled) return;
        clearInterval(prog);
        setProgress(100);

        const mapped = buildScoreFromApiNotes(apiNotes);
        setNotes(mapped);

        if (mapped.length === 0) {
          setTimeout(() => onDone(job_id, mapped), 400);
          return;
        }

        let count = 0;
        const revealMs = Math.max(30, Math.min(175, 3500 / mapped.length));
        const noteInt = setInterval(() => {
          count++;
          setRevealed(c => Math.min(c + 1, mapped.length));
          docRef.current?.scrollTo({ top: docRef.current.scrollHeight, behavior: "smooth" });
          if (count >= mapped.length) {
            clearInterval(noteInt);
            setTimeout(() => onDone(job_id, mapped), 400);
          }
        }, revealMs);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || "Transcription failed. Please try again.");
      });

    return () => { cancelled = true; clearInterval(prog); };
  }, [audioBlob, instrument]);

  if (error) {
    return (
      <Screen>
        <NavBar title="Generating" />
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5 text-center">
          <p className="text-[#e07a62] text-sm max-w-sm">{error}</p>
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
        {/* Progress */}
        <div className="mb-5 shrink-0">
          <div className="flex justify-between mb-2">
            <span className="text-[#9490a0] text-sm">{STATUS_MSGS[statusIdx]}</span>
            <span style={{ fontFamily: "JetBrains Mono, monospace" }} className="text-[#f0c040] text-xs">
              {Math.round(progress)}%
            </span>
          </div>
          <div className="h-0.5 bg-white/6 rounded-full overflow-hidden">
            <div className="h-full bg-[#f0c040] rounded-full transition-all duration-75"
              style={{ width: `${progress}%` }} />
          </div>
        </div>

        {/* Format badge */}
        <div className="flex items-center gap-2 mb-4 shrink-0">
          <span className="text-xs text-[#5e5a70]">Output:</span>
          <span className="px-2.5 py-0.5 rounded-full text-xs font-medium"
            style={{ background: `${fmtInfo.color}1e`, color: fmtInfo.color }}>
            {fmtInfo.name}
          </span>
        </div>

        {/* Document */}
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
  const Renderer = format === "tab" ? TabSVG : SheetSVG;
  return (
    <Screen>
      <NavBar onBack={onBack} title="Review" />
      <div className="flex-1 flex flex-col px-6 py-6 max-w-3xl mx-auto w-full min-h-0">
        <Document>
          <Renderer revealed={notes.length} notes={notes} selected={null} />
        </Document>
        <div className="flex items-center justify-center gap-4 mt-5 shrink-0">
          <Btn variant="secondary" onClick={onEdit} icon={<Edit3 size={14} />}>Edit Music</Btn>
          <Btn variant="primary" onClick={onAccept} icon={<CheckCircle size={14} />}>Accept Music</Btn>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: EDIT ─── */
function EditScreen({ notes, setNotes, format, onBack, onContinue, onDelete }: {
  notes: Note[]; setNotes: (updater: (prev: Note[]) => Note[]) => void; format: Format;
  onBack: () => void; onContinue: () => void; onDelete: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const sel = selected !== null ? notes.find(n => n.id === selected) ?? null : null;
  const Renderer = format === "tab" ? TabSVG : SheetSVG;

  function shiftPitch(dir: 1 | -1) {
    if (selected === null || !sel) return;
    const midi = sel.midi + dir;
    setNotes(prev => prev.map(n => n.id === selected
      ? { ...n, midi, pitch: midiToPitchLabel(midi), y: midiToStaffY(midi) }
      : n));
  }

  function setDur(d: Dur) {
    if (selected === null) return;
    setNotes(prev => prev.map(n => n.id === selected ? { ...n, dur: d } : n));
  }

  return (
    <Screen>
      <NavBar onBack={onBack} title="Edit Music" />
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        {/* Document */}
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
            <p className="text-center text-[#3c3850] text-xs mt-4">
              Tap any note to select and edit it
            </p>
          )}
        </div>

        {/* Editor panel */}
        <div className="md:w-60 border-t md:border-t-0 md:border-l border-white/5 bg-[#060608] p-5 flex flex-col gap-5 shrink-0">
          {sel ? (
            <>
              {/* Current note display */}
              <div className="bg-[#0e0e12] rounded-xl p-3 border border-white/6 text-center">
                <p style={{ fontFamily: "Fraunces,serif" }} className="text-[#f0c040] text-3xl font-light">
                  {sel.pitch}
                </p>
                <p className="text-[#5e5a70] text-[10px] mt-1">Selected note</p>
              </div>

              {/* Pitch */}
              <div>
                <p className="text-[#5e5a70] text-[10px] uppercase tracking-widest mb-2">Pitch</p>
                <div className="flex items-center gap-2">
                  <button onClick={() => shiftPitch(-1)}
                    className="w-8 h-8 rounded-full bg-white/6 hover:bg-white/10 text-[#f0ece4] transition-colors flex items-center justify-center text-base leading-none">−</button>
                  <span className="flex-1 text-center text-[#f0ece4] text-sm font-medium">{sel.pitch}</span>
                  <button onClick={() => shiftPitch(1)}
                    className="w-8 h-8 rounded-full bg-white/6 hover:bg-white/10 text-[#f0ece4] transition-colors flex items-center justify-center text-base leading-none">+</button>
                </div>
                <p className="text-[#3c3850] text-[10px] mt-2">Nudges the note up or down by a semitone.</p>
              </div>

              {/* Duration */}
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

          {/* Actions */}
          <div className="mt-auto flex flex-col gap-2">
            <Btn variant="primary" onClick={onContinue} className="w-full justify-center">
              Continue to Download
            </Btn>
            <Btn variant="danger" onClick={onDelete} icon={<Trash2 size={13} />} className="w-full justify-center">
              Delete
            </Btn>
          </div>
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: DOWNLOAD ─── */
function DownloadScreen({ format, jobId, notes, instrument, onDownload }: {
  format: Format; jobId: string | null; notes: Note[]; instrument: string; onDownload: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const fmtInfo = FORMATS.find(f => f.id === format)!;
  const inst = INSTRUMENTS.find(i => i.id === instrument);
  const placeholder = `${inst?.name ?? "Recording"} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  const isNotation = format === "sheet" || format === "tab";
  const Renderer = format === "tab" ? TabSVG : SheetSVG;

  async function handle() {
    setError(null);
    setLoading(true);
    const finalName = name || placeholder;
    try {
      if (isNotation) {
        const svgEl = svgWrapRef.current?.querySelector("svg");
        if (!svgEl) throw new Error("Nothing to export yet.");
        const svgString = new XMLSerializer().serializeToString(svgEl);
        const blob = new Blob([svgString], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        triggerDownload(url, `${finalName}.svg`);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        if (!jobId) throw new Error("Recording hasn't finished processing yet.");
        triggerDownload(downloadUrl(jobId, format), `${finalName}.${format === "midi" ? "mid" : "wav"}`);
      }
      onDownload(finalName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <NavBar title="Download" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-0">
        <div className="w-full max-w-xs">
          {/* Format card */}
          <div className="rounded-2xl bg-[#0e0e14] border border-white/6 overflow-hidden mb-5">
            {isNotation ? (
              <div ref={svgWrapRef} className="bg-white p-2">
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

          {/* Name input */}
          <div className="mb-5">
            <label className="text-[#5e5a70] text-[10px] uppercase tracking-widest mb-2 block">
              Project Name
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={placeholder}
              className="w-full bg-white/5 border border-white/8 rounded-xl px-4 py-3 text-sm text-[#f0ece4] placeholder:text-[#3c3850] outline-none focus:border-[#f0c040]/45 transition-colors"
            />
          </div>

          {/* Download button */}
          <motion.button
            onClick={handle}
            disabled={loading}
            whileHover={loading ? {} : { scale: 1.02 }}
            whileTap={loading ? {} : { scale: 0.98 }}
            className="w-full py-4 rounded-full font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2.5"
            style={{
              background: loading ? "#1e1e26" : fmtInfo.color,
              color: loading ? "#5e5a70" : "#0b0b0f",
              boxShadow: loading ? "none" : `0 8px 28px ${fmtInfo.color}44`,
            }}
          >
            {loading ? (
              <>
                <motion.span
                  className="w-4 h-4 rounded-full border-2 border-[#5e5a70] border-t-transparent inline-block"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 0.75, repeat: Infinity, ease: "linear" }}
                />
                Preparing…
              </>
            ) : (
              <><Download size={15} />Download {fmtInfo.name}</>
            )}
          </motion.button>

          {error && (
            <p className="text-center text-[#e07a62] text-xs mt-3">{error}</p>
          )}
        </div>
      </div>
    </Screen>
  );
}

/* ─── MAIN APP ─── */
export default function App() {
  const [step, setStep] = useState<Step>("dashboard");
  const [instrument, setInstrument] = useState("piano");
  const [recDuration, setRecDuration] = useState(0);
  const [format, setFormat] = useState<Format>("sheet");
  const [projects, setProjects] = useState<Project[]>(INITIAL_PROJECTS);
  const [search, setSearch] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [score, setScore] = useState<Note[]>([]);

  function addProject(name: string) {
    const inst = INSTRUMENTS.find(i => i.id === instrument);
    const fmtInfo = FORMATS.find(f => f.id === format)!;
    const palette = ["#4a6fa5", "#7a5a9a", "#9a5a5a", "#4a9a6a", "#9a7a4a", "#4a7a9a", "#8a4a6a"];
    setProjects(prev => [{
      id: Date.now().toString(),
      name,
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      instrument: inst?.name ?? "Unknown",
      format: fmtInfo.name,
      duration: fmtTime(recDuration),
      color: palette[prev.length % palette.length],
    }, ...prev]);
  }

  function resetSession() {
    setAudioBlob(null);
    setJobId(null);
    setScore([]);
    setRecDuration(0);
  }

  const go = (s: Step) => setStep(s);

  return (
    <div className="dark">
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}
        >
          {step === "dashboard" && (
            <DashboardScreen
              onStart={() => { resetSession(); go("instrument"); }}
              projects={projects}
              search={search}
              setSearch={setSearch}
            />
          )}
          {step === "instrument" && (
            <InstrumentScreen
              onBack={() => go("dashboard")}
              onSelect={id => { setInstrument(id); go("record"); }}
            />
          )}
          {step === "record" && (
            <RecordScreen
              onBack={() => go("instrument")}
              instrument={instrument}
              onFinish={(sec, blob) => { setRecDuration(sec); setAudioBlob(blob); go("confirm"); }}
            />
          )}
          {step === "confirm" && (
            <ConfirmScreen
              onBack={() => go("record")}
              onRetry={() => go("record")}
              onContinue={() => go("format")}
              duration={recDuration}
              audioBlob={audioBlob}
            />
          )}
          {step === "format" && (
            <FormatScreen
              onBack={() => go("confirm")}
              onSelect={f => { setFormat(f); go("generate"); }}
            />
          )}
          {step === "generate" && (
            <GenerateScreen
              format={format}
              audioBlob={audioBlob}
              instrument={instrument}
              onBack={() => go("format")}
              onDone={(id, notes) => { setJobId(id); setScore(notes); go("review"); }}
            />
          )}
          {step === "review" && (
            <ReviewScreen
              notes={score}
              format={format}
              onBack={() => go("format")}
              onEdit={() => go("edit")}
              onAccept={() => go("download")}
            />
          )}
          {step === "edit" && (
            <EditScreen
              notes={score}
              setNotes={setScore}
              format={format}
              onBack={() => go("review")}
              onContinue={() => go("download")}
              onDelete={() => { resetSession(); go("dashboard"); }}
            />
          )}
          {step === "download" && (
            <DownloadScreen
              format={format}
              jobId={jobId}
              notes={score}
              instrument={instrument}
              onDownload={name => { addProject(name); resetSession(); go("dashboard"); }}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
