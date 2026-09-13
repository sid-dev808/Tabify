/* ─── SHARED SCORE MODEL ───
   Pitch/staff maths, layout of transcribed notes onto systems, and guitar
   fret assignment. Kept out of the screens so the notation renderers, the
   editor and the saved-project viewer all agree on one representation. */

export type Dur = "q" | "h" | "w";
export type Format = "sheet" | "tab" | "midi" | "wav";

/** A note positioned on the rendered score. */
export interface Note {
  sys: number;
  x: number;
  y: number;
  dur: Dur;
  pitch: string;
  midi: number;
  start: number;
  end: number;
  id: number;
}

/** A note exactly as the Flask backend returns it. */
export interface ApiNote {
  start: number;
  end: number;
  pitch_midi: number;
  pitch: string;
  amplitude: number;
}

/* ─── STAFF LAYOUT ─── */
export const NOTES_PER_SYSTEM = 12;
/* A transcription can run to hundreds of notes, so the staff grows with it:
   systems are laid out down the page and the SVG viewBox grows to match. */
export const FIRST_STAFF_Y = 78;
export const STAFF_SPACING = 122;
export const FIRST_TAB_Y = 90;
export const TAB_SPACING = 130;
export const BARS_PER_SYSTEM = 4;

export function staffTop(system: number) {
  return FIRST_STAFF_Y + system * STAFF_SPACING;
}

export function tabTop(system: number) {
  return FIRST_TAB_Y + system * TAB_SPACING;
}

export function systemCount(noteCount: number) {
  return Math.max(1, Math.ceil(noteCount / NOTES_PER_SYSTEM));
}
export const SYS_X_START = 102;
export const SYS_X_END = 640;

/* ─── PITCH ↔ STAFF POSITION ───
   Notation is transcribed from audio, so pitches span an arbitrary chromatic
   range. Accidentals are spelled with a sharp but share the line or space of
   their natural letter, the same as real engraving. */
const CHROMA = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const LETTER_STEP: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const E4_DIATONIC = 4 * 7 + LETTER_STEP.E;

export function midiToPitchLabel(midi: number) {
  const m = Math.round(midi);
  const idx = ((m % 12) + 12) % 12;
  return `${CHROMA[idx]}${Math.floor(m / 12) - 1}`;
}

export function midiToStaffY(midi: number) {
  const m = Math.round(midi);
  const idx = ((m % 12) + 12) % 12;
  const letter = CHROMA[idx][0];
  const octave = Math.floor(m / 12) - 1;
  const diatonic = octave * 7 + LETTER_STEP[letter];
  return Math.max(-36, Math.min(84, 48 - 6 * (diatonic - E4_DIATONIC)));
}

/** Move a note by semitones, keeping its label and staff position in sync. */
export function transposeNote(note: Note, semitones: number): Note {
  const midi = Math.max(21, Math.min(108, Math.round(note.midi) + semitones));
  return { ...note, midi, pitch: midiToPitchLabel(midi), y: midiToStaffY(midi) };
}

/* ─── TRANSCRIBED NOTES → SCORE LAYOUT ─── */
export function buildScoreFromApiNotes(apiNotes: ApiNote[]): Note[] {
  const sorted = [...apiNotes].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const durations = sorted.map(n => n.end - n.start).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)] || 0.5;

  return sorted.map((n, i) => {
    const sys = Math.floor(i / NOTES_PER_SYSTEM);
    const posInSystem = i % NOTES_PER_SYSTEM;
    const systemLen = Math.min(NOTES_PER_SYSTEM, sorted.length - sys * NOTES_PER_SYSTEM);
    const span = Math.max(1, systemLen - 1);
    const rel = n.end - n.start;
    return {
      sys,
      x: SYS_X_START + posInSystem * ((SYS_X_END - SYS_X_START) / span),
      y: midiToStaffY(n.pitch_midi),
      dur: (rel > median * 1.75 ? "w" : rel > median * 1.15 ? "h" : "q") as Dur,
      pitch: midiToPitchLabel(n.pitch_midi),
      midi: n.pitch_midi,
      start: n.start,
      end: n.end,
      id: i,
    };
  });
}

/** Rebuild a score from the compact {s,e,m} form saved in Firestore. */
export function buildScoreFromStoredNotes(stored: { s: number; e: number; m: number }[]) {
  return buildScoreFromApiNotes(
    stored.map(n => ({
      start: n.s,
      end: n.e,
      pitch_midi: n.m,
      pitch: midiToPitchLabel(n.m),
      amplitude: 1,
    }))
  );
}

/** Shrink a score back to the compact form for storage. */
export function toStoredNotes(notes: Note[]) {
  return notes.map(n => ({ s: n.start, e: n.end, m: n.midi }));
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

/** Pick a playable string/fret for each note, preferring positions near the
    previous note so the resulting tab doesn't jump around the neck. */
export function assignFrets(notes: Note[]) {
  let lastFret: number | null = null;
  return notes.map(note => {
    const midi = Math.round(note.midi);
    const inRange = STANDARD_TUNING
      .map((s, si) => ({ si, fret: midi - s.midi }))
      .filter(c => c.fret >= 0 && c.fret <= MAX_FRET);

    let best: { si: number; fret: number };
    if (inRange.length === 0) {
      // Outside the playable range on every string — clamp to the closest fret.
      best = STANDARD_TUNING
        .map((s, si) => ({ si, fret: Math.max(0, Math.min(MAX_FRET, midi - s.midi)) }))
        .reduce((a, b) =>
          Math.abs(midi - (STANDARD_TUNING[a.si].midi + a.fret)) <=
          Math.abs(midi - (STANDARD_TUNING[b.si].midi + b.fret)) ? a : b
        );
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

export const FORMATS: {
  id: Format; name: string; desc: string; ext: string; color: string; symbol: string;
}[] = [
  { id: "sheet", name: "Sheet Music", desc: "Standard notation, exported as vector", ext: ".svg", color: "#f0c040", symbol: "𝄞" },
  { id: "tab",   name: "Guitar TAB",  desc: "Tablature with fret positions",         ext: ".svg", color: "#30d8a0", symbol: "⑥" },
  { id: "midi",  name: "MIDI",        desc: "Digital instrument data file",          ext: ".mid", color: "#a78bfa", symbol: "♫" },
  { id: "wav",   name: "WAV Audio",   desc: "Your take rendered to lossless audio",  ext: ".wav", color: "#e8603c", symbol: "◉" },
];

export const CARD_PALETTE = [
  "#4a6fa5", "#7a5a9a", "#9a5a5a", "#4a9a6a", "#9a7a4a", "#4a7a9a", "#8a4a6a",
];

export const STATUS_MSGS = [
  "Uploading your take…",
  "Analyzing audio waveform…",
  "Identifying pitch and rhythm…",
  "Generating notation…",
];

/* ─── FORMATTING ─── */
export function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

export function fmtTime(s: number) {
  const total = Math.max(0, Math.round(s));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export function fmtDate(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

export function instrumentById(id: string) {
  return INSTRUMENTS.find(i => i.id === id);
}

export function formatById(id: string) {
  return FORMATS.find(f => f.id === id) ?? FORMATS[0];
}
