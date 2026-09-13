import { auth } from "./firebase";

/* ─── BACKEND BASE URL ───
   In development this falls back to the local Flask server. In production
   Render injects VITE_API_URL at build time (see render.yaml), so the static
   frontend talks to the deployed backend instead of localhost. */
const RAW_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:2000";
export const BACKEND_URL = RAW_BASE.replace(/\/+$/, "");

/* Every request carries the signed-in user's Firebase ID token so the Flask
   side can verify who is asking before it spends CPU on a transcription. */
async function authHeaders() {
  const user = auth.currentUser;
  if (!user) return {};
  try {
    return { Authorization: `Bearer ${await user.getIdToken()}` };
  } catch {
    return {};
  }
}

async function toError(response) {
  let detail = `Server error (${response.status})`;
  try {
    const body = await response.json();
    if (body && body.detail) detail = body.detail;
  } catch {
    /* non-JSON error body — keep the status-code message */
  }
  if (response.status === 401) detail = "Your session expired. Please sign in again.";
  if (response.status === 413) detail = "That recording is too large. Try a shorter take.";
  return new Error(detail);
}

/** POST the recorded audio and get back { job_id, notes, duration }. */
export async function transcribeRecording(audioBlob, instrument) {
  const formData = new FormData();
  formData.append("file", audioBlob, "recording.webm");
  if (instrument) formData.append("instrument", instrument);

  let response;
  try {
    response = await fetch(`${BACKEND_URL}/api/transcribe`, {
      method: "POST",
      headers: await authHeaders(),
      body: formData,
    });
  } catch {
    throw new Error(
      `Couldn't reach the transcription server at ${BACKEND_URL}. Make sure the backend is running.`
    );
  }

  if (!response.ok) throw await toError(response);
  return response.json();
}

/** Fetch a generated file as a blob (so the auth header is actually sent) and save it. */
export async function downloadTranscription(jobId, format, filename) {
  const response = await fetch(`${BACKEND_URL}/api/download/${jobId}/${format}`, {
    headers: await authHeaders(),
  });
  if (!response.ok) throw await toError(response);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Release the temp files held on the server for a job we no longer need. */
export async function deleteJob(jobId) {
  if (!jobId) return;
  try {
    await fetch(`${BACKEND_URL}/api/jobs/${jobId}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
  } catch {
    /* best effort — the server also expires jobs on its own */
  }
}

/** Quick liveness probe used by the dashboard's backend indicator. */
export async function checkBackend() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

export function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Legacy helper kept so AppBackup.tsx still resolves. Prefer downloadTranscription. */
export function downloadUrl(jobId, format) {
  return `${BACKEND_URL}/api/download/${jobId}/${format}`;
}
