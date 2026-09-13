import json
import os
import threading
import time

os.environ["BASIC_PITCH_BACKEND"] = "torch"

import tempfile
import uuid
from functools import wraps

import librosa
import soundfile as sf
from basic_pitch.inference import predict
from basic_pitch import ICASSP_2022_MODEL_PATH
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
    "http://127.0.0.1:5173",
    "http://localhost:3000",
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
    })


@app.route("/hello")
def hello():
    return jsonify({"message": "Hello from Flask!"})


@app.route("/api/transcribe", methods=["POST"])
@require_auth
def transcribe():
    purge_expired_jobs()

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

    min_freq, max_freq = INSTRUMENT_FREQUENCY_BOUNDS.get(instrument, (None, None))

    try:
        _, midi_data, note_events = predict(
            input_path,
            ICASSP_2022_MODEL_PATH,
            minimum_frequency=min_freq,
            maximum_frequency=max_freq,
            melodia_trick=True,
        )
    except Exception as exc:  # noqa: BLE001
        job_dir.cleanup()
        return jsonify({"detail": f"Transcription failed: {exc}"}), 500

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
