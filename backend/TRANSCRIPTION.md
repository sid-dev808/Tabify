# How Tabify turns audio into notes

`backend/transcription.py` sits between the basic-pitch model and the API
response. It decides which notes are real, how sure we are of each one, and
which playing techniques were used. This file explains the method and the
measurements behind each setting.

If anything in this code fails on a request, `app.py` falls back to the plain
basic-pitch output, so a bug here can never stop a transcription from working.
To turn it off entirely, set `TABIFY_LEGACY_TRANSCRIPTION=1` on Render.

---

## Results

These were measured on 31 labelled guitar takes (612 notes) in two versions:
**clean** recordings, and **browser-like** ones, which have a high-pass filter,
low gain, mains hum, rumble and Opus 32 kbps compression applied, to imitate a
laptop mic recording in Chrome. A note counts as correct if its pitch is right
and it starts within 50 ms of the true note (standard `mir_eval` scoring).

| | Before (production) | Now |
|---|---|---|
| Notes, clean: F1 | 69.5% | **92.8%** |
| Notes, browser-like: F1 | 69.6% | **86.3%** |
| Wrong notes shown, browser-like (precision) | 59% correct | **89% correct** |

Most of the gain comes from removing false notes. With the old settings, about
four in ten notes on the page were wrong: one ringing note split into several,
octave "ghosts", and tremolo picking written as a pile of separate notes.

### Confidence

Each note has a `confidence` between 0 and 1, calibrated against these takes:

| Confidence | Notes that were right (browser-like audio) |
|---|---|
| 0.95 or more | 94% |
| 0.85 – 0.95 | 91% |
| below 0.85 | about 45% |

The editor shows notes below 0.85 faded as "unsure" and offers **Check next**
and **Remove all unsure**. We flag them rather than deleting them, because
removing them automatically didn't improve accuracy: about half of them are
real notes.

### Techniques (precision = how often a flag is right, recall = how many real ones are found)

| Technique | Clean: precision / recall | Browser-like: precision / recall |
|---|---|---|
| Hammer-on | 97% / 100% | 93% / 85% |
| Pull-off | 90% / 67% | 86% / 70% |
| Vibrato | 97% / 86% | 96% / 64% |
| Tremolo picking | 91% / 97% | 72% / 41% |
| Natural harmonic | 88% / 61% | 100% / 43% |

The detectors are tuned to be cautious. A wrong technique mark is more
annoying than a missing one, because adding a mark in the editor takes one
key press.

**Caveat:** the test takes are synthesized (a physical string model with
labelled techniques), because the public guitar datasets with technique labels
couldn't be downloaded from this environment. The *Before → Now* comparison is
fair, but real recordings will score differently. The harmonic and vibrato
thresholds are the ones most worth re-checking on your own recordings.

---

## The pipeline

1. **Strict basic-pitch pass** (onset 0.7, frame 0.4, notes at least 80 ms, no
   "melodia" trick). basic-pitch's defaults (0.5 / 0.3) invent notes. On guitar,
   125 of 194 false notes were one ringing note re-triggered and 50 were octave
   ghosts.
2. **Lenient pass** (0.6 / 0.3). Strict thresholds lose quiet strings in
   chords. A lenient note is added only if it isn't a re-trigger of a note
   already sounding (same pitch, within 100 ms) and isn't an overtone
   (+12/+19/+24/+28 semitones) of a stronger note starting with it.
3. **SwiftF0 pass.** [SwiftF0](https://github.com/lars76/swift-f0) is a small
   pitch tracker (MIT license, ONNX, 0.12 MB). It covers notes basic-pitch
   misses in single-note passages. A SwiftF0 note is added only where nothing
   else is sounding and its mean confidence is at least 0.7. On the
   browser-like audio this raised F1 from 87.3% to 88.8% with no loss of
   precision.
4. **Confidence.** A logistic model scores each note from these features:
   basic-pitch's amplitude, how much SwiftF0 agrees on the pitch, whether
   SwiftF0 heard anything, how many other notes are sounding, which pass found
   the note, and its duration. The model was fitted on the clean takes and
   validated on the browser-like ones, which it never saw (AUC 0.89; amplitude
   alone gives 0.85).
5. **Techniques**, in this order:
   - **Tremolo.** The model often splits fast re-picking into 2–10 notes of
     the same pitch. Back-to-back same-pitch notes are checked for picks that
     repeat at a regular 7–17 Hz. The check uses the autocorrelation of
     basic-pitch's onset activations plus spectral flux measured only at that
     note's harmonics. If the picks are regular, the notes merge into one note
     marked tremolo, with its rate. A note that already has vibrato is never
     marked tremolo, because vibrato also makes the spectrum pulse.
   - **Hammer-on / pull-off.** A new pitch 1–5 semitones from the previous
     note, where the previous note is still ringing, no other note is
     sounding, and SwiftF0's loudness barely rises. The limit is 2 dB for a
     hammer-on and 3 dB for a pull-off, which plucks the string slightly. A
     real pick rises by about 12 dB (10th percentile 5 dB).
   - **Vibrato.** SwiftF0's pitch curve over the note, detrended, must have at
     least 60% of its wobble at 3.5–9 Hz, and that wobble must be at least
     20 cents wide. Notes with vibrato were 32+ cents (10th percentile). Notes
     without were 12.5 cents or less (90th percentile).
   - **Natural harmonic.** The note must be at a pitch an open string makes as
     a harmonic (+12, +19, +24 or +28 semitones, at the 12th, 7th, 5th or 4th
     fret), with nothing else sounding, and at least 0.4 s long, since
     harmonics are left to ring. Its spectrum must also be fundamental-heavy
     (purity ≥ 0.30) with a soft attack (brightness ≤ 0.12).

## API fields

`POST /api/transcribe` still returns `{job_id, notes, duration}`. It now also
returns `engine`, which is `"tabify-analysis"`, or `"basic-pitch"` if it fell
back. Each note gains these fields:

```json
{
  "start": 0.685, "end": 1.126, "pitch_midi": 62, "pitch": "D4", "amplitude": 0.334,
  "confidence": 0.951,
  "techniques": ["pull_off"],
  "harmonic_fret": 12, "harmonic_string": 45,
  "tremolo_rate": 14.4,
  "vibrato_rate": 6.7, "vibrato_cents": 49
}
```

`harmonic_string` is the MIDI number of the open string. The last three
groups of fields appear only when they apply. Older frontends ignore all the
new fields.

## Cost on Render's free instance

These were measured with the process held to 0.1 CPU (10 ms on, 90 ms off) on
a 5-minute clip:

- **Time:** 106 s → 152 s. That is well inside gunicorn's 300 s timeout, and
  `/api/health` kept answering in under 0.2 s throughout.
- **Peak memory:** 546 MB before, 541 MB now, so no increase. This needed
  three changes:
  - SwiftF0's ONNX memory arena is off, which saves 170 MB on long clips.
  - SwiftF0 runs before basic-pitch, so the two peaks never stack.
  - Inferred onsets are computed once, in float32, instead of twice in
    float64.

## Re-measuring

The evaluation scripts (synth, test-set builder, scorer) aren't part of the
app. If you want to tune thresholds on your own labelled recordings, the
scoring is `mir_eval.transcription.match_notes` with a 50 ms onset tolerance
and a 50-cent pitch tolerance, run on the output of `transcription.analyse()`.
