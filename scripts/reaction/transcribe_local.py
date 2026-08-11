#!/usr/bin/env python3
"""Word-level transcription for burned-in captions.

Runs in the render worker itself. No API key, no per-video cost, and — the
reason it exists — real word timings. A hosted LLM will transcribe the same
audio correctly and place it seconds away from where it was spoken, which is
worse than shipping no captions at all.

Usage:  transcribe_local.py <audio> [--model small] [--language auto]
Prints: {"provider": "...", "words": [{"text": ..., "start": ..., "end": ...}]}
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="auto")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        print(json.dumps({"error": f"faster-whisper unavailable: {exc}"}), file=sys.stderr)
        return 2

    # int8 on CPU: the runner has no GPU, and the accuracy cost is invisible
    # at caption granularity while the speed difference is not.
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    segments, info = model.transcribe(
        args.audio,
        word_timestamps=True,
        # Ambient noise is the normal case for this pipeline — the source that
        # exposed the timing problem was a video of screaming seagulls — and
        # without VAD the model invents speech to fill it.
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        language=None if args.language == "auto" else args.language,
        condition_on_previous_text=False,
    )

    words = []
    for segment in segments:
        for word in segment.words or []:
            text = (word.word or "").strip()
            if not text:
                continue
            words.append({"text": text, "start": round(word.start, 3), "end": round(word.end, 3)})

    json.dump(
        {
            "provider": f"faster-whisper/{args.model}",
            "language": getattr(info, "language", None),
            "language_probability": round(float(getattr(info, "language_probability", 0) or 0), 3),
            "words": words,
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
