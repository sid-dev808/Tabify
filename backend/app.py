import json
import os
import threading
import time
import tempfile
import uuid
from functools import wraps

import librosa
import soundfile as sf
from basic_pitch import (
    CT_PRESENT,
    ONNX_PRESENT,
    TFLITE_PRESENT,
    TF_PRESENT,
    FilenameSuffix,
    build_icassp_2022_model_path,
)
from basic_pitch.inference import Model, predict
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

app = Flask(__name__)

# Cap uploads so a runaway recording can't exhaust the dyno's disk.
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB

# ─── CORS ───
# In production only the deployed frontend may call this API; the local Vite
# dev server origins stay allowed so development keeps working unchanged.
DEV_ORIGINS = [
    "http://localhost:5173",
    "https://tabify-frontend.onrender.com",
    "https://tabify-backend-6n5q.onrender.com",
    "http://127.0.0.1:3000",
]
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("FRONTEND_URL", "").split(",") if o.strip()]
CORS(
    app,
    resources={r"/api/*": {"origins": ALLOWED_ORIGINS + DEV_ORIGINS}},
    allow_headers=["Content-Type", "Authorization"],
    methods=["GET", "POST", "DELETE", "OPTIONS"],
)

# ─── FIREBASE AUTH ───
# When FIREBASE_SERVICE_ACCOUNT_JSON is present (set it in the Render dashboard)
# every /api call must carry a valid Firebase ID token. Without it the server
# runs open so local development doesn't need a service-account key.
_firebase_auth = None
try:
    _service_account = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if _service_account:
        import firebase_admin
        from firebase_admin import auth as firebase_auth_module
        from firebase_admin import credentials

        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(json.loads(_service_account)))
        _firebase_auth = firebase_auth_module
        print("[tabify] Firebase token verification ENABLED")
    else:
        print("[tabify] FIREBASE_SERVICE_ACCOUNT_JSON not set - running without token verification")
except Exception as exc:  # noqa: BLE001 - never let auth setup crash boot
    print(f"[tabify] Firebase admin init failed ({exc}) - running without token verification")
    _firebase_auth = None


def require_auth(view):
    """Verify the bearer token and stash the caller's uid on the request."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        request.uid = None
        if _firebase_auth is None:
            return view(*args, **kwargs)

        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify({"detail": "Missing authentication token."}), 401
        try:
            decoded = _firebase_auth.verify_id_token(header.split(" ", 1)[1])
        except Exception:  # noqa: BLE001 - any verification failure is a 401
            return jsonify({"detail": "Invalid or expired authentication token."}), 401

        request.uid = decoded.get("uid")
        return view(*args, **kwargs)

    return wrapper


# Per-instrument pitch bounds (Hz) passed to basic-pitch so transcription is
# tuned to the playable range of the selected instrument instead of guessing.
INSTRUMENT_FREQUENCY_BOUNDS = {
    "guitar":  (82.41, 1318.51),    # E2 - E6
    "bass":    (30.87, 392.00),     # B0 - G4
    "violin":  (196.00, 3520.00),   # G3 - A7
    "piano":   (27.50, 4186.01),    # A0 - C8
    "sax":     (103.83, 830.61),    # Ab2 - Ab5
    "voice":   (82.41, 1046.50),    # E2 - C6
    "ukulele": (196.00, 1760.00),   # G3 - A6
    "drums":   (None, None),
}

# job_id -> {"dir", "input_path", "midi_path", "wav_path", "uid", "created": float}
JOBS = {}
JOBS_LOCK = threading.Lock()
JOB_TTL_SECONDS = 60 * 60  # temp files older than an hour are swept
# basic-pitch is slow and this service runs a single worker, so a long upload
# would tie it up and time out the request anyway. Refuse it up front instead.
MAX_CLIP_SECONDS = 5 * 60


def purge_expired_jobs():
    cutoff = time.time() - JOB_TTL_SECONDS
    with JOBS_LOCK:
        stale = [jid for jid, job in JOBS.items() if job["created"] < cutoff]
        for jid in stale:
            job = JOBS.pop(jid, None)
            if job:
                try:
                    job["dir"].cleanup()
                except Exception:  # noqa: BLE001
                    pass


def get_owned_job(job_id):
    """Return (job, error_response). A job is only visible to the user who made it."""
    purge_expired_jobs()
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        return None, (jsonify({"detail": "That transcription has expired. Please record again."}), 404)
    if job["uid"] and getattr(request, "uid", None) and job["uid"] != request.uid:
        return None, (jsonify({"detail": "Not your transcription."}), 403)
    return job, None


# ─── TRANSCRIPTION MODEL ───
# basic-pitch does NOT let you ask for a runtime. It picks one at import time
# from whichever of TensorFlow / CoreML / TFLite / ONNX happens to be installed,
# and which of those gets installed is decided by its own dependency markers:
#
#     macOS            -> coremltools     (CoreML)
#     Linux, py < 3.11 -> tflite-runtime  (TFLite)
#     Linux, py >= 3.11-> tensorflow      (TF, ~600 MB)
#
# That is why this worked locally on a Mac and failed on Render: the Linux box
# resolved to tflite-runtime, whose C extension is compiled against NumPy 1.x
# and raises "_ARRAY_API not found" the moment you build an Interpreter under
# NumPy 2. basic-pitch swallows that and reports the confusing
# "nmp.tflite cannot be loaded into either TensorFlow, CoreML, TFLite or ONNX".
#
# So we choose the runtime ourselves, preferring ONNX: it is the one backend
# that behaves identically on every platform we run on, it is NumPy-2 clean,
# it loads in milliseconds, and its model file ships inside the package.
# Set BASIC_PITCH_BACKEND to force a specific one (onnx / coreml / tflite / tf).
BACKEND_PREFERENCE = [
    ("onnx", FilenameSuffix.onnx, ONNX_PRESENT),
    ("coreml", FilenameSuffix.coreml, CT_PRESENT),
    ("tflite", FilenameSuffix.tflite, TFLITE_PRESENT),
    ("tf", FilenameSuffix.tf, TF_PRESENT),
]


def load_transcription_model():
    """Return (model, backend_name, failure_notes). Never raises."""
    forced = os.environ.get("BASIC_PITCH_BACKEND", "").strip().lower()
    # A forced backend goes first; sorted() is stable so the rest keep their order.
    candidates = sorted(BACKEND_PREFERENCE, key=lambda entry: 0 if entry[0] == forced else 1)

    notes = []
    for name, suffix, installed in candidates:
        if not installed:
            notes.append(f"{name}: runtime not installed")
            continue
        path = build_icassp_2022_model_path(suffix)
        if not path.exists():
            notes.append(f"{name}: model file missing ({path})")
            continue
        try:
            model = Model(path)
        except Exception as exc:  # noqa: BLE001 - try the next backend instead
            notes.append(f"{name}: {type(exc).__name__}: {exc}")
            continue
        print(f"[tabify] transcription backend: {name} ({path.name})")
        return model, name, notes

    print("[tabify] NO TRANSCRIPTION BACKEND AVAILABLE:")
    for note in notes:
        print(f"[tabify]   - {note}")
    print("[tabify] fix: add 'onnxruntime' to backend/requirements.txt and redeploy")
    return None, None, notes


# Loaded once at boot rather than per request, so a misconfigured deploy fails
# visibly in the logs instead of on someone's first upload.
MODEL, MODEL_BACKEND, MODEL_NOTES = load_transcription_model()


def midi_note_to_name(midi_num):
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    name = names[int(round(midi_num)) % 12]
    octave = int(round(midi_num)) // 12 - 1
    return f"{name}{octave}"


@app.route("/api/health")
def health():
    return jsonify({
        "ok": True,
        "auth_required": _firebase_auth is not None,
        "active_jobs": len(JOBS),
        "model_ready": MODEL is not None,
        "model_backend": MODEL_BACKEND,
        "model_notes": None if MODEL is not None else MODEL_NOTES,
    })


@app.route("/hello")
def hello():
    return jsonify({"message": "Hello from Flask!"})


@app.route("/api/transcribe", methods=["POST"])
@require_auth
def transcribe():
    purge_expired_jobs()

    if MODEL is None:
        return jsonify({
            "detail": "The transcription model isn't loaded on the server. "
                      "Check the deploy logs for '[tabify] NO TRANSCRIPTION BACKEND AVAILABLE'."
        }), 503

    if "file" not in request.files:
        return jsonify({"detail": "No audio file uploaded (expected form field 'file')."}), 400

    upload = request.files["file"]
    instrument = request.form.get("instrument", "guitar")

    job_dir = tempfile.TemporaryDirectory()
    input_path = os.path.join(
        job_dir.name, "input" + (os.path.splitext(upload.filename or "")[1] or ".webm")
    )
    upload.save(input_path)

    if os.path.getsize(input_path) == 0:
        job_dir.cleanup()
        return jsonify({"detail": "The recording came through empty. Please try again."}), 400

    # Decode a single second before handing the file to the model. It is cheap,
    # and it turns a late, opaque failure (librosa's NoBackendError surfaces with
    # an empty message, giving "Transcription failed: ") into something the
    # person who uploaded the file can act on.
    try:
        probe, probe_sr = librosa.load(input_path, sr=None, mono=True, duration=1.0)
    except Exception:  # noqa: BLE001 - any decode failure means the same thing
        job_dir.cleanup()
        return jsonify({
            "detail": "Couldn't read that audio file. "
                      "Try converting it to WAV or M4A and uploading again."
        }), 400

    if probe.size < max(1, int((probe_sr or 22050) * 0.05)):
        job_dir.cleanup()
        return jsonify({"detail": "That audio file appears to be empty or far too short."}), 400

    try:
        clip_seconds = librosa.get_duration(path=input_path)
    except Exception:  # noqa: BLE001 - a missing duration is not fatal
        clip_seconds = 0.0

    if clip_seconds > MAX_CLIP_SECONDS:
        job_dir.cleanup()
        return jsonify({
            "detail": f"That clip is {clip_seconds / 60:.1f} minutes long. "
                      f"Please keep takes under {MAX_CLIP_SECONDS // 60} minutes."
        }), 400

    min_freq, max_freq = INSTRUMENT_FREQUENCY_BOUNDS.get(instrument, (None, None))

    try:
        _, midi_data, note_events = predict(
            input_path,
            MODEL,
            minimum_frequency=min_freq,
            maximum_frequency=max_freq,
            melodia_trick=True,
        )
    except Exception as exc:  # noqa: BLE001
        job_dir.cleanup()
        # NoBackendError and friends stringify to "", which used to produce the
        # useless message "Transcription failed: ".
        reason = str(exc).strip() or type(exc).__name__
        return jsonify({"detail": f"Transcription failed: {reason}"}), 500

    notes = [
        {
            "start": float(start),
            "end": float(end),
            "pitch_midi": int(round(pitch)),
            "pitch": midi_note_to_name(pitch),
            "amplitude": float(amplitude),
        }
        for start, end, pitch, amplitude, _pitch_bend in note_events
    ]
    notes.sort(key=lambda n: n["start"])
    duration = max((n["end"] for n in notes), default=0.0)

    job_id = uuid.uuid4().hex
    midi_path = os.path.join(job_dir.name, "transcription.mid")
    midi_data.write(midi_path)

    with JOBS_LOCK:
        JOBS[job_id] = {
            "dir": job_dir,
            "input_path": input_path,
            "midi_path": midi_path,
            "wav_path": None,
            "uid": getattr(request, "uid", None),
            "created": time.time(),
        }

    return jsonify({"job_id": job_id, "notes": notes, "duration": duration})


@app.route("/api/download/<job_id>/midi", methods=["GET"])
@require_auth
def download_midi(job_id):
    job, error = get_owned_job(job_id)
    if error:
        return error
    return send_file(job["midi_path"], as_attachment=True, download_name="transcription.mid")


@app.route("/api/download/<job_id>/wav", methods=["GET"])
@require_auth
def download_wav(job_id):
    job, error = get_owned_job(job_id)
    if error:
        return error

    if not job["wav_path"]:
        wav_path = os.path.join(job["dir"].name, "recording.wav")
        try:
            audio, sr = librosa.load(job["input_path"], sr=None, mono=True)
            sf.write(wav_path, audio, sr)
        except Exception as exc:  # noqa: BLE001
            return jsonify({"detail": f"WAV conversion failed: {exc}"}), 500
        job["wav_path"] = wav_path

    return send_file(job["wav_path"], as_attachment=True, download_name="recording.wav")


@app.route("/api/jobs/<job_id>", methods=["DELETE"])
@require_auth
def delete_job(job_id):
    job, error = get_owned_job(job_id)
    if error:
        return error
    with JOBS_LOCK:
        JOBS.pop(job_id, None)
    try:
        job["dir"].cleanup()
    except Exception:  # noqa: BLE001
        pass
    return jsonify({"ok": True})


@app.errorhandler(413)
def too_large(_error):
    return jsonify({"detail": "That recording is too large. Try a shorter take."}), 413


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 2000))
    app.run(host="0.0.0.0", port=port)
