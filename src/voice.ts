/**
 * Wrappers around the local voice_xw services:
 *   - Kokoro TTS  on TTS_URL  (default http://127.0.0.1:8000)
 *   - faster-whisper STT on STT_URL (default http://127.0.0.1:8001)
 */

const TTS_URL = process.env.TTS_URL || "http://127.0.0.1:8000";
const TTS_VOICE = process.env.TTS_VOICE || "af_heart";
const STT_URL = process.env.STT_URL || "http://127.0.0.1:8001";
const STT_MODEL = process.env.STT_MODEL || "small.en";
const STT_LANGUAGE = process.env.STT_LANGUAGE || "en";

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const res = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "kokoro",
      input: text,
      voice: TTS_VOICE,
      speed: 1.0,
      response_format: "wav",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`TTS ${res.status}: ${detail}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

export async function transcribeAudio(
  audio: Buffer,
  mimeType = "audio/webm",
): Promise<string> {
  const form = new FormData();
  const ext = mimeType.includes("wav")
    ? "wav"
    : mimeType.includes("mp4")
      ? "m4a"
      : mimeType.includes("ogg")
        ? "ogg"
        : "webm";
  const ab = new ArrayBuffer(audio.byteLength);
  new Uint8Array(ab).set(audio);
  form.append("file", new Blob([ab], { type: mimeType }), `answer.${ext}`);
  form.append("model", STT_MODEL);
  form.append("language", STT_LANGUAGE);
  const res = await fetch(`${STT_URL}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`STT ${res.status}: ${detail}`);
  }
  const json = (await res.json()) as { text?: string; error?: string };
  if (json.error) throw new Error(`STT error: ${json.error}`);
  return (json.text ?? "").trim();
}

export async function ttsHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${TTS_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function sttHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${STT_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
