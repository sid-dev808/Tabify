/* ─── RHYTHM ───
   basic-pitch returns note onsets in raw seconds. Sheet music needs musical
   time: a tempo, a beat grid, note values and bar lines. This module does that
   conversion, and nothing else — it is pure functions over numbers so it can be
   tested without a browser. */

export interface ApiNote {
  start: number;
  end: number;
  pitch_midi: number;
  pitch: string;
  amplitude: number;
}

/** Note values we are willing to write, longest first, measured in quarter beats. */
export type Glyph = "w" | "h." | "h" | "q." | "q" | "e." | "e" | "s";

export const NOTE_VALUES: { beats: number; glyph: Glyph }[] = [
  { beats: 4,    glyph: "w"  },
  { beats: 3,    glyph: "h." },
  { beats: 2,    glyph: "h"  },
  { beats: 1.5,  glyph: "q." },
  { beats: 1,    glyph: "q"  },
  { beats: 0.75, glyph: "e." },
  { beats: 0.5,  glyph: "e"  },
  { beats: 0.25, glyph: "s"  },
];

export const BEATS_PER_MEASURE = 4;   // 4/4 throughout
export const GRID = 0.25;             // quantize to sixteenth notes
export const SLOTS_PER_MEASURE = BEATS_PER_MEASURE / GRID;

export interface Tempo {
  bpm: number;
  /** Seconds at which beat 0 falls. */
  offset: number;
  /** 0-1; how tightly the onsets landed on the grid. */
  confidence: number;
}

const DEFAULT_TEMPO: Tempo = { bpm: 120, offset: 0, confidence: 0 };

/** Onsets closer together than this are one musical event (a chord). */
const CHORD_WINDOW = 0.045;

export function distinctOnsets(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    if (out.length === 0 || t - out[out.length - 1] > CHORD_WINDOW) out.push(t);
  }
  return out;
}

/* How far each onset sits from its nearest grid line, as a fraction of one
   grid cell (0 = dead on, 0.5 = maximally off). Normalizing by the cell is what
   stops the search from always preferring a faster grid, which would fit
   anything. */
function gridError(onsets: number[], bpm: number, offset: number) {
  const cell = (60 / bpm) * GRID;
  let sum = 0;
  for (const t of onsets) {
    const pos = (t - offset) / cell;
    const d = Math.abs(pos - Math.round(pos));
    sum += d * d;
  }
  return sum / onsets.length;
}

/** Best phase for a given tempo: shift the grid to sit under the onsets. */
function refineOffset(onsets: number[], bpm: number, offset: number) {
  const cell = (60 / bpm) * GRID;
  let sum = 0;
  for (const t of onsets) {
    const pos = (t - offset) / cell;
    sum += (pos - Math.round(pos)) * cell;
  }
  return offset + sum / onsets.length;
}

/* Grid error alone is not enough to pick a tempo. A steady stream of onsets
   fits *every* tempo whose sixteenth cell divides the gap evenly — 0.4167s
   apart fits 72 BPM (eighths), 144 BPM (quarters) AND 108 BPM (dotted
   eighths). Two more terms decide between them:

   1. Metre. Real music puts notes on beats and half-beats far more often than
      on odd sixteenths. The 108 BPM reading above makes every single note
      syncopated, which is why it loses even though it fits perfectly.
   2. A gentle prior around 110 BPM, which settles the genuine octave
      ambiguity (72 vs 144 are the same music written two ways). */
const TEMPO_CENTER = 110;
const PRIOR_WEIGHT = 0.03;
const SYNCOPATION_WEIGHT = 0.02;

/** Average metrical awkwardness of where the onsets land: 0 = all on beats. */
function metricalPenalty(onsets: number[], bpm: number, offset: number) {
  const cell = (60 / bpm) * GRID;
  let sum = 0;
  for (const t of onsets) {
    const slot = ((Math.round((t - offset) / cell) % 4) + 4) % 4;
    sum += slot === 0 ? 0 : slot === 2 ? 0.25 : 1;
  }
  return sum / onsets.length;
}

function objective(onsets: number[], bpm: number, offset: number) {
  const prior = Math.log(bpm / TEMPO_CENTER);
  return gridError(onsets, bpm, offset)
    + PRIOR_WEIGHT * prior * prior
    + SYNCOPATION_WEIGHT * metricalPenalty(onsets, bpm, offset);
}

export function estimateTempo(noteStarts: number[]): Tempo {
  const onsets = distinctOnsets(noteStarts);
  if (onsets.length < 3) {
    return { ...DEFAULT_TEMPO, offset: onsets[0] ?? 0 };
  }

  let best = { bpm: DEFAULT_TEMPO.bpm, offset: onsets[0], score: Infinity };

  // Coarse sweep across every plausible tempo, then a fine pass around the winner.
  for (let bpm = 50; bpm <= 200; bpm += 0.5) {
    let offset = onsets[0];
    offset = refineOffset(onsets, bpm, offset);
    const score = objective(onsets, bpm, offset);
    if (score < best.score) best = { bpm, offset, score };
  }

  for (let bpm = best.bpm - 0.5; bpm <= best.bpm + 0.5; bpm += 0.05) {
    if (bpm < 40) continue;
    const offset = refineOffset(onsets, bpm, onsets[0]);
    const score = objective(onsets, bpm, offset);
    if (score < best.score) best = { bpm, offset, score };
  }

  // Report fit quality on the grid alone, without the tempo prior mixed in.
  // Damped by how many onsets backed the estimate: a search this free can fit
  // four stray notes perfectly, and that deserves no confidence at all.
  const err = gridError(onsets, best.bpm, best.offset);
  const fit = Math.max(0, Math.min(1, 1 - err / 0.08));
  const support = Math.min(1, Math.max(0, (onsets.length - 2) / 10));
  return {
    bpm: Math.round(best.bpm * 10) / 10,
    offset: best.offset,
    confidence: fit * support,
  };
}

/** Snap a duration in beats to the nearest writable note value. */
export function nearestNoteValue(beats: number) {
  let best = NOTE_VALUES[NOTE_VALUES.length - 1];
  let bestDiff = Infinity;
  for (const value of NOTE_VALUES) {
    const diff = Math.abs(Math.log(Math.max(beats, 1e-6) / value.beats));
    if (diff < bestDiff) { bestDiff = diff; best = value; }
  }
  return best;
}

export interface ScoreEvent {
  kind: "note" | "rest";
  id: number;
  measure: number;
  /** Offset within the measure, in quarter beats (0 - 4). */
  beat: number;
  beats: number;
  glyph: Glyph;
  midi: number;
  pitch: string;
  /** Original seconds, kept for playback and for re-saving. */
  start: number;
  end: number;
}

function snap(beats: number) {
  return Math.round(beats / GRID) * GRID;
}

/** Turn raw note events into quantized, measure-positioned score events. */
export function quantizeNotes(apiNotes: ApiNote[], tempo: Tempo): ScoreEvent[] {
  if (apiNotes.length === 0) return [];
  const beatsPerSecond = tempo.bpm / 60;
  const sorted = [...apiNotes].sort((a, b) => a.start - b.start || a.pitch_midi - b.pitch_midi);

  const events: ScoreEvent[] = [];
  let id = 0;

  for (const n of sorted) {
    const startBeats = Math.max(0, snap((n.start - tempo.offset) * beatsPerSecond));
    const rawDuration = Math.max(n.end - n.start, 1e-3) * beatsPerSecond;
    const value = nearestNoteValue(rawDuration);

    const measure = Math.floor(startBeats / BEATS_PER_MEASURE);
    const beat = startBeats - measure * BEATS_PER_MEASURE;

    events.push({
      kind: "note",
      id: id++,
      measure,
      beat,
      beats: value.beats,
      glyph: value.glyph,
      midi: Math.round(n.pitch_midi),
      pitch: n.pitch,
      start: n.start,
      end: n.end,
    });
  }

  return events;
}

/* ─── RESTS ───
   A measure holding one note on beat 1 should not look like a measure of
   silence with a stray notehead. Anywhere nothing sounds for an eighth note or
   longer, write the rest a copyist would. */
export function addRests(events: ScoreEvent[], measureCount: number): ScoreEvent[] {
  const rests: ScoreEvent[] = [];
  let id = 100000;

  for (let m = 0; m < measureCount; m++) {
    const slots = new Array<boolean>(SLOTS_PER_MEASURE).fill(false);
    for (const e of events) {
      if (e.measure !== m || e.kind !== "note") continue;
      const from = Math.round(e.beat / GRID);
      const to = Math.min(SLOTS_PER_MEASURE, from + Math.round(e.beats / GRID));
      for (let i = Math.max(0, from); i < to; i++) slots[i] = true;
    }

    let i = 0;
    while (i < SLOTS_PER_MEASURE) {
      if (slots[i]) { i++; continue; }
      let end = i;
      while (end < SLOTS_PER_MEASURE && !slots[end]) end++;
      let cursor = i;

      // Fill the silent run with the longest rests that fit and stay aligned.
      while (cursor < end) {
        const remaining = (end - cursor) * GRID;
        const value = NOTE_VALUES.find(v => {
          if (v.beats > remaining) return false;
          const beatPos = cursor * GRID;
          // A rest may not straddle a boundary coarser than its own value.
          return Math.abs((beatPos / v.beats) - Math.round(beatPos / v.beats)) < 1e-6;
        });
        if (!value) break;
        if (value.beats >= 0.5) {
          rests.push({
            kind: "rest", id: id++, measure: m, beat: cursor * GRID,
            beats: value.beats, glyph: value.glyph, midi: 0, pitch: "",
            start: 0, end: 0,
          });
        }
        cursor += Math.round(value.beats / GRID);
      }
      i = end;
    }
  }

  return [...events, ...rests];
}

export function measureCountOf(events: ScoreEvent[]) {
  return events.length === 0 ? 1 : Math.max(...events.map(e => e.measure)) + 1;
}
