import { useEffect, useMemo, useRef } from "react";
import {
  BARS_PER_SYSTEM, STANDARD_TUNING, assignFrets, staffTop, systemCount, tabTop,
  type Note,
} from "../lib/score";

/* ─── LIVE WAVEFORM ───
   Driven by a real AnalyserNode while recording; falls back to the idle
   animation when there is no live stream (e.g. the playback review card). */
export function WaveformCanvas({ active, analyser }: {
  active: boolean; analyser?: AnalyserNode | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number>(0);
  const bars = useRef<{ h: number; target: number }[]>([]);
  const freqData = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;

    const layoutRaf = requestAnimationFrame(() => {
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

export interface ScoreProps {
  revealed: number;
  notes: Note[];
  selected?: number | null;
  onNote?: (id: number) => void;
  editable?: boolean;
  title?: string;
}

const BAR_X = [258, 440, 614, 678];

/* ─── SHEET MUSIC ─── */
export function SheetSVG({
  revealed, notes, selected = null, onNote, editable, title = "Transcribed Score",
}: ScoreProps) {
  const staffLines = [0, 12, 24, 36, 48];
  const systems = systemCount(notes.length);
  const height = staffTop(systems - 1) + 92;

  return (
    <svg viewBox={`0 0 688 ${height}`} className="w-full" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="688" height={height} fill="#ffffff" />

      <text x="344" y="24" textAnchor="middle" fontFamily="Fraunces, serif" fontSize="14" fill="#1c1818" fontWeight="500" letterSpacing="0.01em">
        {title}
      </text>
      <text x="344" y="38" textAnchor="middle" fontFamily="Figtree, sans-serif" fontSize="8" fill="#aaa" letterSpacing="0.12em">
        FROM YOUR RECORDING  •  {notes.length} NOTES
      </text>

      {Array.from({ length: systems }, (_, si) => {
        const sY = staffTop(si);
        const isLast = si === systems - 1;
        return (
          <g key={si}>
            {staffLines.map(ly => (
              <line key={ly} x1="10" y1={sY + ly} x2="682" y2={sY + ly} stroke="#cac8c2" strokeWidth="0.75" />
            ))}
            <line x1="10" y1={sY} x2="10" y2={sY + 48} stroke="#999" strokeWidth="1" />
            {BAR_X.map((bx, bi) => (
              <line key={bi} x1={bx} y1={sY} x2={bx} y2={sY + 48} stroke="#999"
                strokeWidth={bi === BAR_X.length - 1 && isLast ? 2.8 : 0.9} />
            ))}
            {isLast && <line x1="672" y1={sY} x2="672" y2={sY + 48} stroke="#999" strokeWidth="0.9" />}
            <text x="13" y={sY + 56} fontSize="60" fill="#5a5a5a" fontFamily="Times New Roman, serif"
              style={{ userSelect: "none" }}>{"\u{1D11E}"}</text>
            <text x="60" y={sY + 18} fontSize="14" fill="#5a5a5a" fontFamily="Times New Roman, serif" fontWeight="bold">4</text>
            <text x="60" y={sY + 38} fontSize="14" fill="#5a5a5a" fontFamily="Times New Roman, serif" fontWeight="bold">4</text>
            <text x="78" y={sY - 5} fontSize="7.5" fill="#ccc" fontFamily="Figtree, sans-serif">
              {si * BARS_PER_SYSTEM + 1}
            </text>
          </g>
        );
      })}

      {notes.slice(0, revealed).map(note => {
        const sY = staffTop(note.sys);
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
            style={{ cursor: editable ? "pointer" : "default" }}>
            {sel && <circle cx={cx} cy={cy} r="12" fill="#f0c040" opacity="0.18" />}
            {/* Ledger lines for notes sitting above or below the staff */}
            {note.y < 0 && [-12, -24, -36].filter(ly => ly >= note.y - 3).map(ly => (
              <line key={ly} x1={cx - 10} y1={sY + ly} x2={cx + 10} y2={sY + ly} stroke="#b8b6b0" strokeWidth="0.75" />
            ))}
            {note.y > 48 && [60, 72, 84].filter(ly => ly <= note.y + 3).map(ly => (
              <line key={ly} x1={cx - 10} y1={sY + ly} x2={cx + 10} y2={sY + ly} stroke="#b8b6b0" strokeWidth="0.75" />
            ))}
            {isSharp && <text x={cx - 13} y={cy + 4} fontSize="11" fill={col} fontFamily="serif">♯</text>}
            <ellipse cx={cx} cy={cy} rx="6.2" ry="4.6"
              fill={open ? "none" : col} stroke={col} strokeWidth={open ? "1.7" : "0"}
              transform={`rotate(-18 ${cx} ${cy})`} />
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

/* ─── GUITAR TAB ─── */
export function TabSVG({
  revealed, notes, selected = null, onNote, editable, title = "Guitar Tablature",
}: ScoreProps) {
  const assigned = useMemo(() => assignFrets(notes), [notes]);
  const STRING_GAP = 10;
  const systems = systemCount(notes.length);
  const height = tabTop(systems - 1) + 72;

  return (
    <svg viewBox={`0 0 688 ${height}`} className="w-full" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="688" height={height} fill="#ffffff" />

      <text x="344" y="24" textAnchor="middle" fontFamily="Fraunces, serif" fontSize="14" fill="#1c1818" fontWeight="500" letterSpacing="0.01em">
        {title}
      </text>
      <text x="344" y="38" textAnchor="middle" fontFamily="Figtree, sans-serif" fontSize="8" fill="#aaa" letterSpacing="0.12em">
        STANDARD TUNING · E A D G B E
      </text>

      {Array.from({ length: systems }, (_, si) => {
        const topY = tabTop(si);
        const isLast = si === systems - 1;
        return (
          <g key={si}>
            {[0, 1, 2, 3, 4, 5].map(li => (
              <line key={li} x1="26" y1={topY + li * STRING_GAP} x2="682" y2={topY + li * STRING_GAP} stroke="#cac8c2" strokeWidth="0.75" />
            ))}
            <line x1="26" y1={topY} x2="26" y2={topY + STRING_GAP * 5} stroke="#999" strokeWidth="1" />
            {BAR_X.map((bx, bi) => (
              <line key={bi} x1={bx} y1={topY} x2={bx} y2={topY + STRING_GAP * 5} stroke="#999"
                strokeWidth={bi === BAR_X.length - 1 && isLast ? 2.8 : 0.9} />
            ))}
            {isLast && <line x1="672" y1={topY} x2="672" y2={topY + STRING_GAP * 5} stroke="#999" strokeWidth="0.9" />}
            {STANDARD_TUNING.map((s, li) => (
              <text key={li} x="14" y={topY + li * STRING_GAP + 2.6} fontSize="6.5" fill="#9a9690" fontFamily="Figtree, sans-serif">
                {s.name}
              </text>
            ))}
            <text x="78" y={topY - 5} fontSize="7.5" fill="#ccc" fontFamily="Figtree, sans-serif">
              {si * BARS_PER_SYSTEM + 1}
            </text>
          </g>
        );
      })}

      {assigned.slice(0, revealed).map(({ note, string, fret }) => {
        const topY = tabTop(note.sys);
        const cy = topY + string * STRING_GAP;
        const cx = note.x;
        const sel = selected === note.id;

        return (
          <g key={note.id}
            onClick={() => editable && onNote?.(note.id)}
            style={{ cursor: editable ? "pointer" : "default" }}>
            {sel && <circle cx={cx} cy={cy} r="9" fill="#f0c040" opacity="0.22" />}
            <rect x={cx - 7.5} y={cy - 6} width="15" height="12" fill="white" />
            <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize="9.5" fontFamily="Figtree, sans-serif"
              fontWeight="600" fill={sel ? "#f0c040" : "#2a2828"}>
              {fret}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Pick the renderer for a chosen output format. MIDI/WAV preview as sheet. */
export function rendererFor(format: string) {
  return format === "tab" ? TabSVG : SheetSVG;
}
