"""Speech-to-text for meeting recordings, via Groq's hosted Whisper.

Why this lives in the AI service rather than the backend: every model call in this system goes
through here, and the API key with it. The backend owns the media and does the one thing this
service cannot — extracting an audio track with FFmpeg — then posts those bytes over.

Why hosted rather than local: running Whisper in-process would need the model weights and real CPU,
on a host that already struggles to transcode a short video. A hosted call costs a network round
trip and no memory.

The transcript is requested as WebVTT directly, so the timestamps arrive already formatted and
nothing here has to assemble cue timings from word offsets.
"""
from __future__ import annotations

from .config import get_settings


class TranscriptionUnavailable(RuntimeError):
    """No transcription provider is configured — the caller should say so, not retry."""


def transcribe_to_vtt(filename: str, audio: bytes) -> str:
    """Transcribe an audio file and return WebVTT.

    :raises TranscriptionUnavailable: when no API key is configured
    :raises RuntimeError: when the provider rejects the request
    """
    s = get_settings()
    if not s.groq_api_key:
        raise TranscriptionUnavailable(
            "Speech-to-text needs GROQ_API_KEY. Without it, upload a .vtt or .srt file instead."
        )

    try:
        from groq import Groq
    except ImportError as ex:                                    # pragma: no cover
        raise TranscriptionUnavailable(
            "The groq package is not installed; cannot transcribe."
        ) from ex

    client = Groq(api_key=s.groq_api_key)
    result = client.audio.transcriptions.create(
        # A (name, bytes) tuple rather than a file handle: the audio arrived over HTTP and never
        # touched this service's disk.
        file=(filename, audio),
        model=s.whisper_model,
        response_format="vtt",
    )

    # With response_format="vtt" the SDK hands back the raw document. Older versions wrap it in an
    # object with a `text` attribute, so accept either rather than depending on the exact version.
    vtt = result if isinstance(result, str) else getattr(result, "text", None)
    if not vtt or "-->" not in vtt:
        raise RuntimeError(
            "The transcription service returned no usable cues. The audio may be silent, or too "
            "short to contain speech."
        )
    return vtt if vtt.lstrip().startswith("WEBVTT") else "WEBVTT\n\n" + vtt.lstrip()
