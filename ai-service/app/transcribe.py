"""Speech-to-text for meeting recordings, via Groq's hosted Whisper.

Why this lives in the AI service rather than the backend: every model call in this system goes
through here, and the API key with it. The backend owns the media and does the one thing this
service cannot — extracting an audio track with FFmpeg — then posts those bytes over.

Why hosted rather than local: running Whisper in-process would need the model weights and real CPU,
on a host that already struggles to transcode a short video. A hosted call costs a network round
trip and no memory.

WHY WE BUILD THE WEBVTT OURSELVES
---------------------------------
This asked Groq for ``response_format="vtt"`` and let the provider format the cues. That is OpenAI's
contract, not Groq's, and Groq rejects it outright::

    400 - `response_format` must be one of [json text verbose_json]

The request never reached a model, so automatic captions could not work with any key — and the
failure looked exactly like a missing one. ``verbose_json`` returns the segments with their start and
end times, so the document is assembled here instead. That is a few lines of formatting and it also
removes a dependency on a provider-specific output format, which is the sort of thing that differs
between vendors precisely when you swap them.
"""
from __future__ import annotations

from .config import get_settings


class TranscriptionUnavailable(RuntimeError):
    """No transcription provider is configured — the caller should say so, not retry."""


def _timestamp(seconds: float) -> str:
    """Seconds to a WebVTT timestamp: HH:MM:SS.mmm.

    Hours are always present. WebVTT permits MM:SS.mmm, but a two-hour AGM crosses the boundary
    mid-document, and a file that changes format partway through is the kind of thing a strict
    parser rejects at exactly the cue where it matters.
    """
    if seconds < 0:
        seconds = 0.0
    whole = int(seconds)
    millis = int(round((seconds - whole) * 1000))
    # Rounding 12.9996 gives 1000 ms, which is not a valid millisecond field.
    if millis == 1000:
        whole += 1
        millis = 0
    hours, remainder = divmod(whole, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def _to_vtt(segments: list[dict]) -> str:
    """Assemble WebVTT from Whisper's segment list.

    Cues are numbered, which is optional in the spec and worth having: it makes a truncated file
    obvious, and players show the number when a cue fails to parse.
    """
    lines = ["WEBVTT", ""]
    cue = 0
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue                      # Whisper emits empty segments over silence
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", start))
        # A zero-length or inverted cue is skipped by players without saying why, so give it a
        # minimum duration rather than emitting something that silently disappears.
        if end <= start:
            end = start + 0.5
        cue += 1
        lines.append(str(cue))
        lines.append(f"{_timestamp(start)} --> {_timestamp(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def transcribe_to_vtt(filename: str, audio: bytes) -> str:
    """Transcribe an audio file and return WebVTT.

    :raises TranscriptionUnavailable: when no API key is configured
    :raises RuntimeError: when the provider rejects the request, or returns no speech
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
        # verbose_json, not vtt. See the module docstring — vtt is not one of Groq's accepted values
        # and the request was rejected before reaching a model.
        response_format="verbose_json",
        # Cue-level timing. Without this, verbose_json can come back as one long segment, which is a
        # transcript rather than captions — technically valid WebVTT that nobody can follow.
        timestamp_granularities=["segment"],
    )

    # The SDK returns a model object; older versions return a dict. Accept both rather than pinning
    # to one version's shape.
    segments = getattr(result, "segments", None)
    if segments is None and isinstance(result, dict):
        segments = result.get("segments")

    if not segments:
        # Fall back to the plain text when there are no segments at all — a very short clip can come
        # back that way. One cue covering the whole clip is worth more than nothing.
        text = getattr(result, "text", None) or (
            result.get("text") if isinstance(result, dict) else None)
        if text and text.strip():
            return _to_vtt([{"start": 0.0, "end": 5.0, "text": text}])
        raise RuntimeError(
            "The transcription service returned no usable cues. The audio may be silent, or too "
            "short to contain speech."
        )

    # Segment objects also vary by SDK version; normalise to plain dicts.
    normalised = [
        seg if isinstance(seg, dict) else {
            "start": getattr(seg, "start", 0.0),
            "end": getattr(seg, "end", 0.0),
            "text": getattr(seg, "text", ""),
        }
        for seg in segments
    ]

    vtt = _to_vtt(normalised)
    if "-->" not in vtt:
        raise RuntimeError(
            "The transcription produced no timed cues. The audio may contain no speech."
        )
    return vtt
