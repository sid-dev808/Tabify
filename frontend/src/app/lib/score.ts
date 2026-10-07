/* ─── SCORE MODEL ───
   Takes the quantized events from rhythm.ts and places them on paper: which
   system, which measure, what x, what staff position. Pitch/staff maths and the
   instrument catalogue live here too. Everything is pure so the renderers, the
   editor and the saved-project viewer all agree on one representation. */

import {
  BEATS_PER_MEASURE, UNSURE_BELOW, addRests, cleanTechniques, estimateTempo, measureCountOf,
  quantizeNotes,
  type ApiNote, type Glyph, type ScoreEvent, type Technique, type Tempo,
} from "./rhythm";

export type { ApiNote, Glyph, ScoreEvent, Technique, Tempo } from "./rhythm";
export { BEATS_PER_MEASURE, TECHNIQUES, UNSURE_BELOW } from "./rhythm";

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

/** A crescendo or decrescendo hairpin. Anchored in seconds, like the notes, so it
    stays over the same music when the score is re-quantized or re-opened. */
export interface Hairpin {
  id: number;
  kind: "cresc" | "decresc";
  start: number;
  end: number;
}

export interface Score {
  events: LaidOutEvent[];
  tempo: Tempo;
  measures: number;
  systems: number;
  noteCount: number;
  hairpins: Hairpin[];
}

export const EMPTY_SCORE: Score = {
  events: [], tempo: { bpm: 120, offset: 0, confidence: 0 },
  measures: 1, systems: 1, noteCount: 0, hairpins: [],
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

function assemble(events: ScoreEvent[], tempo: Tempo, hairpins: Hairpin[] = []): Score {
  const measures = Math.max(measureCountOf(events),
    ...hairpins.map(h => timeToPosition(h.end, tempo).measure + 1));
  const withRests = addRests(events, measures);
  const laid = layout(withRests).sort((a, b) =>
    a.measure - b.measure || a.beat - b.beat || b.midi - a.midi);
  return {
    events: laid,
    tempo,
    measures,
    systems: Math.max(1, Math.ceil(measures / MEASURES_PER_SYSTEM)),
    noteCount: laid.filter(e => e.kind === "note").length,
    hairpins: [...hairpins].sort((a, b) => a.start - b.start),
  };
}

/** The full pipeline: raw backend notes to a placed, bar-lined score. */
export function buildScore(apiNotes: ApiNote[], hairpins: Hairpin[] = []): Score {
  if (apiNotes.length === 0) return EMPTY_SCORE;
  const tempo = estimateTempo(apiNotes.map(n => n.start));
  return assemble(quantizeNotes(apiNotes, tempo), tempo, hairpins);
}

/* ─── STORAGE ───
   Saved projects keep notes compactly: s/e/m (start, end, MIDI) as before, plus
   optional c (confidence), a (amplitude), t (technique letters) and hf (harmonic
   fret). Older saves without them still load. */
export interface StoredNote {
  s: number;
  e: number;
  m: number;
  c?: number;
  a?: number;
  t?: string;
  hf?: number;
}

export interface StoredHairpin { k: "<" | ">"; s: number; e: number }

const TECH_CODE: Record<Technique, string> = {
  harmonic: "N", hammer_on: "H", pull_off: "P", vibrato: "V", tremolo: "T",
};
const CODE_TECH = Object.fromEntries(Object.entries(TECH_CODE).map(([k, v]) => [v, k])) as Record<string, Technique>;

/** Rebuild from the compact form saved in Firestore. */
export function buildScoreFromStoredNotes(stored: StoredNote[], hairpins: StoredHairpin[] = []): Score {
  return buildScore(stored.map(n => ({
    start: n.s, end: n.e, pitch_midi: n.m, pitch: midiToPitchLabel(n.m),
    amplitude: n.a ?? 0.7,
    confidence: n.c ?? 1,
    techniques: [...(n.t ?? "")].map(ch => CODE_TECH[ch]).filter(Boolean),
    ...(n.hf ? { harmonic_fret: n.hf } : {}),
  })), fromStoredHairpins(hairpins));
}

/** Shrink back to the compact storage form — rests are derived, so they're dropped.
    Keys with no value are left out entirely: Firestore rejects `undefined`. */
export function toStoredNotes(events: LaidOutEvent[]): StoredNote[] {
  return events
    .filter(e => e.kind === "note")
    .map(e => {
      const out: StoredNote = { s: e.start, e: e.end, m: e.midi };
      if (e.confidence < 1) out.c = Number(e.confidence.toFixed(2));
      if (e.amplitude !== undefined) out.a = Number(e.amplitude.toFixed(2));
      const t = (e.techniques ?? []).map(x => TECH_CODE[x]).join("");
      if (t) out.t = t;
      if (e.harmonicFret) out.hf = e.harmonicFret;
      return out;
    });
}

export function toStoredHairpins(hairpins: Hairpin[]): StoredHairpin[] {
  return hairpins.map(h => ({
    k: h.kind === "cresc" ? "<" : ">",
    s: Number(h.start.toFixed(3)),
    e: Number(h.end.toFixed(3)),
  }));
}

export function fromStoredHairpins(stored: StoredHairpin[] | undefined): Hairpin[] {
  return (stored ?? []).map((h, i) => ({
    id: i + 1, kind: h.k === "<" ? "cresc" : "decresc", start: h.s, end: h.e,
  }));
}

/** Move one note by semitones and re-place it. An edited note counts as checked. */
export function transposeEvent(event: LaidOutEvent, semitones: number): LaidOutEvent {
  if (event.kind !== "note") return event;
  const midi = Math.max(21, Math.min(108, Math.round(event.midi) + semitones));
  const moved = { ...event, midi, pitch: midiToPitchLabel(midi), y: midiToStaffY(midi), confidence: 1 };
  if (moved.techniques.includes("harmonic")) moved.harmonicFret = naturalHarmonicFor(midi)?.fret;
  return moved;
}

/** Rebuild a score after the editor changed notes, so rests and bars stay right. */
export function rebuildAfterEdit(events: LaidOutEvent[], tempo: Tempo, hairpins: Hairpin[] = []): Score {
  const notes = events.filter(e => e.kind === "note")
    .map(({ sys: _s, x: _x, y: _y, ...rest }) => rest as ScoreEvent);
  return assemble(notes, tempo, hairpins);
}

export function isUnsure(event: ScoreEvent) {
  return event.kind === "note" && event.confidence < UNSURE_BELOW;
}

/* ─── TECHNIQUES ─── */
export const TECHNIQUE_INFO: Record<Technique, { label: string; short: string; key: string }> = {
  harmonic:  { label: "Harmonic",  short: "harm.", key: "N" },
  hammer_on: { label: "Hammer-on", short: "H",     key: "H" },
  pull_off:  { label: "Pull-off",  short: "P",     key: "P" },
  vibrato:   { label: "Vibrato",   short: "~",     key: "V" },
  tremolo:   { label: "Tremolo",   short: "trem.", key: "T" },
};

/** Natural harmonics: sounding interval above the open string → fret touched. */
const HARMONIC_NODES: [number, number][] = [[12, 12], [19, 7], [24, 5], [28, 4]];

/** Where a pitch can be played as a natural harmonic on a standard-tuned guitar,
    preferring the 12th fret, then 7th, 5th, 4th. */
export function naturalHarmonicFor(midi: number): { string: number; fret: number } | null {
  for (const [interval, fret] of HARMONIC_NODES) {
    const si = STANDARD_TUNING.findIndex(s => s.midi + interval === Math.round(midi));
    if (si >= 0) return { string: si, fret };
  }
  return null;
}

/** Turn a technique on or off for one note. A note is a hammer-on or a pull-off,
    never both; toggling either one counts as the user checking the note. */
export function toggleTechnique(event: LaidOutEvent, technique: Technique): LaidOutEvent {
  if (event.kind !== "note") return event;
  const has = event.techniques.includes(technique);
  let techniques = has
    ? event.techniques.filter(t => t !== technique)
    : [...event.techniques, technique];
  if (!has && technique === "hammer_on") techniques = techniques.filter(t => t !== "pull_off");
  if (!has && technique === "pull_off") techniques = techniques.filter(t => t !== "hammer_on");
  const next: LaidOutEvent = { ...event, techniques, confidence: 1 };
  if (technique === "harmonic") {
    if (has) delete next.harmonicFret;
    else {
      const spot = naturalHarmonicFor(event.midi);
      if (spot) next.harmonicFret = spot.fret; else delete next.harmonicFret;
    }
  }
  return next;
}

/** For a hammer-on or pull-off: the note it slurs from — the latest earlier note. */
export function legatoSource(events: LaidOutEvent[], event: LaidOutEvent): LaidOutEvent | null {
  let best: LaidOutEvent | null = null;
  for (const e of events) {
    if (e.kind !== "note" || e.id === event.id || e.start >= event.start - 0.01) continue;
    if (!best || e.start > best.start || (e.start === best.start && Math.abs(e.midi - event.midi) < Math.abs(best.midi - event.midi))) best = e;
  }
  return best;
}

/* ─── TIME ↔ PAGE ─── */
export function timeToPosition(t: number, tempo: Tempo) {
  const beats = Math.max(0, (t - tempo.offset) * (tempo.bpm / 60));
  const measure = Math.floor(beats / BEATS_PER_MEASURE);
  return { measure, beat: beats - measure * BEATS_PER_MEASURE };
}

/** x on the page for a position in seconds, plus which system it lands on. */
export function timeToX(t: number, tempo: Tempo) {
  const { measure, beat } = timeToPosition(t, tempo);
  const usable = MEASURE_W - MEASURE_PAD * 2;
  return {
    sys: Math.floor(measure / MEASURES_PER_SYSTEM),
    x: measureX(measure % MEASURES_PER_SYSTEM) + MEASURE_PAD + (Math.min(beat, BEATS_PER_MEASURE) / BEATS_PER_MEASURE) * usable,
  };
}

/** A hairpin drawn as one wedge per system it crosses. `from`/`to` are 0-1 of the
    full wedge's opening, so a hairpin broken across a line keeps growing. */
export function hairpinSegments(h: Hairpin, score: Score) {
  const a = timeToX(h.start, score.tempo);
  const b = timeToX(Math.max(h.end, h.start + 0.05), score.tempo);
  const segments: { sys: number; x0: number; x1: number; from: number; to: number }[] = [];
  const total = Math.max(1e-6, (b.sys - a.sys) * (CONTENT_X1 - CONTENT_X0) + (b.x - a.x));
  let done = 0;
  for (let sys = a.sys; sys <= b.sys; sys++) {
    const x0 = sys === a.sys ? a.x : CONTENT_X0;
    const x1 = sys === b.sys ? b.x : CONTENT_X1;
    const from = done / total;
    done += Math.max(0, x1 - x0);
    segments.push({ sys, x0, x1: Math.max(x1, x0 + 8), from, to: Math.min(1, done / total) });
  }
  return segments;
}

/* ─── DYNAMICS FOR PLAYBACK ───
   Hairpins move a running loudness level: a crescendo raises it across its span,
   a decrescendo lowers it, and the new level holds until the next hairpin. */
const BASE_LEVEL = 0.7;
export function dynamicLevelAt(t: number, hairpins: Hairpin[]) {
  let level = BASE_LEVEL;
  for (const h of [...hairpins].sort((a, b) => a.start - b.start)) {
    if (t < h.start) break;
    const target = h.kind === "cresc" ? Math.min(1, level + 0.3) : Math.max(0.3, level - 0.3);
    const span = Math.max(0.05, h.end - h.start);
    const frac = Math.min(1, (t - h.start) / span);
    level = level + (target - level) * frac;
  }
  return level;
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
    one so the tab doesn't leap around the neck. Notes struck together never share
    a string, and a hammer-on or pull-off stays on the string of the note it slurs
    from (moving that note if it has to) — the technique is impossible otherwise. */
export interface FretSpot { event: LaidOutEvent; string: number; fret: number; harmonic: boolean }

export function assignFrets(events: LaidOutEvent[]): FretSpot[] {
  const notes = events.filter(e => e.kind === "note");
  const out: FretSpot[] = [];
  const byId = new Map<number, FretSpot>();
  const usedAt = new Map<string, Set<number>>();      // strings taken per (measure, beat)
  let lastFret: number | null = null;

  const fits = (midi: number, si: number) => {
    const fret = midi - STANDARD_TUNING[si].midi;
    return fret >= 0 && fret <= MAX_FRET ? fret : null;
  };
  const claim = (spot: FretSpot) => {
    const key = `${spot.event.measure}:${spot.event.beat}`;
    if (!usedAt.has(key)) usedAt.set(key, new Set());
    usedAt.get(key)!.add(spot.string);
  };

  for (const event of notes) {
    const midi = Math.round(event.midi);
    const key = `${event.measure}:${event.beat}`;
    const taken = usedAt.get(key) ?? new Set<number>();

    // A natural harmonic is written at the fret touched, on the string that rings it.
    if (event.techniques?.includes("harmonic")) {
      const spot = naturalHarmonicFor(midi);
      if (spot) {
        const placed = { event, string: spot.string, fret: spot.fret, harmonic: true };
        out.push(placed); byId.set(event.id, placed); claim(placed);
        continue;
      }
    }

    if (event.techniques?.some(t => t === "hammer_on" || t === "pull_off")) {
      const source = legatoSource(notes, event);
      const from = source ? byId.get(source.id) : undefined;
      if (from && !from.harmonic) {
        const srcMidi = Math.round(from.event.midi);
        let si = fits(midi, from.string) !== null ? from.string : -1;
        if (si < 0) {
          // Move the whole slurred run (this note, its source, that note's source…)
          // to the string that holds all of them, nearest where the hand already is.
          const chain: FretSpot[] = [from];
          for (let cur = from; cur.event.techniques?.some(t => t === "hammer_on" || t === "pull_off");) {
            const prev = legatoSource(notes, cur.event);
            const spot = prev ? byId.get(prev.id) : undefined;
            if (!spot || spot.harmonic || chain.includes(spot) || spot.string !== cur.string) break;
            chain.push(spot);
            cur = spot;
          }
          const options = STANDARD_TUNING.map((_, i) => i).filter(i => !taken.has(i)
            && fits(midi, i) !== null && chain.every(c => fits(Math.round(c.event.midi), i) !== null));
          if (options.length) {
            si = options.reduce((a, b) =>
              Math.abs(fits(srcMidi, a)! - (lastFret ?? 5)) <= Math.abs(fits(srcMidi, b)! - (lastFret ?? 5)) ? a : b);
            for (const c of chain) { c.string = si; c.fret = fits(Math.round(c.event.midi), si)!; }
          }
        }
        if (si >= 0 && !taken.has(si)) {
          const placed = { event, string: si, fret: fits(midi, si)!, harmonic: false };
          out.push(placed); byId.set(event.id, placed); claim(placed);
          lastFret = placed.fret;
          continue;
        }
      }
    }

    const all = STANDARD_TUNING.map((s, si) => ({ si, fret: midi - s.midi }));
    let inRange = all.filter(c => c.fret >= 0 && c.fret <= MAX_FRET && !taken.has(c.si));
    if (inRange.length === 0) inRange = all.filter(c => c.fret >= 0 && c.fret <= MAX_FRET);

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
    const placed = { event, string: best.si, fret: best.fret, harmonic: false };
    out.push(placed); byId.set(event.id, placed); claim(placed);
  }
  return out;
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

/* ─── WHAT PLAYBACK AND MIDI EXPORT HEAR ─── */
export function playableNotes(score: Score) {
  return score.events.filter(e => e.kind === "note").map(e => ({
    id: e.id, midi: e.midi, start: e.start, end: e.end,
    techniques: e.techniques,
    level: dynamicLevelAt(e.start, score.hairpins),
  }));
}

/** Notes for a MIDI file: velocity follows how hard the note was played and any
    crescendo / decrescendo over it. */
export function midiNotesOf(score: Score) {
  return score.events.filter(e => e.kind === "note").map(e => {
    const touch = 0.55 + 0.45 * Math.max(0, Math.min(1, e.amplitude ?? 0.7));
    const level = dynamicLevelAt(e.start, score.hairpins) / 0.85;
    return { start: e.start, end: e.end, midi: e.midi, velocity: Math.round(Math.min(127, 127 * touch * level)) };
  });
}
