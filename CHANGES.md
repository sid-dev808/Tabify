# Changes — Sept 2026

Ten changes, chosen by walking the app as a first-time user and asking where it
would lose someone. Ordered by how much they matter.

---

### 1. Rhythm is real now

**Was:** notes were spaced evenly across the staff, twelve per line, regardless of
when they were played. Bar lines sat at four fixed pixel positions and meant
nothing. A quarter note and a sixteenth looked identical unless the duration
happened to cross a threshold.

**Now:** a tempo is estimated from the onsets, notes are quantized to a sixteenth
grid, grouped into 4/4 measures, and given real note values — whole through
sixteenth, dotted included. Bar lines fall on actual bar lines. Notes played at
the same instant now stack as a chord instead of being smeared across the page.

This is the difference between a picture of sheet music and sheet music.

*Detail worth knowing:* tempo detection has a genuine ambiguity — eighths at 72 BPM
and quarters at 144 BPM are the same music written two ways, and the app may pick
either. What it will **not** do is pick 108, which fits the same onsets but makes
every note syncopated; a metrical-weight term rules that out.

### 2. Rests

An empty bar used to be an empty bar. Now silence is written: whole, half, dotted
and quarter rests, placed where nothing sounds, with whole-bar rests centred the
way a copyist would centre them.

### 3. The last line stops where the music stops

A five-bar piece used to draw eight bars, three of them empty with numbers over
them. Now a partial final system ends at the last bar with a double bar line.

### 4. PDF and PNG export

**Was:** sheet music and TAB downloaded as `.svg` — a format most people can't
open, print, or send to a teacher.

**Now:** PDF is the default, with PNG and SVG alongside. The PDF is US Letter,
paginates at staff boundaries (never mid-stave), and is built without adding a
single dependency — the image is embedded losslessly using the browser's own
compression. Verified against a real PDF parser, pixel-for-pixel.

### 5. Upload an audio file

**Was:** you could only record live, through the browser mic.

**Now:** the Record screen also takes a file — wav, mp3, m4a, ogg, flac, up to
32 MB. This is the single biggest unblock for testing: you can run the same
passage through twenty times while tuning things, and someone without an
instrument in the room can still try the app.

### 6. "Hear it"

Playback of the transcription through Web Audio, with the notes lighting up as
they sound, on the review, edit and saved-project screens.

A tester can judge accuracy in three seconds by ear. Reading the notation to check
it takes a minute and most people can't do it at all. This is the feature that
makes the accuracy question in `TESTING.md` answerable.

### 7. Better errors before the model runs

The backend now decodes one second of the upload before handing it to basic-pitch.
An unreadable file returns *"Couldn't read that audio file. Try converting it to
WAV or M4A"* instead of a stack trace. Silent files and clips over five minutes are
refused up front with the reason, rather than tying up the single worker and timing
out.

### 8. `start_script.sh`

One command starts both servers, creates the virtualenv if it's missing, waits for
the backend's health check before declaring it ready (the model takes ~30s to
load), warns if `.env.local` looks unfilled, and shuts everything down together on
Ctrl-C. `--backend`, `--frontend`, `--install` for the other cases.

### 9. Saved transcriptions got useful

Rename in place by clicking the title. Cards show the note count and detected
tempo. The tempo is stored with the transcription, so reopening it months later
lays out exactly as it did the day it was made.

### 10. Keyboard editing

Arrow keys move a selected note by a semitone, shift-arrow by an octave, delete
removes it, escape deselects. Editing a score one mouse click at a time is
miserable.

---

## Considered and deliberately not done

These are the next candidates. Listed with what they'd cost, so they can be picked
off deliberately rather than drifted into.

| Change | Why it's not done yet |
| --- | --- |
| **Engraved vector PDF** (real glyphs, selectable text) instead of an embedded image | Needs a music font (Bravura) and a text-layout pass in the PDF writer. Current output prints fine; it only matters if someone zooms in hard. |
| **Beaming eighth notes** together under one bar | Purely visual, moderately fiddly. Individual flags are correct, just less pretty. |
| **Time signatures other than 4/4** | Needs metre detection, which is a harder problem than tempo detection. A waltz currently comes out wrong. Worth doing if testers play in 3. |
| **Key signature detection** | Everything is spelled with sharps today. A key estimate would let it spell flats correctly. Self-contained, maybe half a day. |
| **Count-in / metronome before recording** | Would measurably improve tempo detection, because people play steadier to a click. Cheap to build. Strong candidate. |
| **Share a transcription by link** | Needs a public read path in the Firestore rules and a share token. Real product decision, not just code. |
| **Re-transcribe with different settings** without re-recording | The backend already keeps the audio for an hour; this is mostly UI. |

**My pick for next:** the count-in. It's a couple of hours, it makes the rhythm
engine visibly better, and it costs the user nothing.
