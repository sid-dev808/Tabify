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
- `FRONTEND_URL` → your deployed frontend URL (this is what CORS allows; without
  it the browser blocks every API call).
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
