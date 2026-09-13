/* ─── PLAYBACK ───
   Plays the transcription back through Web Audio. The point is verification:
   a tester who hears the transcription next to what they played can tell in
   two seconds whether it got the notes right — far faster than reading the
   notation. Reports which events are sounding so the score can highlight them. */

export interface PlayableNote {
  id: number;
  midi: number;
  start: number;
  end: number;
}

/** Beyond this, scheduling every note at once starts to cost more than it's worth. */
const MAX_VOICES = 800;

export function midiToFrequency(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class ScorePlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private raf = 0;
  private startedAt = 0;
  private notes: PlayableNote[] = [];
  private duration = 0;
  private playing = false;

  get isPlaying() { return this.playing; }

  /**
   * @param onTick   called each frame with the ids sounding right now
   * @param onEnd    called once playback runs off the end (not on stop())
   */
  async play(
    notes: PlayableNote[],
    onTick: (activeIds: number[], elapsed: number) => void,
    onEnd: () => void
  ) {
    this.stop();
    if (notes.length === 0) return;

    const ctx = this.ctx ?? new AudioContext();
    this.ctx = ctx;
    // Browsers start the context suspended until a user gesture.
    if (ctx.state === "suspended") await ctx.resume();

    const master = ctx.createGain();
    // Keep the mix from clipping when a dense chord lands.
    master.gain.value = 0.8 / Math.max(1, Math.sqrt(Math.min(notes.length, 8)));
    master.connect(ctx.destination);
    this.master = master;

    const ordered = [...notes].sort((a, b) => a.start - b.start).slice(0, MAX_VOICES);
    const origin = ordered[0].start;
    this.notes = ordered.map(n => ({ ...n, start: n.start - origin, end: n.end - origin }));
    this.duration = Math.max(...this.notes.map(n => n.end), 0.1);

    const t0 = ctx.currentTime + 0.08;
    for (const note of this.notes) {
      const length = Math.max(0.08, note.end - note.start);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = midiToFrequency(note.midi);

      const on = t0 + note.start;
      const off = on + length;
      // Soft attack and release so a fast passage doesn't click.
      gain.gain.setValueAtTime(0, on);
      gain.gain.linearRampToValueAtTime(0.32, on + 0.012);
      gain.gain.setValueAtTime(0.32, Math.max(on + 0.012, off - 0.05));
      gain.gain.linearRampToValueAtTime(0, off);

      osc.connect(gain);
      gain.connect(master);
      osc.start(on);
      osc.stop(off + 0.02);
    }

    this.startedAt = t0;
    this.playing = true;

    const tick = () => {
      if (!this.playing || !this.ctx) return;
      const elapsed = this.ctx.currentTime - this.startedAt;
      if (elapsed > this.duration + 0.15) {
        this.stop();
        onEnd();
        return;
      }
      const active = this.notes
        .filter(n => elapsed >= n.start - 0.02 && elapsed < n.end)
        .map(n => n.id);
      onTick(active, Math.max(0, elapsed));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.master) {
      try {
        // Fade rather than cut, so stopping mid-note doesn't pop.
        const now = this.ctx!.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(this.master.gain.value, now);
        this.master.gain.linearRampToValueAtTime(0, now + 0.03);
        const dying = this.master;
        setTimeout(() => dying.disconnect(), 80);
      } catch {
        this.master.disconnect();
      }
      this.master = null;
    }
  }

  /** Release the audio device entirely. */
  dispose() {
    this.stop();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
