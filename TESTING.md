# Testing Tabify with real people

The point of these sessions is not to show off the app. It's to find the places
where it breaks, confuses, or disappoints — which only happens when someone who
didn't build it tries to use it.

**Run it first:** `./start_script.sh`, then open http://localhost:5173.

---

## Before anyone arrives (5 min)

- [ ] `./start_script.sh` gets to "Open http://localhost:5173" with no warnings
- [ ] You can sign up with a throwaway email, record 10 seconds, and see notation
- [ ] Have a backup audio file ready (a .wav or .m4a of someone playing) in case
      their instrument isn't to hand — the Record screen takes uploads too

---

## The golden rule

**Don't help them.** Every time you want to say "oh, you have to click that one" —
write it down instead. That sentence is the bug. If they're truly stuck for more
than a minute, note where, then help.

Ask them to think out loud. "What do you expect this to do?" is the best question
you have.

---

## Session script (~15 minutes each)

### 1. Cold open (2 min)
Hand them the laptop on the sign-in screen. Say only: *"This turns a recording of
you playing into sheet music. See what you can do with it."*

Watch for:
- Do they know what to do first?
- Does the signup form frustrate them (password rules, confirm field)?
- Do they understand what "instrument" is being asked for and why?

### 2. Their own playing (5 min)
Let them record something they actually know — 15-30 seconds, not a full song.

Watch for:
- Do they play near the mic, or across the room?
- Do they wait for the transcription, or think it froze? (it takes ~10-30s)
- **Their face when the notation appears.** This is the whole experiment.

### 3. The accuracy question (3 min)
Have them press **Hear it** and compare it to what they played.

Ask: *"On a scale of 1-10, how close is that to what you played?"*
Then: *"What's wrong with it?"* — get specifics: wrong notes, wrong rhythm, extra
notes, missing notes, wrong octave.

Record the number. It's the single most important metric you have.

### 4. Getting it out (3 min)
Ask them to save it and get a copy they could send to a friend.

Watch for:
- Do they find the download? Do they understand PDF vs PNG vs SVG?
- Do they try TAB? Does the TAB make sense to them if they play guitar?
- Do they find their saved transcriptions again afterwards?

### 5. The closing questions (2 min)
1. *"Would you use this? For what?"*
2. *"What would have to be true for you to use it every week?"*
3. *"What did you expect it to do that it didn't?"*
4. *"If you could change one thing, what?"*

Question 2 is the one that tells you what to build next.

---

## What to write down per session

Copy this block for each tester.

```
Tester:                    Instrument:              Plays for:  ___ years
Date:

Accuracy score (1-10):     ___
What was wrong:

Got stuck at (with timestamps if you can):
  -
  -

Things I had to explain:
  -

Exact quotes worth keeping:
  "
  "

Would use it for:
Would need before weekly use:
```

---

## Known rough edges (don't be surprised, do note reactions)

- **Rhythm is estimated, not perfect.** Tempo is detected from your onsets; a
  steady take detects far better than a rubato one. The score prints
  "(approx)" next to the tempo when it isn't confident.
- **Polyphony is hard.** Strummed chords come out messier than single notes.
  Basic-pitch is doing the heavy lifting and it has limits.
- **First transcription of a session is slow** — the model loads on first use.
- **Bar lines assume 4/4.** A waltz will look wrong. Worth noting how much
  testers care.
- **Sheet/TAB export is an image inside a PDF**, not engraved vector text, so
  zooming in far enough gets fuzzy.

---

## After 5 testers, look for

- The same confusion twice = a design bug, fix it before testing again
- Accuracy scores clustering below 6 = work on transcription, not UI
- Accuracy above 7 but nobody would use it weekly = the problem is the workflow,
  not the notes
- Anyone asking for a feature twice = that's your next build

Log the sessions somewhere durable and revisit before the next round of changes.
