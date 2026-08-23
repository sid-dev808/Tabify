const backend_url = "http://127.0.0.1:2000"

export async function transcribeRecording(audioBlob, instrument) {
    const formData = new FormData();

    formData.append("file", audioBlob, "recording.webm")
    if (instrument) formData.append("instrument", instrument)

    const response = await fetch(`${backend_url}/api/transcribe`, {
        method: "POST",
        body: formData
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Server error (${response.status})`)
    }

    return response.json();
}

export function downloadUrl(jobId, format) {
    return `${backend_url}/api/download/${jobId}/${format}`;
}

export function triggerDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}