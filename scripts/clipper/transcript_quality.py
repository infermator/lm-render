"""Conservative Whisper quality checks for Podcast V3 only (never Reaction V1).

Confidence is only a diagnostic. Do not drop quiet real speech because one
ASR pass assigns low probability; require an independent targeted pass.
"""
from __future__ import annotations

from typing import Any
import math
import re


def finite(value: Any, default: float) -> float:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else default
    except (TypeError, ValueError):
        return default


def quality_signals(segment: Any) -> dict[str, Any]:
    no_speech = finite(getattr(segment, "no_speech_prob", None), 0)
    logprob = finite(getattr(segment, "avg_logprob", None), 0)
    compression = finite(getattr(segment, "compression_ratio", None), 0)
    text = str(getattr(segment, "text", "") or "").strip()
    tokens = re.findall(r"\w+", text.lower(), re.UNICODE)
    repeated = len(tokens) >= 8 and len(set(tokens)) <= max(2, len(tokens) // 5)
    suspicious = (no_speech > 0.6 and logprob < -1.0) or compression > 2.4 or repeated
    return {
        "no_speech_prob": round(no_speech, 4),
        "avg_logprob": round(logprob, 4),
        "compression_ratio": round(compression, 4),
        "suspected_hallucination": bool(suspicious),
        "repeated_words": bool(repeated),
    }


def use_retry(original: dict[str, Any], candidate: dict[str, Any] | None) -> bool:
    """Take a replacement only if it actually transcribes speech more confidently."""
    if not candidate or not candidate.get("words"):
        return False
    before = original.get("quality", {})
    after = candidate.get("quality", {})
    if after.get("suspected_hallucination"):
        return False
    confidence_improved = finite(after.get("avg_logprob"), -10) >= finite(before.get("avg_logprob"), -10) + 0.3
    # Do not replace a substantive sentence with an unrelated single word.
    word_count = len(original.get("words", []))
    retains_content = len(candidate["words"]) >= max(1, math.ceil(word_count * 0.55))
    return confidence_improved and retains_content


def agreed_silence(original: dict[str, Any], retry_words: list[dict[str, Any]]) -> bool:
    """Conservative deletion: the first pass strongly predicted no speech and
    a second independent decode found zero words."""
    signals = original.get("quality", {})
    return (not retry_words and finite(signals.get("no_speech_prob"), 0) > 0.85
            and finite(signals.get("avg_logprob"), 0) < -1.35)
