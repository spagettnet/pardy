"""Kokoro TTS server using kokoro-onnx."""

import io
import os
import subprocess

import soundfile as sf
import uvicorn
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI(title="Voice XW TTS")

_kokoro = None
ROOT = os.path.dirname(__file__)
MODELS_DIR = os.path.join(ROOT, ".kokoro-models")
ONNX_FILE = os.path.join(MODELS_DIR, "kokoro-v1.0.onnx")
VOICES_FILE = os.path.join(MODELS_DIR, "voices-v1.0.bin")
BASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"


def download_if_missing(url: str, path: str) -> None:
    if os.path.exists(path):
      return

    os.makedirs(os.path.dirname(path), exist_ok=True)
    name = os.path.basename(path)
    # Download to a .partial path and atomic-rename on success so an
    # interrupted curl can't leave a truncated file in place.
    tmp = path + ".partial"
    if os.path.exists(tmp):
        os.remove(tmp)
    print(f"[tts] Downloading {name}...")
    result = subprocess.run(
        ["curl", "-L", "--fail", "--progress-bar", "-o", tmp, url],
        check=False,
    )
    if result.returncode != 0 or not os.path.exists(tmp):
        print(f"[tts] Failed to download {name}")
        if os.path.exists(tmp):
            os.remove(tmp)
        raise RuntimeError(f"Could not download {name}")
    os.rename(tmp, path)
    print(f"[tts] {name} ready ({os.path.getsize(path) // (1024 * 1024)} MB)")


def get_kokoro():
    global _kokoro
    if _kokoro is None:
        download_if_missing(f"{BASE_URL}/kokoro-v1.0.onnx", ONNX_FILE)
        download_if_missing(f"{BASE_URL}/voices-v1.0.bin", VOICES_FILE)
        print("[tts] Loading Kokoro model...")
        from kokoro_onnx import Kokoro

        _kokoro = Kokoro(ONNX_FILE, VOICES_FILE)
        print("[tts] Model ready.")
    return _kokoro


class SpeechRequest(BaseModel):
    model: str = "kokoro"
    input: str
    voice: str = "af_heart"
    speed: float = 1.0
    response_format: str = "wav"


@app.post("/v1/audio/speech")
async def text_to_speech(req: SpeechRequest):
    try:
        kokoro = get_kokoro()
        audio, sample_rate = kokoro.create(req.input, voice=req.voice, speed=req.speed, lang="en-us")
        buf = io.BytesIO()
        sf.write(buf, audio, sample_rate, format="WAV")
        buf.seek(0)
        return Response(content=buf.read(), media_type="audio/wav")
    except Exception as error:
        print(f"[tts] Error: {error}")
        import traceback

        traceback.print_exc()
        return Response(
            content=f'{{"error": "{str(error)}"}}',
            media_type="application/json",
            status_code=500,
        )


@app.get("/v1/models")
async def list_models():
    return {"models": [{"id": "kokoro", "name": "Kokoro-82M (ONNX)"}]}


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    download_if_missing(f"{BASE_URL}/kokoro-v1.0.onnx", ONNX_FILE)
    download_if_missing(f"{BASE_URL}/voices-v1.0.bin", VOICES_FILE)
    print("[tts] Starting Kokoro TTS server on http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000)
