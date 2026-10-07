import { useEffect, useMemo, useRef } from "react";
import {
  BEATS_PER_MEASURE, CONTENT_X0, CONTENT_X1, MEASURES_PER_SYSTEM, MEASURE_W, STANDARD_TUNING,
  assignFrets, hairpinSegments, isSharp, isUnsure, legatoSource, measureX, staffTop, tabTop,
  type Glyph, type LaidOutEvent, type Score,
} from "../lib/score";

/* ─── LIVE WAVEFORM ───
   Driven by a real AnalyserNode while recording; falls back to the idle
   animation when there is no live stream. */
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
          ctx.fillStyle = active ? "#f0c040" : "#161420";
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, (H - bh) / 2, bw, bh, 1.5);
          else ctx.rect(x, (H - bh) / 2, bw, bh);
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

/* ─── SHARED ─── */
export interface ScoreProps {
  score: Score;
  /** How many events to show, for the reveal animation. Defaults to all. */
  revealed?: number;
  selected?: number | null;
  onNote?: (id: number) => void;
  editable?: boolean;
  title?: string;
  /** Event ids currently sounding during playback. */
  highlight?: number[];
  /** Fade notes the transcriber was unsure of (editor and review only, never exports). */
  showConfidence?: boolean;
  selectedHairpin?: number | null;
  onHairpin?: (id: number) => void;
}

const UNSURE_OPACITY = 0.42;

/** How wide a note's duration is on the page, for vibrato lines. */
function durationWidth(e: LaidOutEvent) {
  const usable = MEASURE_W - 22;
  return Math.max(14, (Math.min(e.beats, BEATS_PER_MEASURE) / BEATS_PER_MEASURE) * usable - 4);
}

/** A wavy vibrato line starting at x. */
function VibratoLine({ x, y, width, col }: { x: number; y: number; width: number; col: string }) {
  const end = Math.min(CONTENT_X1 - 2, x + width);
  let d = `M ${x} ${y}`;
  for (let px = x, up = true; px < end; px += 3, up = !up) d += ` q 1.5 ${up ? -2.6 : 2.6} 3 0`;
  return <path d={d} fill="none" stroke={col} strokeWidth="1.1" strokeLinecap="round" />;
}

/** Slur arc for a hammer-on or pull-off, with its H / P letter. */
function LegatoArc({ x0, y0, x1, y1, label, col, size = 7, below = false }: {
  x0: number; y0: number; x1: number; y1: number; label: string; col: string; size?: number;
  below?: boolean;
}) {
  const lift = Math.min(10, 4 + Math.abs(x1 - x0) * 0.1);
  const dir = below ? 1 : -1;
  const edge = below ? Math.max(y0, y1) : Math.min(y0, y1);
  const ctrl = edge + dir * lift * 1.6;
  return (
    <g>
      <path d={`M ${x0} ${y0} Q ${(x0 + x1) / 2} ${ctrl} ${x1} ${y1}`}
        fill="none" stroke={col} strokeWidth="1.1" />
      <text x={(x0 + x1) / 2} y={below ? edge + lift + size + 2 : edge - lift - 2} textAnchor="middle"
        fontSize={size} fontFamily="Figtree, sans-serif" fontWeight="700" fill={col}>{label}</text>
    </g>
  );
}

/** Crescendo / decrescendo wedges under each system. */
function Hairpins({ score, yOffset, maxOffset = yOffset, clampLow = false, topOf, selected, onHairpin, editable }: {
  score: Score; yOffset: number; maxOffset?: number; clampLow?: boolean; topOf: (sys: number) => number;
  selected?: number | null; onHairpin?: (id: number) => void; editable?: boolean;
}) {
  const H = 6;
  return (
    <>
      {score.hairpins.flatMap(h => hairpinSegments(h, score).map((seg, i) => {
        // Drop below any low notes (ledger lines) the wedge runs under.
        const under = score.events.filter(e => e.kind === "note" && e.sys === seg.sys
          && e.x >= seg.x0 - 8 && e.x <= seg.x1 + 8);
        const lowest = clampLow ? Math.max(0, ...under.map(e => e.y)) : 0;
        const y = topOf(seg.sys) + Math.min(maxOffset, Math.max(yOffset, lowest + 16));
        const open0 = (h.kind === "cresc" ? seg.from : 1 - seg.from) * H;
        const open1 = (h.kind === "cresc" ? seg.to : 1 - seg.to) * H;
        const col = h.id === selected ? ACCENT : "#555";
        return (
          <g key={`${h.id}-${i}`} onClick={() => editable && onHairpin?.(h.id)}
            style={{ cursor: editable ? "pointer" : "default" }}>
            <rect x={seg.x0 - 3} y={y - H - 4} width={seg.x1 - seg.x0 + 6} height={2 * H + 8} fill="transparent" />
            <line x1={seg.x0} y1={y - open0} x2={seg.x1} y2={y - open1} stroke={col} strokeWidth="1.2" />
            <line x1={seg.x0} y1={y + open0} x2={seg.x1} y2={y + open1} stroke={col} strokeWidth="1.2" />
          </g>
        );
      }))}
    </>
  );
}

const INK = "#2a2828";
const ACCENT = "#f0c040";
const PLAYING = "#3b82f6";
const STAFF_LINE = "#cac8c2";
const BAR_LINE = "#999";

const DOTTED: Record<string, boolean> = { "w": false, "h.": true, "h": false, "q.": true, "q": false, "e.": true, "e": false, "s": false };
const OPEN_HEAD: Record<string, boolean> = { "w": true, "h.": true, "h": true, "q.": false, "q": false, "e.": false, "e": false, "s": false };
const FLAGS: Record<string, number> = { "w": 0, "h.": 0, "h": 0, "q.": 0, "q": 0, "e.": 1, "e": 1, "s": 2 };
const HAS_STEM: Record<string, boolean> = { "w": false, "h.": true, "h": true, "q.": true, "q": true, "e.": true, "e": true, "s": true };

function ScoreHeader({ title, score }: { title: string; score: Score }) {
  const conf = score.tempo.confidence;
  return (
    <>
      <text x="344" y="24" textAnchor="middle" fontFamily="Fraunces, serif" fontSize="14"
        fill="#1c1818" fontWeight="500" letterSpacing="0.01em">{title}</text>
      <text x="344" y="38" textAnchor="middle" fontFamily="Figtree, sans-serif" fontSize="8"
        fill="#aaa" letterSpacing="0.12em">
        {`4/4  •  ♩ = ${Math.round(score.tempo.bpm)}${conf < 0.45 ? " (approx)" : ""}  •  ${score.noteCount} NOTES`}
      </text>
    </>
  );
}

/** Bar lines, clef, time signature and measure numbers for one system.
    `measures` is how many bars this system actually holds, so a final system
    that is only half full stops where the music does instead of trailing
    empty bars across the page. */
function StaffSystem({ si, systems, measures, top, height, clef }: {
  si: number; systems: number; measures: number; top: number; height: number; clef: boolean;
}) {
  const isLast = si === systems - 1;
  const lines = clef ? [0, 12, 24, 36, 48] : [0, 10, 20, 30, 40, 50];
  const rightEdge = measureX(measures);
  return (
    <g>
      {lines.map(ly => (
        <line key={ly} x1={clef ? 10 : 26} y1={top + ly} x2={rightEdge} y2={top + ly}
          stroke={STAFF_LINE} strokeWidth="0.75" />
      ))}
      <line x1={clef ? 10 : 26} y1={top} x2={clef ? 10 : 26} y2={top + height} stroke={BAR_LINE} strokeWidth="1" />

      {/* One bar line per measure boundary — these now sit where the beats say. */}
      {Array.from({ length: measures }, (_, i) => {
        const x = measureX(i + 1);
        const last = isLast && i === measures - 1;
        return (
          <g key={i}>
            <line x1={x} y1={top} x2={x} y2={top + height} stroke={BAR_LINE} strokeWidth={last ? 2.6 : 0.9} />
            {last && <line x1={x - 4} y1={top} x2={x - 4} y2={top + height} stroke={BAR_LINE} strokeWidth="0.9" />}
          </g>
        );
      })}

      {clef && (
        <>
          <text x="13" y={top + 56} fontSize="60" fill="#5a5a5a" fontFamily="Times New Roman, serif"
            style={{ userSelect: "none" }}>{"\u{1D11E}"}</text>
          <text x="62" y={top + 18} fontSize="14" fill="#5a5a5a" fontFamily="Times New Roman, serif" fontWeight="bold">4</text>
          <text x="62" y={top + 38} fontSize="14" fill="#5a5a5a" fontFamily="Times New Roman, serif" fontWeight="bold">4</text>
        </>
      )}
      {!clef && STANDARD_TUNING.map((s, li) => (
        <text key={li} x="14" y={top + li * 10 + 2.6} fontSize="6.5" fill="#9a9690" fontFamily="Figtree, sans-serif">
          {s.name}
        </text>
      ))}

      {/* Measure numbers */}
      {Array.from({ length: measures }, (_, i) => (
        <text key={i} x={measureX(i) + 3} y={top - 5} fontSize="7" fill="#ccc" fontFamily="Figtree, sans-serif">
          {si * MEASURES_PER_SYSTEM + i + 1}
        </text>
      ))}
    </g>
  );
}

/** Ledger lines above or below the staff for a notehead at offset y. */
function Ledgers({ y, cx, top }: { y: number; cx: number; top: number }) {
  const lines: number[] = [];
  for (let ly = -12; ly >= y - 3; ly -= 12) lines.push(ly);
  for (let ly = 60; ly <= y + 3; ly += 12) lines.push(ly);
  return (
    <>
      {lines.map(ly => (
        <line key={ly} x1={cx - 9} y1={top + ly} x2={cx + 9} y2={top + ly} stroke="#b8b6b0" strokeWidth="0.75" />
      ))}
    </>
  );
}

function Rest({ glyph, x, top, col }: { glyph: Glyph; x: number; top: number; col: string }) {
  const dot = DOTTED[glyph] && <circle cx={x + 8} cy={top + 21} r="1.3" fill={col} />;
  if (glyph === "w") {
    return <>
      <rect x={x - 5} y={top + 12} width="10" height="4.5" fill={col} />{dot}
    </>;
  }
  if (glyph === "h" || glyph === "h.") {
    return <>
      <rect x={x - 5} y={top + 19.5} width="10" height="4.5" fill={col} />{dot}
    </>;
  }
  if (glyph === "q" || glyph === "q.") {
    return <>
      <path d={`M ${x - 3} ${top + 9} L ${x + 3} ${top + 18} L ${x - 2.5} ${top + 25} L ${x + 3.5} ${top + 34}`}
        fill="none" stroke={col} strokeWidth="2.1" strokeLinejoin="round" strokeLinecap="round" />
      <path d={`M ${x + 3.5} ${top + 34} q -4 -2 -1.5 -5`}
        fill="none" stroke={col} strokeWidth="1.6" strokeLinecap="round" />
      {dot}
    </>;
  }
  // eighth (and the rare sixteenth)
  return <>
    <circle cx={x - 1.8} cy={top + 16} r="2.1" fill={col} />
    <path d={`M ${x - 0.2} ${top + 15} L ${x + 3} ${top + 27}`} stroke={col} strokeWidth="1.5" strokeLinecap="round" />
    {glyph === "s" && <circle cx={x - 0.4} cy={top + 22} r="2.1" fill={col} />}
    {dot}
  </>;
}

/* ─── SHEET MUSIC ─── */
export function SheetSVG({
  score, revealed, selected = null, onNote, editable, title = "Transcribed Score", highlight,
  showConfidence, selectedHairpin = null, onHairpin,
}: ScoreProps) {
  const shown = revealed ?? score.events.length;
  const height = staffTop(score.systems - 1) + 112;
  const playing = useMemo(() => new Set(highlight ?? []), [highlight]);

  /* Notes sharing a measure and beat are one chord: they get stacked
     noteheads and a single shared stem, the way they would be engraved. */
  const clusters = useMemo(() => {
    const map = new Map<string, LaidOutEvent[]>();
    score.events.slice(0, shown).forEach(e => {
      if (e.kind !== "note") return;
      const key = `${e.measure}:${e.beat}`;
      const list = map.get(key);
      if (list) list.push(e); else map.set(key, [e]);
    });
    return [...map.values()];
  }, [score.events, shown]);

  return (
    <svg viewBox={`0 0 688 ${height}`} className="w-full" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="688" height={height} fill="#ffffff" />
      <ScoreHeader title={title} score={score} />

      {Array.from({ length: score.systems }, (_, si) => (
        <StaffSystem key={si} si={si} systems={score.systems} top={staffTop(si)} height={48} clef
          measures={Math.min(MEASURES_PER_SYSTEM, score.measures - si * MEASURES_PER_SYSTEM)} />
      ))}

      {/* Rests */}
      {score.events.slice(0, shown).filter(e => e.kind === "rest").map(e => (
        <Rest key={e.id} glyph={e.glyph} x={e.x} top={staffTop(e.sys)} col="#6a6a6a" />
      ))}

      {/* Notes */}
      {clusters.map(group => {
        const top = staffTop(group[0].sys);
        const cx = group[0].x;
        const glyph = group[0].glyph;
        const ys = group.map(n => n.y);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const stemUp = (minY + maxY) / 2 >= 24;
        const isSel = group.some(n => n.id === selected);
        const isPlaying = group.some(n => playing.has(n.id));
        const col = isSel ? ACCENT : isPlaying ? PLAYING : INK;

        const stemX = stemUp ? cx + 5.8 : cx - 5.8;
        const stemFrom = top + (stemUp ? maxY - 1 : minY + 1);
        const stemTo = top + (stemUp ? minY - 31 : maxY + 31);
        const flags = FLAGS[glyph];
        const faded = showConfidence && group.every(n => isUnsure(n));
        const tremolo = group.some(n => n.techniques?.includes("tremolo"));
        const vibrato = group.find(n => n.techniques?.includes("vibrato"));
        const markY = Math.min(top - 11, top + minY - 13, stemUp ? stemTo - 6 : top - 11);

        return (
          <g key={`${group[0].measure}:${group[0].beat}`}
            onClick={() => editable && onNote?.(group[0].id)}
            opacity={faded ? UNSURE_OPACITY : 1}
            style={{ cursor: editable ? "pointer" : "default" }}>

            {vibrato && <VibratoLine x={cx - 4} y={markY} width={durationWidth(vibrato)} col={col} />}
            {tremolo && (() => {
              // Three slashes through the stem (above the head on a stemless note).
              const midY = HAS_STEM[glyph] ? (stemFrom + stemTo) / 2 : top + minY - 12;
              const sx = HAS_STEM[glyph] ? stemX : cx;
              return [0, 1, 2].map(i => (
                <line key={i} x1={sx - 4} y1={midY + 3 + (i - 1) * 4} x2={sx + 4} y2={midY - 1 + (i - 1) * 4}
                  stroke={col} strokeWidth="1.6" />
              ));
            })()}

            {HAS_STEM[glyph] && (
              <line x1={stemX} y1={stemFrom} x2={stemX} y2={stemTo} stroke={col} strokeWidth="1.5" />
            )}
            {Array.from({ length: flags }, (_, fi) => {
              const fy = stemTo + (stemUp ? fi * 6.5 : -fi * 6.5);
              return (
                <path key={fi}
                  d={stemUp
                    ? `M ${stemX} ${fy} q 7 4 4.5 12`
                    : `M ${stemX} ${fy} q 7 -4 4.5 -12`}
                  fill="none" stroke={col} strokeWidth="1.7" strokeLinecap="round" />
              );
            })}

            {group.map(note => {
              const cy = top + note.y;
              const harmonic = note.techniques?.includes("harmonic");
              const legato = note.techniques?.find(t => t === "hammer_on" || t === "pull_off");
              const source = legato ? legatoSource(score.events.slice(0, shown), note) : null;
              return (
                <g key={note.id} opacity={showConfidence && !faded && isUnsure(note) ? UNSURE_OPACITY : 1}>
                  {legato && (() => {
                    // The slur sits on the notehead side, away from the stems.
                    const label = legato === "hammer_on" ? "H" : "P";
                    const off = stemUp ? 6 : -6;
                    if (source && source.sys === note.sys && source.x < cx) {
                      return <LegatoArc x0={source.x + 1} y0={top + source.y + off} x1={cx - 1} y1={cy + off}
                        label={label} col={col} size={8} below={stemUp} />;
                    }
                    return <LegatoArc x0={cx - 20} y0={cy + off} x1={cx - 1} y1={cy + off} label={label}
                      col={col} size={8} below={stemUp} />;
                  })()}
                  {(note.id === selected || playing.has(note.id)) && (
                    <circle cx={cx} cy={cy} r="11" fill={col} opacity="0.18" />
                  )}
                  <Ledgers y={note.y} cx={cx} top={top} />
                  {isSharp(note.midi) && (
                    <text x={cx - 13} y={cy + 4} fontSize="11" fill={col} fontFamily="serif">♯</text>
                  )}
                  {harmonic ? (
                    // Natural harmonic: a diamond notehead.
                    <path d={`M ${cx - 6} ${cy} L ${cx} ${cy - 5} L ${cx + 6} ${cy} L ${cx} ${cy + 5} Z`}
                      fill="white" stroke={col} strokeWidth="1.5" />
                  ) : (
                    <ellipse cx={cx} cy={cy} rx="6.2" ry="4.6"
                      fill={OPEN_HEAD[glyph] ? "none" : col} stroke={col}
                      strokeWidth={OPEN_HEAD[glyph] ? "1.7" : "0"}
                      transform={`rotate(-18 ${cx} ${cy})`} />
                  )}
                  {DOTTED[glyph] && (
                    <circle cx={cx + 11} cy={note.y % 12 === 0 ? cy - 3 : cy} r="1.4" fill={col} />
                  )}
                </g>
              );
            })}
          </g>
        );
      })}

      <Hairpins score={score} yOffset={68} maxOffset={104} clampLow topOf={staffTop} selected={selectedHairpin}
        onHairpin={onHairpin} editable={editable} />
    </svg>
  );
}

/* ─── GUITAR TAB ─── */
export function TabSVG({
  score, revealed, selected = null, onNote, editable, title = "Guitar Tablature", highlight,
  showConfidence, selectedHairpin = null, onHairpin,
}: ScoreProps) {
  const shown = revealed ?? score.events.length;
  const height = tabTop(score.systems - 1) + 76;
  const playing = useMemo(() => new Set(highlight ?? []), [highlight]);
  const assigned = useMemo(
    () => assignFrets(score.events.slice(0, shown)),
    [score.events, shown]
  );

  return (
    <svg viewBox={`0 0 688 ${height}`} className="w-full" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="688" height={height} fill="#ffffff" />
      <ScoreHeader title={title} score={score} />
      <text x="344" y="50" textAnchor="middle" fontFamily="Figtree, sans-serif" fontSize="7.5"
        fill="#bbb" letterSpacing="0.1em">STANDARD TUNING · E A D G B E</text>

      {Array.from({ length: score.systems }, (_, si) => (
        <StaffSystem key={si} si={si} systems={score.systems} top={tabTop(si)} height={50} clef={false}
          measures={Math.min(MEASURES_PER_SYSTEM, score.measures - si * MEASURES_PER_SYSTEM)} />
      ))}

      {assigned.map(({ event, string, fret, harmonic }) => {
        const top = tabTop(event.sys);
        const cy = top + string * 10;
        const isSel = event.id === selected;
        const isPlaying = playing.has(event.id);
        const col = isSel ? ACCENT : isPlaying ? PLAYING : INK;
        const label = harmonic ? `<${fret}>` : String(fret);
        const w = 6 + label.length * 5.5;
        const legato = event.techniques?.find(t => t === "hammer_on" || t === "pull_off");
        const source = legato ? legatoSource(score.events.slice(0, shown), event) : null;
        const sourceSpot = source ? assigned.find(a => a.event.id === source.id) : undefined;

        return (
          <g key={event.id}
            onClick={() => editable && onNote?.(event.id)}
            opacity={showConfidence && isUnsure(event) ? UNSURE_OPACITY : 1}
            style={{ cursor: editable ? "pointer" : "default" }}>
            {(isSel || isPlaying) && <circle cx={event.x} cy={cy} r="9" fill={col} opacity="0.22" />}
            {legato && (() => {
              const letter = legato === "hammer_on" ? "h" : "p";
              if (sourceSpot && source && source.sys === event.sys && source.x < event.x) {
                const sy = top + sourceSpot.string * 10;
                return <LegatoArc x0={source.x + 3} y0={sy - 6} x1={event.x - 3} y1={cy - 6} label={letter} col={col} size={7.5} />;
              }
              return <LegatoArc x0={event.x - 18} y0={cy - 6} x1={event.x - 3} y1={cy - 6} label={letter} col={col} size={7.5} />;
            })()}
            {event.techniques?.includes("vibrato") && (
              <VibratoLine x={event.x - 4} y={top - 9} width={durationWidth(event)} col={col} />
            )}
            {event.techniques?.includes("tremolo") && [0, 1, 2].map(i => (
              <line key={i} x1={event.x - 4 + i * 3} y1={top + 59} x2={event.x - 1 + i * 3} y2={top + 53}
                stroke={col} strokeWidth="1.3" />
            ))}
            <rect x={event.x - w / 2} y={cy - 6} width={w} height="12" fill="white" />
            <text x={event.x} y={cy + 3.5} textAnchor="middle" fontSize="9.5"
              fontFamily="Figtree, sans-serif" fontWeight="600" fill={col}>{label}</text>
          </g>
        );
      })}

      <Hairpins score={score} yOffset={67} topOf={tabTop} selected={selectedHairpin}
        onHairpin={onHairpin} editable={editable} />
    </svg>
  );
}

/** Pick the renderer for a chosen output format. MIDI/WAV preview as sheet. */
export function rendererFor(format: string) {
  return format === "tab" ? TabSVG : SheetSVG;
}

export { CONTENT_X0, CONTENT_X1, MEASURE_W };
