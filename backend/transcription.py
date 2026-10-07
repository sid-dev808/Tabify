"""Tabify transcription: accurate notes, per-note confidence, playing techniques.

Pipeline (every threshold here was measured on a labelled test set — see
TRANSCRIPTION.md — not guessed):

1. basic-pitch, strict pass. Its defaults (onset 0.5 / frame 0.3) invent notes:
   on guitar, 125 of 194 false notes were one ringing note split into several,
   and 50 were octave ghosts. A strict pass (0.7 / 0.4) removes nearly all of
   them.
2. basic-pitch, lenient pass. Strict thresholds drop quiet strings in chords, so
   a lenient pass may ADD a note — but only if it is not a re-trigger of a note
   already sounding and not an overtone (+12/+19/+24/+28) of a stronger note.
3. SwiftF0 pass. SwiftF0 (MIT, ONNX, arXiv:2508.18440) is a monophonic pitch
   tracker. Where basic-pitch found nothing, a confident SwiftF0 note outside
   any chord is added. On compressed laptop-mic audio, SwiftF0 had the right
   pitch for 17 of 21 notes basic-pitch missed.
4. Confidence: a logistic model over basic-pitch strength, SwiftF0 agreement,
   polyphony, which pass found the note, and duration. Calibrated on held-out
   audio, notes >= 0.85 were right 94-98% of the time; below that ~55%.
5. Techniques:
   - tremolo: back-to-back repeats of one pitch whose picks recur regularly at
     7-17 Hz (periodicity of basic-pitch's onset activations + spectral flux);
   - hammer-on / pull-off: a new pitch 1-5 semitones from a still-ringing note
     with no fresh pick (SwiftF0 loudness barely jumps);
   - vibrato: a regular 3.5-9 Hz pitch wobble of 20+ cents in SwiftF0's curve;
   - natural harmonic: a long, unaccompanied note at a harmonic pitch whose
     spectrum is fundamental-heavy with a soft attack.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np
from basic_pitch import note_creation as _bp_notes
from basic_pitch.constants import AUDIO_SAMPLE_RATE, FFT_HOP

# ─── note detection settings ───
STRICT_ONSET, STRICT_FRAME = 0.7, 0.4
LENIENT_ONSET, LENIENT_FRAME = 0.6, 0.3
MIN_NOTE_FRAMES = int(round(0.080 * AUDIO_SAMPLE_RATE / FFT_HOP))   # 80 ms
LENIENT_MIN_AMPLITUDE = 0.3
GHOST_RATIO = 0.8                       # an overtone must be this much weaker than its root
OVERTONES = (12, 19, 24, 28)            # octave, octave+5th, 2 octaves, 2 octaves+maj 3rd
SWIFT_MIN_CONFIDENCE = 0.7
SWIFT_HOLD_MS = 80.0
SWIFT_MIN_SECONDS = 0.08

# ─── confidence model (logistic regression, fitted on clean audio,
#     validated on browser-compressed audio it never saw: AUC 0.89) ───
CONF_WEIGHTS = np.array([-0.84, 1.57, 2.46, 0.97, 0.39, 1.05, 1.86])
CONFIDENT = 0.85                        # >= this: right 94-98% of the time

# ─── technique thresholds ───
HAMMER_MAX_JUMP_DB = 2.0                # loudness jump at the new note; picks jump far more
PULL_MAX_JUMP_DB = 3.0                  # a pull-off plucks the string a little
LEGATO_MAX_INTERVAL = 5                 # semitones reachable without a new pick
VIBRATO_MIN_EXTENT_CENTS = 20.0         # with vibrato: >= 32; without: <= 12.5 (10th/90th pct)
VIBRATO_RATE_HZ = (3.5, 9.0)
VIBRATO_MIN_SECONDS = 0.35
VIBRATO_MIN_FRAME_CONF = 0.5
VIBRATO_MIN_PERIODIC = 0.6              # share of pitch wobble inside 3.5-9 Hz
TREMOLO_MAX_IOI = 0.15                  # a chain this fast is tremolo outright
TREMOLO_MIN_NOTES = 4
TREMOLO_CHAIN_GAP = 0.06                # same-pitch notes this close form one chain
TREMOLO_MIN_SECONDS = 0.3
TREMOLO_LAGS = (5, 12)                  # model frames between picks: 17 Hz .. 7 Hz
TREMOLO_MIN_SCORE = 0.9                 # onset + flux periodicity, measured on the test sets
TREMOLO_MIN_SCORE_SINGLE = 1.0
EARLY_PICK_MIN = 0.35                   # onset activation that counts as a hidden first pick
HARMONIC_MIN_PURITY = 0.30              # share of energy in the fundamental, first 230 ms
HARMONIC_MAX_ATTACK_BRIGHTNESS = 0.12   # a pick is a bright click; a harmonic is touched softly
HARMONIC_MIN_SECONDS = 0.4              # harmonics are let ring; short pure notes are usually fretted

TUNINGS = {
    "guitar": [40, 45, 50, 55, 59, 64],
    "bass": [28, 33, 38, 43],
    "ukulele": [67, 60, 64, 69],
}
# semitones above the open string -> the fret where that natural harmonic is played
HARMONIC_NODES = {12: 12, 19: 7, 24: 5, 28: 4}

SWIFT_FRAME = 0.016


@dataclass
class Note:
    start: float
    end: float
    pitch: int
    amplitude: float
    source: str                         # strict | lenient | swift
    confidence: float = 0.0
    techniques: List[str] = field(default_factory=list)
    harmonic_fret: Optional[int] = None
    harmonic_string: Optional[int] = None    # MIDI number of the open string
    tremolo_rate: Optional[float] = None
    vibrato_rate: Optional[float] = None
    vibrato_cents: Optional[float] = None


# ───────────────────────── note detection ─────────────────────────

def _prepare(model_output, min_freq, max_freq):
    """Frame and onset activations limited to the instrument's range, with onsets also
    inferred from sudden frame rises (basic-pitch's infer_onsets). Done once, in float32,
    for both passes: on a 5-minute clip this halves the memory basic-pitch would use."""
    frames = np.array(model_output["note"], dtype=np.float32)
    onsets = np.array(model_output["onset"], dtype=np.float32)
    if max_freq is not None:
        hi = int(np.round(69 + 12 * np.log2(max_freq / 440.0) - 21))
        frames[:, hi:] = 0
        onsets[:, hi:] = 0
    if min_freq is not None:
        lo = int(np.round(69 + 12 * np.log2(min_freq / 440.0) - 21))
        frames[:, :lo] = 0
        onsets[:, :lo] = 0
    rise = np.full_like(frames, np.inf)
    for n in (1, 2):
        d = np.empty_like(frames)
        d[:n] = frames[:n]
        d[n:] = frames[n:] - frames[:-n]
        np.minimum(rise, d, out=rise)
        del d
    np.maximum(rise, 0, out=rise)
    rise[:2] = 0
    top = float(rise.max())
    if top > 0:
        rise *= float(onsets.max()) / top
    np.maximum(onsets, rise, out=onsets)
    return frames, onsets


def _bp_pass(prepared, onset, frame):
    frames, onsets = prepared
    events = _bp_notes.output_to_notes_polyphonic(
        frames, onsets, onset_thresh=onset, frame_thresh=frame, min_note_len=MIN_NOTE_FRAMES,
        infer_onsets=False, max_freq=None, min_freq=None, melodia_trick=False)
    times = _bp_notes.model_frames_to_time(frames.shape[0])
    return [(float(times[s]), float(times[e]), int(p), float(a)) for s, e, p, a in events]


def detect_notes(model_output, swift, min_freq=None, max_freq=None) -> List[Note]:
    prepared = _prepare(model_output, min_freq, max_freq)
    notes = [Note(s, e, p, a, "strict") for s, e, p, a in _bp_pass(prepared, STRICT_ONSET, STRICT_FRAME)]

    for s, e, p, a in _bp_pass(prepared, LENIENT_ONSET, LENIENT_FRAME):
        if a < LENIENT_MIN_AMPLITUDE:
            continue
        if any(n.pitch == p and n.start - 0.10 <= s <= n.end + 0.05 for n in notes):
            continue                                            # same note, or a re-trigger of it
        if any(p - n.pitch in OVERTONES and abs(n.start - s) <= 0.06 and n.amplitude * GHOST_RATIO >= a
               for n in notes):
            continue                                            # an overtone of a stronger note
        notes.append(Note(s, e, p, a, "lenient"))

    if swift is not None:
        from swift_f0 import segment_notes
        for sn in segment_notes(swift, pitch_hold_ms=SWIFT_HOLD_MS):
            if sn.end - sn.start < SWIFT_MIN_SECONDS or sn.pitch_hz <= 0:
                continue
            p = int(round(69 + 12 * math.log2(sn.pitch_hz / 440.0)))
            if min_freq and sn.pitch_hz < min_freq * 0.97 or max_freq and sn.pitch_hz > max_freq * 1.03:
                continue
            sel = (swift.timestamps >= sn.start) & (swift.timestamps < sn.end)
            if not sel.any() or float(np.mean(swift.confidence[sel])) < SWIFT_MIN_CONFIDENCE:
                continue
            if any(n.pitch == p and n.start < sn.end and n.end > sn.start - 0.08 for n in notes):
                continue
            if any(abs(p - n.pitch) in OVERTONES and n.start < sn.end and n.end > sn.start for n in notes):
                continue                                        # SwiftF0 octave/overtone slip
            mid = (sn.start + sn.end) / 2
            if any(n.start <= mid <= n.end for n in notes):
                continue                                        # inside other notes: SwiftF0 is monophonic
            notes.append(Note(sn.start, sn.end, p, float(np.mean(swift.confidence[sel])), "swift"))

    notes.sort(key=lambda n: (n.start, n.pitch))
    return notes


# ───────────────────────── confidence ─────────────────────────

def _swift_midi(swift):
    return np.where(swift.pitch_hz > 0, 69 + 12 * np.log2(np.maximum(swift.pitch_hz, 1e-6) / 440.0), 0.0)


def _swift_agreement(swift, smidi, n: Note) -> float:
    """Fraction of confident SwiftF0 frames inside the note that land on its pitch; -1 if none."""
    sel = (swift.timestamps >= n.start + 0.03) & (swift.timestamps < min(n.end, n.start + 0.5)) & (swift.confidence > 0.5)
    if sel.sum() < 2:
        return -1.0
    return float(np.mean(np.abs(smidi[sel] - n.pitch) < 0.5))


def _polyphony(notes: List[Note], n: Note) -> int:
    mid = (n.start + n.end) / 2
    return sum(1 for m in notes if m is not n and m.start <= mid <= m.end)


def score_confidence(notes: List[Note], swift) -> None:
    smidi = _swift_midi(swift) if swift is not None else None
    for n in notes:
        agree = _swift_agreement(swift, smidi, n) if swift is not None else -1.0
        x = np.array([1.0, n.amplitude, max(agree, 0.0), float(agree < 0),
                      min(_polyphony(notes, n), 4) / 4, float(n.source == "strict"), min(n.end - n.start, 1.0)])
        n.confidence = float(1.0 / (1.0 + math.exp(-float(CONF_WEIGHTS @ x))))


# ───────────────────────── techniques ─────────────────────────

def _attack_jump_db(swift, t: float) -> float:
    before = (swift.timestamps >= t - 0.07) & (swift.timestamps < t - 0.012)
    after = (swift.timestamps >= t) & (swift.timestamps < t + 0.06)
    if not before.any() or not after.any():
        return float("inf")
    return float(np.max(swift.loudness_db[after]) - np.mean(swift.loudness_db[before]))


def _ringing_before(swift, t: float) -> float:
    sel = (swift.timestamps >= t - 0.05) & (swift.timestamps < t - 0.01)
    return float(np.mean(swift.confidence[sel] > 0.5)) if sel.any() else 0.0


def _periodicity(x, lo, hi):
    """Peak of the unbiased autocorrelation of x between lags lo..hi (frames): (strength, lag)."""
    x = np.asarray(x, float)
    if len(x) < hi * 2.5:
        return 0.0, 0
    x = x - x.mean()
    if x.std() < 1e-6:
        return 0.0, 0
    a = np.correlate(x, x, "full")[len(x) - 1:]
    a = a / a[0] / (1 - np.arange(len(a)) / len(a))
    k = lo + int(np.argmax(a[lo:hi + 1]))
    return float(a[k]), k


def _partial_flux(audio, sr, start, end, midi):
    """Spectral flux restricted to the note's own partials, one value per model frame."""
    i0, i1 = max(0, int(start * sr)), min(len(audio), int(end * sr))
    x = np.asarray(audio[i0:i1], float)
    n = 1024
    if len(x) < n + FFT_HOP * 8:
        return np.zeros(0)
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::FFT_HOP] * np.hanning(n)
    mag = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    mask = np.zeros(len(freqs), bool)
    for k in range(1, 11):
        mask |= np.abs(freqs - k * f0) < max(25.0, 0.03 * k * f0)
    logmag = np.log(mag[:, mask] + 1e-4)
    return np.maximum(np.diff(logmag, axis=0), 0).sum(1)


def tremolo_score(model_output, audio, sr, start, end, midi):
    """How strongly the note is re-picked at 7-17 Hz: onset-activation periodicity plus
    partial-flux periodicity (each 0..1). Returns (score, picks_per_second)."""
    fps = AUDIO_SAMPLE_RATE / FFT_HOP
    lo, hi = TREMOLO_LAGS
    k = int(midi) - 21
    onset = model_output.get("onset") if isinstance(model_output, dict) else None
    s1, lag = 0.0, 0
    if onset is not None and 0 <= k < onset.shape[1]:
        s1, lag = _periodicity(onset[int(start * fps) + 2:int(end * fps) - 2, k], lo, hi)
    s2, lag2 = _periodicity(_partial_flux(audio, sr, start + 0.02, end - 0.02, midi), lo, hi)
    lag = lag or lag2
    return max(s1, 0.0) + max(s2, 0.0), (fps / lag if lag else 0.0)


def _earlier_pick(model_output, start, midi, before):
    """Fast picking often hides the first pick; pull the start back to an onset peak at
    this pitch up to 150 ms earlier, never into a note already placed at the same pitch."""
    onset = model_output.get("onset") if isinstance(model_output, dict) else None
    k = int(midi) - 21
    if onset is None or not 0 <= k < onset.shape[1]:
        return start
    fps = AUDIO_SAMPLE_RATE / FFT_HOP
    floor = max([b.end for b in before if b.pitch == midi and b.end <= start] + [start - 0.15])
    i0, i1 = max(0, int(math.ceil(floor * fps))), int(start * fps) - 2
    for i in range(i0, max(i0, i1)):
        if onset[i, k] >= EARLY_PICK_MIN and onset[i, k] >= onset[max(0, i - 1), k] and onset[i, k] >= onset[i + 1, k]:
            return i / fps
    return start


def collapse_tremolo(notes: List[Note], model_output=None, audio=None, sr=None, swift=None) -> List[Note]:
    """Rapid repeated picks of one pitch become a single note marked tremolo.

    Candidates are chains of back-to-back notes at one pitch (the model re-triggering).
    A chain is tremolo when its picks repeat regularly at 7-17 Hz, measured from the
    model's onset activations and the note's own spectral flux, or when it plainly
    holds many fast re-picks."""
    by_time = sorted(notes, key=lambda n: (n.start, n.pitch))
    used = set()
    out: List[Note] = []
    for i, n in enumerate(by_time):
        if id(n) in used:
            continue
        chain = [n]
        for m in by_time[i + 1:]:
            if m.start > chain[-1].end + TREMOLO_CHAIN_GAP:
                break
            if id(m) in used or m.pitch != n.pitch:
                continue
            if m.start - chain[-1].start >= 0.04:
                chain.append(m)
        start, end = chain[0].start, max(c.end for c in chain)
        is_trem, rate = False, None
        if end - start >= TREMOLO_MIN_SECONDS:
            iois = np.diff([c.start for c in chain])
            if len(chain) >= TREMOLO_MIN_NOTES and float(np.median(iois)) <= TREMOLO_MAX_IOI:
                is_trem, rate = True, float(1.0 / np.median(iois))
            # vibrato also makes the spectrum pulse; a single bent note is not tremolo
            if audio is not None and (len(chain) >= 2 or not _has_vibrato(_vibrato_of(n, swift))):
                score, picks = tremolo_score(model_output, audio, sr, start, end, n.pitch)
                # a single long note needs stronger evidence than a chain the model already split
                if score >= (TREMOLO_MIN_SCORE if len(chain) >= 2 else TREMOLO_MIN_SCORE_SINGLE):
                    is_trem, rate = True, picks or rate
        if is_trem:
            start = _earlier_pick(model_output, start, n.pitch, out)
            for c in chain:
                used.add(id(c))
            out.append(Note(start, end, n.pitch, float(max(c.amplitude for c in chain)), chain[0].source,
                            confidence=float(max(c.confidence for c in chain)),
                            techniques=["tremolo"], tremolo_rate=round(rate, 1) if rate else None))
        else:
            used.add(id(n))
            out.append(n)
    out.sort(key=lambda n: (n.start, n.pitch))
    return out


def detect_legato(notes: List[Note], swift) -> None:
    """Hammer-on / pull-off: the pitch changes but the string is not picked again."""
    for i, n2 in enumerate(notes):
        if "tremolo" in n2.techniques:
            continue
        prev = [m for m in notes[:i] if m.start < n2.start - 0.04 and m.end >= n2.start - 0.08
                and 1 <= abs(m.pitch - n2.pitch) <= LEGATO_MAX_INTERVAL]
        others = [m for m in notes if m is not n2 and m not in prev and m.start <= n2.start <= m.end]
        if len(prev) != 1 or others:
            continue                                    # needs a single-line context
        n1 = prev[0]
        if _ringing_before(swift, n2.start) < 0.6:
            continue                                    # the string stopped: it was picked again
        up = n2.pitch > n1.pitch
        if _attack_jump_db(swift, n2.start) > (HAMMER_MAX_JUMP_DB if up else PULL_MAX_JUMP_DB):
            continue                                    # loud new attack: a pick
        n2.techniques.append("hammer_on" if up else "pull_off")


def _vibrato_of(n: Note, swift):
    """(extent_cents, periodic_share, rate_hz) of the note's pitch wobble, or None."""
    if swift is None or n.end - n.start < VIBRATO_MIN_SECONDS:
        return None
    sel = ((swift.timestamps >= n.start + 0.08) & (swift.timestamps < n.end - 0.03)
           & (swift.confidence > VIBRATO_MIN_FRAME_CONF) & (swift.pitch_hz > 0))
    if sel.sum() < 16:
        return None
    t = swift.timestamps[sel]
    cents = 1200 * np.log2(swift.pitch_hz[sel] / 440.0)
    if np.median(np.abs(cents / 100 + 69 - n.pitch)) > 0.6:
        return None                                     # SwiftF0 is tracking another note
    cents = cents - np.polyval(np.polyfit(t, cents, 1), t)
    spec = np.fft.rfft(cents)
    freqs = np.fft.rfftfreq(len(cents), SWIFT_FRAME)
    band = (freqs >= VIBRATO_RATE_HZ[0]) & (freqs <= VIBRATO_RATE_HZ[1])
    if not band.any():
        return None
    power = np.abs(spec) ** 2
    periodic = float(power[band].sum() / (power[1:].sum() + 1e-12))   # share of wobble that is regular
    extent = float(2 * math.sqrt(2) * np.std(np.fft.irfft(np.where(band, spec, 0), len(cents))))
    k = int(np.argmax(np.where(band, power, 0)))
    return extent, periodic, float(freqs[k])


def _has_vibrato(v) -> bool:
    return v is not None and v[0] >= VIBRATO_MIN_EXTENT_CENTS and v[1] >= VIBRATO_MIN_PERIODIC


def detect_vibrato(notes: List[Note], swift) -> None:
    """Regular pitch wobble of 3.5-9 Hz and at least 20 cents, from the SwiftF0 pitch curve."""
    for n in notes:
        v = _vibrato_of(n, swift)
        if _has_vibrato(v):
            n.techniques.append("vibrato")
            n.vibrato_rate = round(v[2], 1)
            n.vibrato_cents = round(v[0])


def _harmonic_spectrum(audio, sr, start, end, midi):
    x = audio[int((start + 0.03) * sr):int(min(start + 0.23, end) * sr)]
    if len(x) < int(0.08 * sr):
        return None
    size = 1 << 15
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), size))
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    partials = []
    for k in range(1, 7):
        lo, hi = int(k * f0 * 0.97 * size / sr), int(k * f0 * 1.03 * size / sr) + 1
        partials.append(float(np.max(spec[lo:hi]) ** 2) if hi < len(spec) else 0.0)
    partials = np.array(partials)
    purity = float(partials[0] / (partials.sum() + 1e-12))
    a = audio[int(start * sr):int((start + 0.04) * sr)]
    if len(a) < 64:
        return None
    asz = 4096
    aspec = np.abs(np.fft.rfft(a * np.hanning(len(a)), asz)) ** 2
    af = np.fft.rfftfreq(asz, 1.0 / sr)
    brightness = float(np.sum(aspec[af > 6 * f0]) / (np.sum(aspec[af > 50]) + 1e-12))
    return purity, brightness


def detect_harmonics(notes: List[Note], audio, sr, instrument: str) -> None:
    tuning = TUNINGS.get(instrument)
    if not tuning:
        return
    for n in notes:
        if n.end - n.start < HARMONIC_MIN_SECONDS or _polyphony(notes, n) > 0:
            continue
        nodes = [(open_m, HARMONIC_NODES[n.pitch - open_m]) for open_m in tuning
                 if (n.pitch - open_m) in HARMONIC_NODES]
        if not nodes:
            continue                                    # not a pitch any open string makes as a harmonic
        feats = _harmonic_spectrum(audio, sr, n.start, n.end, n.pitch)
        if feats is None:
            continue
        purity, brightness = feats
        if purity >= HARMONIC_MIN_PURITY and brightness <= HARMONIC_MAX_ATTACK_BRIGHTNESS:
            # prefer the easiest node to play: 12th fret, then 7th, 5th, 4th
            open_m, fret = sorted(nodes, key=lambda x: -x[1])[0]
            n.techniques.append("harmonic")
            n.harmonic_fret, n.harmonic_string = fret, open_m


# ───────────────────────── entry point ─────────────────────────

def analyse(model_output, swift, audio, sr, instrument, min_freq=None, max_freq=None) -> List[Note]:
    notes = detect_notes(model_output, swift, min_freq, max_freq)
    score_confidence(notes, swift)          # without SwiftF0 it falls back to the other cues
    notes = collapse_tremolo(notes, model_output, audio, sr, swift)
    if swift is not None:
        detect_legato(notes, swift)
        detect_vibrato(notes, swift)
    detect_harmonics(notes, audio, sr, instrument)
    return notes
