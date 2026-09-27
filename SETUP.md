# Tabify — setup & run

Everything in the app is wired; what's left is pasting your own Firebase keys in.
Work through part 1 once, then part 2 every time you want to run it.

---

## Part 1 — Firebase (one time, ~10 minutes)

### 1. Turn on Email/Password sign-in

Firebase console → your project → **Authentication** → *Get started* →
**Sign-in method** → **Email/Password** → toggle **Enable** → **Save**.

Leave "Email link (passwordless)" off — the app uses passwords.

> Skipping this is the #1 cause of a signup that fails. The app will tell you so
> in plain words ("Email/password sign-in isn't enabled yet") rather than
> throwing a raw Firebase error.

### 2. Create the Firestore database

Console → **Firestore Database** → **Create database** → pick a location →
start in **production mode** (the rules below replace whatever it starts with).

### 3. Publish the security rules

Console → **Firestore Database** → **Rules** tab. Replace everything there with
the contents of [`firestore.rules`](./firestore.rules) in this repo, then **Publish**.

Those rules say: a signed-in user can read and write only their own documents
under `users/{their uid}`, and nothing else is reachable by anyone. Until you
publish them, the dashboard will show *"Firestore denied the read."*

### 4. Copy your web config into `.env.local`

Console → **Project settings** (gear icon) → **Your apps**. If there's no web app
yet, click the `</>` icon and register one (nickname "Tabify web", no hosting needed).
You'll get a `firebaseConfig` block.

```bash
cd frontend
cp .env.example .env.local
```

Then fill in `frontend/.env.local` from that block:

| `.env.local` key                     | `firebaseConfig` field |
| ------------------------------------ | ---------------------- |
| `VITE_FIREBASE_API_KEY`              | `apiKey`               |
| `VITE_FIREBASE_AUTH_DOMAIN`          | `authDomain`           |
| `VITE_FIREBASE_PROJECT_ID`           | `projectId`            |
| `VITE_FIREBASE_STORAGE_BUCKET`       | `storageBucket`        |
| `VITE_FIREBASE_MESSAGING_SENDER_ID`  | `messagingSenderId`    |
| `VITE_FIREBASE_APP_ID`               | `appId`                |

`.env.local` is gitignored, so your keys never get committed.

> Vite only reads env files at startup — restart `npm run dev` after editing it.
> If a key is missing the app shows a setup screen naming exactly which one,
> instead of a blank page.

---

## Part 2 — Running it

**The short version:**

```bash
./start_script.sh
```

That starts both servers, waits for the transcription model to load, and prints
the URL to open. Ctrl-C stops everything. First run on a fresh clone:
`./start_script.sh --install`.

<details>
<summary>Or run the two servers by hand</summary>

Two servers, two terminals.

**Terminal 1 — backend (transcription):**

```bash
cd backend
source .godhelpme/bin/activate     # your virtualenv
pip install -r requirements.txt    # first time only
python app.py                      # serves http://127.0.0.1:2000
```

**Terminal 2 — frontend:**

```bash
cd frontend
npm install                        # first time only
npm run dev                        # serves http://localhost:5173
```

</details>

Open the frontend URL. The dashboard warns you if it can't reach the backend,
so you'll know immediately if it isn't running.

---

## Part 3 — Testing signup

1. Open the app → **Create an account** → name, email, password (6+ chars) → **Create Account**.
2. Firebase console → **Authentication → Users**: your email is listed.
3. Firebase console → **Firestore → Data**: a `users/{uid}` document exists with
   your email and display name. *That document is the link between the auth
   database and Firestore* — it's created on first sign-in and is the parent of
   everything else you save.
4. Record something → pick a format → **Download**. Back on the dashboard the
   transcription appears as a card.
5. Firestore → `users/{uid}/transcriptions/{id}` holds it, with the notes.
6. Sign out and back in — the card is still there. Same in another browser.

**If signup fails, the message tells you which step to revisit:**

| Message | Fix |
| ------- | --- |
| "Email/password sign-in isn't enabled yet" | Part 1, step 1 |
| "Your Firebase API key is wrong" | Part 1, step 4 — recheck `VITE_FIREBASE_API_KEY` |
| "Firestore denied the read" | Part 1, step 3 — publish the rules |
| "Firebase Authentication isn't set up for this project" | Part 1, step 1 |
| "Can't reach the transcription server" | Start the backend (Part 2, terminal 1) |

---

## Part 4 — Deploying (Render)

`render.yaml` describes both services. After connecting the repo:

**Backend service** — set these in the dashboard:
- `FRONTEND_URL` → your deployed frontend URL, e.g.
  `https://tabify-frontend.onrender.com`. This is the CORS allowlist. If it is
  unset the backend falls back to accepting any `*.onrender.com` origin so the
  deploy still works, and logs that it did — but set it, so only your frontend
  can call your API.
- `FIREBASE_SERVICE_ACCOUNT_JSON` → the *entire* JSON from Firebase console →
  Project settings → **Service accounts** → *Generate new private key*, pasted as
  one line.

Setting `FIREBASE_SERVICE_ACCOUNT_JSON` switches the backend into verified mode:
every `/api` call must carry a valid Firebase ID token, and a transcription can
only be downloaded by the user who made it. Leave it unset locally and the
backend runs open, so you don't need a service-account key to develop.
`GET /api/health` reports which mode it's in.

**Frontend service** — set `VITE_API_URL` to the backend's URL, plus the same six
`VITE_FIREBASE_*` values from `.env.local`. Vite bakes these in at build time, so
changing one needs a redeploy.

Also add your Render frontend domain under Firebase console → Authentication →
Settings → **Authorized domains**, or sign-in will be rejected in production.

> The backend keeps transcription jobs in process memory, which is why the start
> command pins `--workers 1`. Raising the worker count would send a download to a
> process that never saw the job.

### One CPU thread for ONNX (the server that stopped answering)

Render's free instance is a slice of a big shared machine: the process can see
many cores but may only use about a tenth of one. ONNX Runtime, left on its
defaults, starts one worker thread per visible core, and those threads
busy-wait between operations. That burns the whole CPU allowance, the kernel
throttles the entire process, and even `/api/health` stops answering. The logs
showed warm-up starting and never finishing, with requests stopping after that.

`app.py` now creates the ONNX session with one thread and spinning off, and caps
OpenMP/OpenBLAS/MKL thread pools at 1 before numpy loads. Output is bit-identical
to the defaults (checked on 12 inputs). Override with `TABIFY_ORT_THREADS` if you
move to a bigger instance.

`/api/diagnostics` now reports `cpu.visible_cores`, `cpu.quota` and
`cpu.onnx_threads`, and the startup log prints them. If warm-up ever takes more
than 90 s, the backend prints every thread's stack to the Render logs, so the
stuck call is visible instead of guessed at.

### Why librosa's numba code is bypassed entirely

basic-pitch only needs five tiny helpers from librosa (`load`, `frames_to_time`,
`midi_to_hz`, `hz_to_midi`, `cqt_frequencies`). But touching `librosa.load`
imports modules whose `@guvectorize` decorators JIT-compile **ten** numba kernels
basic-pitch never calls. Measured cold: 14.5 CPU-seconds and 377 MB peak. On
Render's fraction-of-a-CPU, 512 MB instance that ran for minutes at the edge of
memory, so the warm-up never finished and requests died mid-flight — the browser
then reports a missing CORS header because no response was ever sent.

`app.py` now hands basic-pitch those five functions written directly in numpy
(`_LibrosaShim`). librosa's numba modules are never imported and nothing is
compiled: cold start is 1.0 CPU-second and 210 MB. Output was verified
**bit-identical** to real librosa across melodies, chords, noise, a 30 s clip and
a real WebM recording. `/api/diagnostics` reports `librosa_shimmed: true`. Set
`TABIFY_USE_LIBROSA=1` to go back to real librosa.

The numba-cache handling below is kept as a safety net, but with the shim in
place it should never trigger.

### The numba JIT cache (the 31-second 500s)

librosa JIT-compiles helpers like `_localmax` with **numba**, and caches the
compiled artifacts *inside its own site-packages directory*. On Render that path
is read-only at runtime, so nothing is ever cached: every worker recompiles from
scratch, and on a 0.1-CPU instance that eventually fails from deep inside
basic-pitch with

> `Transcription failed: no compiled object yet for <Library '_localmax' ...>`

after roughly 31 seconds — which the browser reported as a 500, or, on larger
uploads, as a dropped connection with no CORS header.

Three changes fix it, all in `backend/app.py`:

1. **`NUMBA_CACHE_DIR` is pointed at writable scratch space** before anything
   imports librosa. Measured: a fresh compile with an unwritable cache takes
   14.3 s; with a writable one it loads in 0.7 s.
2. **The model is warmed up at boot** in a background thread, so the compile is
   paid once at startup rather than during someone's upload. Health checks still
   answer immediately while it runs; `/api/health` and `/api/diagnostics` report
   `model_warm`.
3. **Inference is serialized** behind a lock. Two concurrent requests both
   JIT-compiling the same numba function is another way to trigger that error,
   and on a 512 MB instance running one at a time is the right call anyway.

`backend/gunicorn.conf.py` also raises the worker timeout from gunicorn's
30-second default to 300. Gunicorn reads that file automatically from the working
directory, so it applies even if the Render service's start command is a bare
`gunicorn app:app` — which is what you get when the service was created by hand
instead of from `render.yaml`.

After a deploy, `/api/diagnostics` should show `model_warm: true` and
`decode_self_test.ok: true`. Transcription of a short clip then takes well under
a second.

### Decoding audio (ffmpeg)

The recorder in the browser produces **WebM/Opus** — that is what `MediaRecorder`
emits — and libsndfile cannot read WebM at all, nor mp3/m4a. librosa then falls
back to `audioread`, which shells out to ffmpeg. Render's Python image has no
ffmpeg, so that search fails after about **30 seconds**, which surfaced as:

> `Couldn't read that audio file` — or, on larger uploads, a dropped connection
> that the browser reports as `No 'Access-Control-Allow-Origin' header is present`.

(The CORS message was misleading: the request died before a response with CORS
headers was ever sent.)

`backend/requirements.txt` therefore includes **`imageio-ffmpeg`**, which ships a
static ffmpeg binary as a pip wheel — no system package for Render to provide.
`app.py` transcodes every upload to a canonical 22.05 kHz mono WAV before
basic-pitch sees it, so librosa only ever reads plain PCM. Decoding went from a
30-second failure to about 10 milliseconds, and mp3/m4a/flac/ogg uploads work too.

**`GET /api/diagnostics`** reports the whole audio and model stack — ffmpeg path
and source, soundfile/libsndfile versions, the allowed CORS origins, and a decode
self-test that round-trips a generated tone. Check it first whenever uploads
misbehave on a deploy; it answers in one request what otherwise takes an hour of
guessing.

### Which transcription runtime gets used

basic-pitch does not let you request a runtime — it picks one when it is
imported, based on whichever of TensorFlow / CoreML / TFLite / ONNX its own
dependency markers happened to install:

| Platform | What basic-pitch installs | Result |
| --- | --- | --- |
| macOS | `coremltools` | CoreML — works |
| Linux, Python < 3.11 | `tflite-runtime` | **broken under NumPy 2** |
| Linux, Python ≥ 3.11 | `tensorflow` (~600 MB) | works, but too big for this service |

The Linux/3.10 combination is what Render uses, and `tflite-runtime`'s wheel is
compiled against NumPy 1.x. Under NumPy 2 it fails with `_ARRAY_API not found`,
which basic-pitch reports as:

> `File .../nmp.tflite cannot be loaded into either TensorFlow, CoreML, TFLite or
> ONNX. ... On this system, ['TensorFlowLite'] is installed.`

`backend/requirements.txt` therefore adds **`onnxruntime`**, and `app.py` selects
the ONNX model explicitly rather than trusting the automatic choice. ONNX behaves
identically on macOS and Linux, is NumPy-2 clean, and loads in milliseconds.

**Check which runtime a deploy is using:** `GET /api/health` returns
`model_backend` and `model_ready`. The startup log prints
`[tabify] transcription backend: onnx (nmp.onnx)`. If no backend loads at all the
log prints `[tabify] NO TRANSCRIPTION BACKEND AVAILABLE` with the reason per
runtime, and `/api/transcribe` returns a 503 saying so instead of failing
mid-upload.

**Keep `PYTHON_VERSION` at 3.10.** On 3.11+ basic-pitch makes TensorFlow a hard
dependency on Linux, which would bloat the build and the memory footprint. If the
service was created by hand rather than from `render.yaml`, set that variable in
the Render dashboard yourself.

> Measured footprint with ONNX: ~360 MB RSS at peak, and 0.3–0.8 s of inference
> for a 5–30 second clip once warm. That fits Render's 512 MB free tier, but not
> with much room — if you start seeing out-of-memory restarts, that is the number
> to look at first. The very first transcription after a deploy is slow (~15 s)
> because librosa and its JIT warm up.
