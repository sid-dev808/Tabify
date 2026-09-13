/* ─── MINIMAL MIDI WRITER ───
   Server-side jobs hold temp files for an hour, but saved transcriptions live
   in Firestore forever. This rebuilds a standard MIDI file (format 0) straight
   from the stored note list so an old project can still be exported. */

const TICKS_PER_QUARTER = 480;
const BPM = 120;
const MICROS_PER_QUARTER = Math.round(60_000_000 / BPM); // 500000 at 120 BPM
const TICKS_PER_SECOND = TICKS_PER_QUARTER * (BPM / 60);

/** Variable-length quantity: 7 bits per byte, high bit set on all but the last. */
function vlq(value: number): number[] {
  const v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  let rest = Math.floor(v / 128);
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return bytes;
}

const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];

export interface MidiNote {
  start: number;   // seconds
  end: number;     // seconds
  midi: number;    // MIDI note number
}

export function notesToMidiBytes(notes: MidiNote[]): Uint8Array {
  interface Ev { tick: number; order: number; bytes: number[] }
  const events: Ev[] = [];

  for (const note of notes) {
    const pitch = Math.max(0, Math.min(127, Math.round(note.midi)));
    const onTick = Math.max(0, Math.round(note.start * TICKS_PER_SECOND));
    // Every note needs at least one tick of length or it won't sound at all.
    const offTick = Math.max(onTick + 1, Math.round(note.end * TICKS_PER_SECOND));
    events.push({ tick: onTick, order: 1, bytes: [0x90, pitch, 0x64] });
    events.push({ tick: offTick, order: 0, bytes: [0x80, pitch, 0x40] });
  }

  // Note-offs sort before note-ons at the same tick so a repeated pitch
  // retriggers cleanly instead of leaving a hanging voice.
  events.sort((a, b) => (a.tick - b.tick) || (a.order - b.order));

  const track: number[] = [
    // tempo meta event at tick 0
    ...vlq(0), 0xff, 0x51, 0x03,
    (MICROS_PER_QUARTER >> 16) & 0xff, (MICROS_PER_QUARTER >> 8) & 0xff, MICROS_PER_QUARTER & 0xff,
  ];

  let last = 0;
  for (const ev of events) {
    track.push(...vlq(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track

  const bytes = [
    ...ascii("MThd"), ...u32(6), ...u16(0), ...u16(1), ...u16(TICKS_PER_QUARTER),
    ...ascii("MTrk"), ...u32(track.length), ...track,
  ];

  return new Uint8Array(bytes);
}

export function notesToMidiBlob(notes: MidiNote[]): Blob {
  const bytes = notesToMidiBytes(notes);
  // Copy into a fresh buffer so the Blob never sees a SharedArrayBuffer view.
  return new Blob([bytes.slice().buffer], { type: "audio/midi" });
}
