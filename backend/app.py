import json
import os
import re
import shutil
import subprocess
import threading
import time
import tempfile
import uuid
from functools import wraps

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
# The browser will not read a response that lacks Access-Control-Allow-Origin,
# so an unset FRONTEND_URL turns every API call into an opaque "CORS policy"
# error in the console. Set FRONTEND_URL (comma-separated is fine) to lock this
# down; if it is missing we still accept Render-hosted frontends rather than
# silently blocking the deployment, and say so in the log.
DEV_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
RENDER_ORIGIN = re.compile(r"^https://[A-Za-z0-9-]+\.onrender\.com$")

CONFIGURED_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in os.environ.get("FRONTEND_URL", "").split(",")
    if origin.strip()
]

if CONFIGURED_ORIGINS:
    CORS_ORIGINS = CONFIGURED_ORIGINS + DEV_ORIGINS
    print(f"[tabify] CORS: allowing {CONFIGURED_ORIGINS} plus local dev origins")
else:
    CORS_ORIGINS = DEV_ORIGINS + [RENDER_ORIGIN]
    print("[tabify] CORS: FRONTEND_URL is not set - allowing any *.onrender.com "
          "origin plus local dev. Set FRONTEND_URL to restrict this.")

CORS(
    app,
    resources={r"/api/*": {"origins": CORS_ORIGINS}},
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


# ─── AUDIO DECODING ───
# Everything the app records is WebM/Opus (that is what MediaRecorder produces),
# and libsndfile cannot read WebM at all. librosa then falls back to audioread,
# which shells out to ffmpeg — absent from Render's Python image — and spends
# ~30 seconds discovering that before failing. That is the "Couldn't read that
# audio file" / 31-second hang seen in production.
#
# So we never ask librosa to decode the upload. Every file is transcoded up
# front to a canonical 22.05 kHz mono PCM WAV with ffmpeg, and only that plain
# WAV is handed to basic-pitch. ffmpeg comes from the imageio-ffmpeg wheel, so
# it is a pip dependency rather than a system package Render would have to
# provide. This also fixes mp3/m4a/aac uploads, which libsndfile cannot read
# either, and turns a 30-second failure into a 10-millisecond conversion.
TARGET_SAMPLE_RATE = 22050
FFMPEG_TIMEOUT_SECONDS = 120


def find_ffmpeg():
    system = shutil.which("ffmpeg")
    if system:
        return system, "system"
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe(), "imageio-ffmpeg"
    except Exception as exc:  # noqa: BLE001
        print(f"[tabify] no ffmpeg available ({exc}); falling back to libsndfile only")
        return None, None


FFMPEG, FFMPEG_SOURCE = find_ffmpeg()
if FFMPEG:
    print(f"[tabify] ffmpeg: {FFMPEG} ({FFMPEG_SOURCE})")


class AudioDecodeError(Exception):
    """Raised with a reason worth showing the person who uploaded the file."""


def transcode_to_wav(source_path, target_path):
    """Decode any supported upload into a canonical mono PCM WAV."""
    if FFMPEG:
        try:
            result = subprocess.run(
                [FFMPEG, "-v", "error", "-y", "-i", source_path,
                 "-ac", "1", "-ar", str(TARGET_SAMPLE_RATE), "-f", "wav", target_path],
                capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise AudioDecodeError("Decoding took too long. Try a shorter clip.")
        if result.returncode != 0 or not os.path.exists(target_path) or os.path.getsize(target_path) < 64:
            detail = (result.stderr or "").strip().splitlines()
            raise AudioDecodeError(detail[-1][:200] if detail else "ffmpeg could not decode this file")
        return

    # No ffmpeg: libsndfile handles wav/flac/ogg, and nothing else.
    try:
        audio, sample_rate = sf.read(source_path, dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001
        raise AudioDecodeError(f"{type(exc).__name__}: {exc}") from exc
    sf.write(target_path, audio.mean(axis=1), sample_rate, subtype="PCM_16")


def wav_duration_seconds(path):
    info = sf.info(path)
    return info.frames / float(info.samplerate or TARGET_SAMPLE_RATE)


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


@app.route("/api/diagnostics")
def diagnostics():
    """What the audio and model stack actually looks like on this box.

    Added because diagnosing the production failure from the browser meant
    guessing at which of libsndfile / audioread / ffmpeg was missing. Reports
    versions only — no secrets, no user data.
    """
    import platform
    import sys

    report = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "model_backend": MODEL_BACKEND,
        "model_ready": MODEL is not None,
        "ffmpeg": {"path": FFMPEG, "source": FFMPEG_SOURCE, "available": FFMPEG is not None},
        "soundfile": getattr(sf, "__version__", "unknown"),
        "libsndfile": getattr(sf, "__libsndfile_version__", "unknown"),
        "cors_origins": [o if isinstance(o, str) else o.pattern for o in CORS_ORIGINS],
        "frontend_url_set": bool(CONFIGURED_ORIGINS),
        "auth_required": _firebase_auth is not None,
    }

    # Round-trip a tiny tone through the real decode path, so a broken audio
    # stack shows up here rather than on someone's first upload.
    try:
        import math
        import struct

        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "probe.wav")
            out = os.path.join(tmp, "out.wav")
            frames = b"".join(
                struct.pack("<h", int(math.sin(2 * math.pi * 440 * i / 22050) * 20000))
                for i in range(4410)
            )
            header = (b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVEfmt "
                      + struct.pack("<IHHIIHH", 16, 1, 1, 22050, 44100, 2, 16)
                      + b"data" + struct.pack("<I", len(frames)))
            with open(raw, "wb") as handle:
                handle.write(header + frames)

            started = time.time()
            transcode_to_wav(raw, out)
            report["decode_self_test"] = {
                "ok": True,
                "seconds": round(time.time() - started, 3),
                "duration": round(wav_duration_seconds(out), 3),
            }
    except Exception as exc:  # noqa: BLE001
        report["decode_self_test"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    return jsonify(report)


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

    # Convert to a canonical WAV before anything else. basic-pitch reads the
    # file with librosa, which cannot handle the WebM the recorder produces.
    canonical_path = os.path.join(job_dir.name, "canonical.wav")
    try:
        transcode_to_wav(input_path, canonical_path)
    except AudioDecodeError as exc:
        job_dir.cleanup()
        return jsonify({
            "detail": f"Couldn't read that audio file ({exc}). "
                      "Try a WAV, MP3 or M4A file."
        }), 400

    try:
        clip_seconds = wav_duration_seconds(canonical_path)
    except Exception:  # noqa: BLE001 - a missing duration is not fatal
        clip_seconds = 0.0

    if clip_seconds < 0.1:
        job_dir.cleanup()
        return jsonify({"detail": "That audio file appears to be empty or far too short."}), 400

    if clip_seconds > MAX_CLIP_SECONDS:
        job_dir.cleanup()
        return jsonify({
            "detail": f"That clip is {clip_seconds / 60:.1f} minutes long. "
                      f"Please keep takes under {MAX_CLIP_SECONDS // 60} minutes."
        }), 400

    min_freq, max_freq = INSTRUMENT_FREQUENCY_BOUNDS.get(instrument, (None, None))

    try:
        _, midi_data, note_events = predict(
            canonical_path,
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
            "wav_path": canonical_path,
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
    # Already decoded at upload time, so there is nothing to convert here.
    if not job["wav_path"] or not os.path.exists(job["wav_path"]):
        return jsonify({"detail": "That recording is no longer available."}), 404
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
