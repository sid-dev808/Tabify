import { useState, useEffect, useRef, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Mic, RotateCcw, Check, Download, Edit3, Search,
  ChevronRight, ArrowLeft, Trash2, CheckCircle, Music2,
} from "lucide-react";

import { transcribeRecording } from "../api"

/* ─── TYPES ─── */
type Step = "dashboard" | "instrument" | "record" | "confirm" | "format" | "generate" | "review" | "edit" | "download";
type Format = "sheet" | "tab" | "midi" | "wav";
type Dur = "q" | "h" | "w";

interface Project {
  id: string; name: string; date: string; instrument: string;
  format: string; duration: string; color: string;
}
interface Note { sys: number; x: number; y: number; dur: Dur; pitch: string; id: number; }

/* ─── SCORE DATA  (Fraunces Autumn, G-major fragment, 2 systems × 4 bars) ─── */
const STAFF_Y = [78, 200];

const BASE_SCORE: Note[] = [
  // System 0 – Measures 1-4
  { sys:0, x:102, y:6,  dur:"q", pitch:"E5", id:0  },
  { sys:0, x:142, y:12, dur:"q", pitch:"D5", id:1  },
  { sys:0, x:182, y:18, dur:"q", pitch:"C5", id:2  },
  { sys:0, x:222, y:24, dur:"q", pitch:"B4", id:3  },
  { sys:0, x:282, y:30, dur:"q", pitch:"A4", id:4  },
  { sys:0, x:322, y:24, dur:"q", pitch:"B4", id:5  },
  { sys:0, x:378, y:18, dur:"h", pitch:"C5", id:6  },
  { sys:0, x:462, y:12, dur:"q", pitch:"D5", id:7  },
  { sys:0, x:502, y:6,  dur:"q", pitch:"E5", id:8  },
  { sys:0, x:542, y:0,  dur:"q", pitch:"F5", id:9  },
  { sys:0, x:582, y:6,  dur:"q", pitch:"E5", id:10 },
  { sys:0, x:640, y:12, dur:"w", pitch:"D5", id:11 },
  // System 1 – Measures 5-8
  { sys:1, x:102, y:24, dur:"q", pitch:"B4", id:12 },
  { sys:1, x:142, y:18, dur:"q", pitch:"C5", id:13 },
  { sys:1, x:182, y:12, dur:"q", pitch:"D5", id:14 },
  { sys:1, x:222, y:6,  dur:"q", pitch:"E5", id:15 },
  { sys:1, x:282, y:0,  dur:"q", pitch:"F5", id:16 },
  { sys:1, x:322, y:6,  dur:"q", pitch:"E5", id:17 },
  { sys:1, x:378, y:12, dur:"h", pitch:"D5", id:18 },
  { sys:1, x:462, y:18, dur:"q", pitch:"C5", id:19 },
  { sys:1, x:502, y:24, dur:"q", pitch:"B4", id:20 },
  { sys:1, x:542, y:30, dur:"q", pitch:"A4", id:21 },
  { sys:1, x:582, y:36, dur:"q", pitch:"G4", id:22 },
  { sys:1, x:640, y:36, dur:"w", pitch:"G4", id:23 },
];

const PITCH_Y: Record<string, number> = {
  F5:0, E5:6, D5:12, C5:18, B4:24, A4:30, G4:36, F4:42, E4:48,
};
const PITCHES = ["F5","E5","D5","C5","B4","A4","G4","F4","E4"];

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
  { id:"sheet", name:"Sheet Music", desc:"Standard notation for any instrument", ext:"PDF / DOCX", color:"#f0c040", symbol:"𝄞" },
  { id:"tab",   name:"Guitar TAB",  desc:"Tablature with fret positions",         ext:"PDF / DOCX", color:"#30d8a0", symbol:"⑥" },
  { id:"midi",  name:"MIDI",        desc:"Digital instrument data file",           ext:".mid",       color:"#a78bfa", symbol:"♫" },
  { id:"wav",   name:"WAV Audio",   desc:"High-quality rendered audio",            ext:".wav",       color:"#e8603c", symbol:"◉" },
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
function WaveformCanvas({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number>(0);
  const bars = useRef<{ h: number; target: number }[]>([]);

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

      function frame() {
        ctx.clearRect(0, 0, W, H);
        const bw = 2.5;
        const gap = (W - n * bw) / (n + 1);
        bars.current.forEach((bar, i) => {
          if (active && Math.random() < 0.07) bar.target = 0.07 + Math.random() * 0.83;
          bar.h += ((active ? bar.target : 0.03) - bar.h) * (active ? 0.13 : 0.07);
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
  }, [active]);

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
        Autumn Fragment
      </text>
      <text x="344" y="38" textAnchor="middle" fontFamily="Figtree, sans-serif" fontSize="8" fill="#aaa" letterSpacing="0.12em">
        ORIGINAL COMPOSITION  •  4/4  •  ♩ = 84
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

        return (
          <g key={note.id}
            onClick={() => editable && onNote?.(note.id)}
            style={{ cursor: editable ? "pointer" : "default" }}
          >
            {sel && <circle cx={cx} cy={cy} r="12" fill="#f0c040" opacity="0.18" />}
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
  onBack: () => void; instrument: string; onFinish: (sec: number) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [time, setTime] = useState(0);
  const inst = INSTRUMENTS.find(i => i.id === instrument);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setTime(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  function toggle() {
    if (!recording) { setRecording(true); }
    else { setRecording(false); onFinish(time); }
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
            <WaveformCanvas active={recording} />
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
      </div>
    </Screen>
  );
}

/* ─── SCREEN: CONFIRM ─── */
function ConfirmScreen({ onBack, onRetry, onContinue, duration }: {
  onBack: () => void; onRetry: () => void; onContinue: () => void; duration: number;
}) {
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
function GenerateScreen({ format, onDone }: { format: Format; onDone: () => void }) {
  const [progress, setProgress] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const docRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<ReturnType<typeof setTimeout>>();
  const fmtInfo = FORMATS.find(f => f.id === format)!;

  useEffect(() => {
    const total = 5600;
    const start = Date.now();

    const prog = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - start) / total) * 100);
      setProgress(pct);
      if (pct >= 100) {
        clearInterval(prog);
        doneRef.current = setTimeout(onDone, 400);
      }
    }, 60);

    // Start revealing notes after ~25% (≈1.4 s)
    const noteStart = setTimeout(() => {
      let count = 0;
      const noteInt = setInterval(() => {
        count++;
        setRevealed(c => Math.min(c + 1, BASE_SCORE.length));
        docRef.current?.scrollTo({ top: docRef.current.scrollHeight, behavior: "smooth" });
        if (count >= BASE_SCORE.length) clearInterval(noteInt);
      }, 175);
      return () => clearInterval(noteInt);
    }, 1400);

    return () => {
      clearInterval(prog);
      clearTimeout(noteStart);
      if (doneRef.current) clearTimeout(doneRef.current);
    };
  }, []);

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
          <SheetSVG revealed={revealed} notes={BASE_SCORE} selected={null} />
        </div>
      </div>
    </Screen>
  );
}

/* ─── SCREEN: REVIEW ─── */
function ReviewScreen({ onBack, onEdit, onAccept }: {
  onBack: () => void; onEdit: () => void; onAccept: () => void;
}) {
  return (
    <Screen>
      <NavBar onBack={onBack} title="Review" />
      <div className="flex-1 flex flex-col px-6 py-6 max-w-3xl mx-auto w-full min-h-0">
        <Document>
          <SheetSVG revealed={BASE_SCORE.length} notes={BASE_SCORE} selected={null} />
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
function EditScreen({ onBack, onContinue, onDelete }: {
  onBack: () => void; onContinue: () => void; onDelete: () => void;
}) {
  const [notes, setNotes] = useState<Note[]>(BASE_SCORE.map(n => ({ ...n })));
  const [selected, setSelected] = useState<number | null>(null);
  const sel = selected !== null ? notes.find(n => n.id === selected) ?? null : null;

  function shiftPitch(dir: 1 | -1) {
    if (selected === null || !sel) return;
    const i = PITCHES.indexOf(sel.pitch);
    const ni = Math.max(0, Math.min(PITCHES.length - 1, i + dir));
    setPitch(selected, PITCHES[ni]);
  }

  function setPitch(id: number, p: string) {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, pitch: p, y: PITCH_Y[p] } : n));
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
            <SheetSVG
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
                <div className="flex items-center gap-2 mb-2">
                  <button onClick={() => shiftPitch(1)}
                    className="w-8 h-8 rounded-full bg-white/6 hover:bg-white/10 text-[#f0ece4] transition-colors flex items-center justify-center text-base leading-none">−</button>
                  <span className="flex-1 text-center text-[#f0ece4] text-sm font-medium">{sel.pitch}</span>
                  <button onClick={() => shiftPitch(-1)}
                    className="w-8 h-8 rounded-full bg-white/6 hover:bg-white/10 text-[#f0ece4] transition-colors flex items-center justify-center text-base leading-none">+</button>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {PITCHES.map(p => (
                    <button key={p} onClick={() => selected !== null && setPitch(selected, p)}
                      className={`text-xs py-1.5 rounded-lg transition-colors ${
                        sel.pitch === p
                          ? "bg-[#f0c040]/18 text-[#f0c040]"
                          : "text-[#9490a0] hover:bg-white/5 hover:text-[#f0ece4]"
                      }`}>{p}</button>
                  ))}
                </div>
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
function DownloadScreen({ format, instrument, onDownload }: {
  format: Format; instrument: string; onDownload: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const fmtInfo = FORMATS.find(f => f.id === format)!;
  const inst = INSTRUMENTS.find(i => i.id === instrument);
  const placeholder = `${inst?.name ?? "Recording"} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  function handle() {
    setLoading(true);
    setTimeout(() => { setLoading(false); onDownload(name || placeholder); }, 1800);
  }

  return (
    <Screen>
      <NavBar title="Download" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-0">
        <div className="w-full max-w-xs">
          {/* Format card */}
          <div className="rounded-2xl bg-[#0e0e14] border border-white/6 overflow-hidden mb-5">
            <div className="h-24 flex items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${fmtInfo.color}28, ${fmtInfo.color}10)` }}>
              <span style={{ color: fmtInfo.color, fontFamily: "serif" }} className="text-5xl opacity-90 select-none">
                {fmtInfo.symbol}
              </span>
            </div>
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

          {loading && (
            <p className="text-center text-[#3c3850] text-xs mt-3">Your file will be saved shortly</p>
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
              onStart={() => go("instrument")}
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
              onFinish={sec => { setRecDuration(sec); go("confirm"); }}
            />
          )}
          {step === "confirm" && (
            <ConfirmScreen
              onBack={() => go("record")}
              onRetry={() => go("record")}
              onContinue={() => go("format")}
              duration={recDuration}
            />
          )}
          {step === "format" && (
            <FormatScreen
              onBack={() => go("confirm")}
              onSelect={f => { setFormat(f); go("generate"); }}
            />
          )}
          {step === "generate" && (
            <GenerateScreen format={format} onDone={() => go("review")} />
          )}
          {step === "review" && (
            <ReviewScreen
              onBack={() => go("format")}
              onEdit={() => go("edit")}
              onAccept={() => go("download")}
            />
          )}
          {step === "edit" && (
            <EditScreen
              onBack={() => go("review")}
              onContinue={() => go("download")}
              onDelete={() => go("dashboard")}
            />
          )}
          {step === "download" && (
            <DownloadScreen
              format={format}
              instrument={instrument}
              onDownload={name => { addProject(name); go("dashboard"); }}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
