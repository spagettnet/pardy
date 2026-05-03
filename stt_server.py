"""Local STT server using faster-whisper."""

import os
import re
import tempfile

import uvicorn
from faster_whisper import WhisperModel
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI(title="Voice XW STT")

_model = None


def normalize_transcript(text: str) -> str:
    cleaned = re.sub(r"<\|[^>]+\|>", " ", text)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def get_model():
    global _model
    if _model is None:
        model_name = os.environ.get("STT_MODEL", "small.en")
        compute_type = os.environ.get("STT_COMPUTE_TYPE", "int8")
        print(f"[stt] Loading model: {model_name}")
        _model = WhisperModel(model_name, device="cpu", compute_type=compute_type)
        print("[stt] Model ready.")
    return _model


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form("small.en"),
    language: str = Form("en"),
):
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
        temp.write(await file.read())
        temp_path = temp.name

    try:
        stt_model = get_model()
        segments, _info = stt_model.transcribe(
            temp_path,
            language=language,
            task="transcribe",
            log_progress=False,
            beam_size=5,
            best_of=5,
            vad_filter=True,
            word_timestamps=False,
            condition_on_previous_text=False,
            compression_ratio_threshold=1.8,
            no_speech_threshold=0.7,
            without_timestamps=True,
        )
        text = normalize_transcript(" ".join(segment.text.strip() for segment in segments))
        return JSONResponse({"text": text, "model": model})
    except Exception as error:
        return JSONResponse({"error": str(error)}, status_code=500)
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


if __name__ == "__main__":
    print("[stt] Starting STT server on http://127.0.0.1:8001")
    uvicorn.run(app, host="127.0.0.1", port=8001)
