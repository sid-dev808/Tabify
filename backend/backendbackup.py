import os
os.environ["BASIC_PITCH_BACKEND"] = "torch"

import tempfile
import uuid

import librosa
import soundfile as sf
from basic_pitch.inference import predict
from basic_pitch import ICASSP_2022_MODEL_PATH
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

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

# job_id -> {"dir": tempfile.TemporaryDirectory, "input_path": str, "midi_path": str, "wav_path": str | None}
JOBS = {}


def midi_note_to_name(midi_num):
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    name = names[int(round(midi_num)) % 12]
    octave = int(round(midi_num)) // 12 - 1
    return f"{name}{octave}"


@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    if "file" not in request.files:
        return jsonify({"detail": "No audio file uploaded (expected form field 'file')."}), 400

    upload = request.files["file"]
    instrument = request.form.get("instrument", "guitar")

    job_dir = tempfile.TemporaryDirectory()
    input_path = os.path.join(job_dir.name, "input" + (os.path.splitext(upload.filename or "")[1] or ".webm"))
    upload.save(input_path)

    min_freq, max_freq = INSTRUMENT_FREQUENCY_BOUNDS.get(instrument, (None, None))

    try:
        _, midi_data, note_events = predict(
            input_path,
            ICASSP_2022_MODEL_PATH,
            minimum_frequency=min_freq,
            maximum_frequency=max_freq,
            melodia_trick=True,
        )
    except Exception as exc:
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
    duration = max((n["end"] for n in notes), default=0.0)

    job_id = uuid.uuid4().hex
    midi_path = os.path.join(job_dir.name, "transcription.mid")
    midi_data.write(midi_path)

    JOBS[job_id] = {"dir": job_dir, "input_path": input_path, "midi_path": midi_path, "wav_path": None}

    return jsonify({"job_id": job_id, "notes": notes, "duration": duration})


@app.route("/api/download/<job_id>/midi", methods=["GET"])
def download_midi(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"detail": "Unknown job_id."}), 404
    return send_file(job["midi_path"], as_attachment=True, download_name="transcription.mid")


@app.route("/api/download/<job_id>/wav", methods=["GET"])
def download_wav(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"detail": "Unknown job_id."}), 404

    if not job["wav_path"]:
        wav_path = os.path.join(job["dir"].name, "recording.wav")
        try:
            audio, sr = librosa.load(job["input_path"], sr=None, mono=True)
            sf.write(wav_path, audio, sr)
        except Exception as exc:
            return jsonify({"detail": f"WAV conversion failed: {exc}"}), 500
        job["wav_path"] = wav_path

    return send_file(job["wav_path"], as_attachment=True, download_name="recording.wav")


@app.route("/api/jobs/<job_id>", methods=["DELETE"])
def delete_job(job_id):
    job = JOBS.pop(job_id, None)
    if job:
        job["dir"].cleanup()
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(port=2000)
