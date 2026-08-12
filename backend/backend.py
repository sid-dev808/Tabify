import os
os.environ["BASIC_PITCH_BACKEND"] = "torch"
import librosa
import numpy as np
import pyaudio as pya
import matplotlib.pyplot as plt
import soundfile as sf
import tempfile as tf
from basic_pitch.inference import predict
from basic_pitch import ICASSP_2022_MODEL_PATH
from flask import Flask, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

SECONDS = 8
RATE = 22050
FRAMES_PER_BUFFER = 2048

def audiostream():
    audio = pya.PyAudio()
    stream = audio.open(
        input=True,
        format=pya.paFloat32,
        rate=RATE,
        channels=1,
        frames_per_buffer=FRAMES_PER_BUFFER
    )
    print("Recording in Progress: Start playing your music!")
    frames = [
        np.frombuffer(stream.read(num_frames=FRAMES_PER_BUFFER), dtype=np.float32)
        for _ in range(int(RATE / FRAMES_PER_BUFFER) * SECONDS)
    ]
    stream.stop_stream()
    stream.close()
    audio.terminate()
    print("Recording Stopped")
    return np.concatenate(frames)

def compute_spectrogram(audio_data):
    print("Calculating stuff")
    stft = librosa.stft(y=audio_data, n_fft=FRAMES_PER_BUFFER)
    spectrogram_db = librosa.amplitude_to_db(np.abs(stft), ref=np.max)
    print("Doing stuff")
    onset_frames = librosa.onset.onset_detect(y=audio_data, sr=RATE, hop_length=FRAMES_PER_BUFFER, backtrack=False)
    times = librosa.frames_to_time(onset_frames, sr=RATE, hop_length=FRAMES_PER_BUFFER)
    return spectrogram_db, times

def predict_pitch(audio_data): 
    with tf.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        temp_path = f.name
    sf.write(temp_path, audio_data, RATE)   
    model_output, midi_data, note_events = predict(temp_path, ICASSP_2022_MODEL_PATH)
    os.remove(temp_path)
    return midi_data, note_events

@app.route('/hello')
def hello():
    return jsonify({"message": "Hello from Flask!"})

@app.route('/analyze')
def analyze():
    audio_data = audiostream()
    spectrogram_db, times = compute_spectrogram(audio_data)
    note_events = predict_pitch(audio_data)
    return jsonify({
        "onset_times": times.tolist(),
        "note_events": [
            {"start": s, "end": e, "pitch_midi": p, "amplitude": a}
            for s, e, p, a, pb in note_events
        ]
    })

@app.route('/record')# app route
def record():
    print('Recording...')
    audio_data = audiostream()
    mid_data, note_events = predict_pitch(audio_data)

    notes = [
        {
            "start": float(note[0]),
            "end": float(note[1]),
            "pitch": float(note[2])
        }
        for note in note_events
    ]
    return jsonify({"notes": notes})


if __name__ == '__main__':
    app.run(port=3000)