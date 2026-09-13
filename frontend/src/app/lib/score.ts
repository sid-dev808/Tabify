/* ─── SCORE MODEL ───
   Takes the quantized events from rhythm.ts and places them on paper: which
   system, which measure, what x, what staff position. Pitch/staff maths and the
   instrument catalogue live here too. Everything is pure so the renderers, the
   editor and the saved-project viewer all agree on one representation. */

import {
  BEATS_PER_MEASURE, addRests, estimateTempo, measureCountOf, quantizeNotes,
  type ApiNote, type Glyph, type ScoreEvent, type Tempo,
} from "./rhythm";

export type { ApiNote, Glyph, ScoreEvent, Tempo } from "./rhythm";
export { BEATS_PER_MEASURE } from "./rhythm";

/* ─── PAGE GEOMETRY ─── */
export const MEASURES_PER_SYSTEM = 4;
export const CONTENT_X0 = 102;          // right of the clef and time signature
export const CONTENT_X1 = 678;
export const MEASURE_W = (CONTENT_X1 - CONTENT_X0) / MEASURES_PER_SYSTEM;
const MEASURE_PAD = 11;                 // keeps beat 1 off the bar line

export const FIRST_STAFF_Y = 78;
export const STAFF_SPACING = 122;
export const FIRST_TAB_Y = 90;
export const TAB_SPACING = 130;

export function staffTop(system: number) { return FIRST_STAFF_Y + system * STAFF_SPACING; }
export function tabTop(system: number)   { return FIRST_TAB_Y + system * TAB_SPACING; }
export function measureX(measureInSystem: number) { return CONTENT_X0 + measureInSystem * MEASURE_W; }

/* ─── PITCH ↔ STAFF POSITION ───
   Transcriptions span an arbitrary chromatic range. Accidentals are spelled
   with a sharp but share the line or space of their natural letter, the same
   as real engraving. */
const CHROMA = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const LETTER_STEP: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const E4_DIATONIC = 4 * 7 + LETTER_STEP.E;

export function midiToPitchLabel(midi: number) {
  const m = Math.round(midi);
  return `${CHROMA[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

export function midiToStaffY(midi: number) {
  const m = Math.round(midi);
  const letter = CHROMA[((m % 12) + 12) % 12][0];
  const diatonic = (Math.floor(m / 12) - 1) * 7 + LETTER_STEP[letter];
  return Math.max(-42, Math.min(90, 48 - 6 * (diatonic - E4_DIATONIC)));
}

export function isSharp(midi: number) {
  return CHROMA[((Math.round(midi) % 12) + 12) % 12].includes("#");
}

/* ─── LAID-OUT EVENTS ─── */
export interface LaidOutEvent extends ScoreEvent {
  sys: number;
  x: number;
  y: number;
}

export interface Score {
  events: LaidOutEvent[];
  tempo: Tempo;
  measures: number;
  systems: number;
  noteCount: number;
}

export const EMPTY_SCORE: Score = {
  events: [], tempo: { bpm: 120, offset: 0, confidence: 0 },
  measures: 1, systems: 1, noteCount: 0,
};

function place(event: ScoreEvent): LaidOutEvent {
  const sys = Math.floor(event.measure / MEASURES_PER_SYSTEM);
  const inSystem = event.measure % MEASURES_PER_SYSTEM;
  const usable = MEASURE_W - MEASURE_PAD * 2;

  // A rest covering the whole bar is centred in it, the way it is engraved,
  // rather than sitting on beat one like an ordinary event.
  const wholeBarRest = event.kind === "rest" && event.beats >= BEATS_PER_MEASURE;
  const x = wholeBarRest
    ? measureX(inSystem) + MEASURE_W / 2
    : measureX(inSystem) + MEASURE_PAD + (event.beat / BEATS_PER_MEASURE) * usable;

  return {
    ...event,
    sys,
    x,
    // Rests hang around the middle of the staff; notes use their real pitch.
    y: event.kind === "note" ? midiToStaffY(event.midi) : 18,
  };
}

/** Re-place events after an edit changed a pitch. */
export function layout(events: ScoreEvent[]): LaidOutEvent[] {
  return events.map(place);
}

function assemble(events: ScoreEvent[], tempo: Tempo): Score {
  const measures = measureCountOf(events);
  const withRests = addRests(events, measures);
  const laid = layout(withRests).sort((a, b) =>
    a.measure - b.measure || a.beat - b.beat || b.midi - a.midi);
  return {
    events: laid,
    tempo,
    measures,
    systems: Math.max(1, Math.ceil(measures / MEASURES_PER_SYSTEM)),
    noteCount: laid.filter(e => e.kind === "note").length,
  };
}

/** The full pipeline: raw backend notes to a placed, bar-lined score. */
export function buildScore(apiNotes: ApiNote[]): Score {
  if (apiNotes.length === 0) return EMPTY_SCORE;
  const tempo = estimateTempo(apiNotes.map(n => n.start));
  return assemble(quantizeNotes(apiNotes, tempo), tempo);
}

/** Rebuild from the compact {s,e,m} form saved in Firestore. */
export function buildScoreFromStoredNotes(stored: { s: number; e: number; m: number }[]): Score {
  return buildScore(stored.map(n => ({
    start: n.s, end: n.e, pitch_midi: n.m, pitch: midiToPitchLabel(n.m), amplitude: 1,
  })));
}

/** Shrink back to the compact storage form — rests are derived, so they're dropped. */
export function toStoredNotes(events: LaidOutEvent[]) {
  return events
    .filter(e => e.kind === "note")
    .map(e => ({ s: e.start, e: e.end, m: e.midi }));
}

/** Move one note by semitones and re-place it. */
export function transposeEvent(event: LaidOutEvent, semitones: number): LaidOutEvent {
  if (event.kind !== "note") return event;
  const midi = Math.max(21, Math.min(108, Math.round(event.midi) + semitones));
  return { ...event, midi, pitch: midiToPitchLabel(midi), y: midiToStaffY(midi) };
}

/** Rebuild a score after the editor changed notes, so rests and bars stay right. */
export function rebuildAfterEdit(events: LaidOutEvent[], tempo: Tempo): Score {
  const notes = events.filter(e => e.kind === "note")
    .map(({ sys: _s, x: _x, y: _y, ...rest }) => rest as ScoreEvent);
  return assemble(notes, tempo);
}

/* ─── GUITAR TAB: STRING/FRET ASSIGNMENT ─── */
export const STANDARD_TUNING = [
  { name: "e", midi: 64 }, // string 1 (high E)
  { name: "B", midi: 59 },
  { name: "G", midi: 55 },
  { name: "D", midi: 50 },
  { name: "A", midi: 45 },
  { name: "E", midi: 40 }, // string 6 (low E)
];
const MAX_FRET = 15;

/** Pick a playable string/fret per note, preferring positions near the previous
    one so the tab doesn't leap around the neck. */
export function assignFrets(events: LaidOutEvent[]) {
  let lastFret: number | null = null;
  return events.filter(e => e.kind === "note").map(event => {
    const midi = Math.round(event.midi);
    const inRange = STANDARD_TUNING
      .map((s, si) => ({ si, fret: midi - s.midi }))
      .filter(c => c.fret >= 0 && c.fret <= MAX_FRET);

    let best: { si: number; fret: number };
    if (inRange.length === 0) {
      best = STANDARD_TUNING
        .map((s, si) => ({ si, fret: Math.max(0, Math.min(MAX_FRET, midi - s.midi)) }))
        .reduce((a, b) =>
          Math.abs(midi - (STANDARD_TUNING[a.si].midi + a.fret)) <=
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
    return { event, string: best.si, fret: best.fret };
  });
}

/* ─── CATALOGUE ─── */
export const INSTRUMENTS = [
  { id: "guitar",  name: "Guitar",      emoji: "🎸", desc: "Acoustic & Electric" },
  { id: "piano",   name: "Piano",       emoji: "🎹", desc: "Grand & Upright"     },
  { id: "violin",  name: "Violin",      emoji: "🎻", desc: "Classical & Folk"    },
  { id: "bass",    name: "Bass Guitar", emoji: "🎸", desc: "Electric Bass"       },
  { id: "sax",     name: "Saxophone",   emoji: "🎷", desc: "Alto & Tenor"        },
  { id: "drums",   name: "Drums",       emoji: "🥁", desc: "Kit & Percussion"    },
  { id: "voice",   name: "Voice",       emoji: "🎤", desc: "Vocal & Choir"       },
  { id: "ukulele", name: "Ukulele",     emoji: "🪕", desc: "Soprano & Concert"   },
];

export type Format = "sheet" | "tab" | "midi" | "wav";

export const FORMATS: {
  id: Format; name: string; desc: string; ext: string; color: string; symbol: string;
}[] = [
  { id: "sheet", name: "Sheet Music", desc: "Standard notation — PDF, PNG or SVG", ext: "PDF", color: "#f0c040", symbol: "𝄞" },
  { id: "tab",   name: "Guitar TAB",  desc: "Tablature with fret positions",       ext: "PDF", color: "#30d8a0", symbol: "⑥" },
  { id: "midi",  name: "MIDI",        desc: "Digital instrument data file",        ext: ".mid", color: "#a78bfa", symbol: "♫" },
  { id: "wav",   name: "WAV Audio",   desc: "Your take rendered to lossless audio", ext: ".wav", color: "#e8603c", symbol: "◉" },
];

export const CARD_PALETTE = [
  "#4a6fa5", "#7a5a9a", "#9a5a5a", "#4a9a6a", "#9a7a4a", "#4a7a9a", "#8a4a6a",
];

export const STATUS_MSGS = [
  "Uploading your take…",
  "Analyzing audio waveform…",
  "Identifying pitch and rhythm…",
  "Laying out the notation…",
];

/* ─── FORMATTING ─── */
export function pad2(n: number) { return n.toString().padStart(2, "0"); }

export function fmtTime(s: number) {
  const total = Math.max(0, Math.round(s));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export function fmtDate(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function instrumentById(id: string) { return INSTRUMENTS.find(i => i.id === id); }
export function formatById(id: string) { return FORMATS.find(f => f.id === id) ?? FORMATS[0]; }
