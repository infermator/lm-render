#!/usr/bin/env python3
"""Locate an RSS reference-audio excerpt inside a materialized video window."""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import cv2
import numpy as np


def read_pcm(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise RuntimeError("alignment WAV must be mono signed 16-bit PCM")
        rate = handle.getframerate()
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype(np.float32)
    if samples.size < rate * 2:
        raise RuntimeError("alignment WAV is too short")
    samples /= 32768.0
    # First difference reduces sensitivity to mastering/EQ and DC offsets while
    # preserving the speech waveform timing shared by RSS and YouTube encodes.
    return np.diff(samples, prepend=samples[:1]).astype(np.float32), rate


def locate(batch: np.ndarray, reference: np.ndarray, rate: int, expected_s: float, radius_s: float) -> dict[str, float | int | bool]:
    radius = int(max(1.0, radius_s) * rate)
    expected = int(max(0.0, expected_s) * rate)
    left = max(0, expected - radius)
    right = min(batch.size, expected + radius + reference.size)
    search = batch[left:right]
    if search.size < reference.size:
        raise RuntimeError("reference excerpt does not fit inside the alignment search window")

    scores = cv2.matchTemplate(search.reshape(1, -1), reference.reshape(1, -1), cv2.TM_CCOEFF_NORMED).reshape(-1)
    if not scores.size or not np.isfinite(scores).any():
        raise RuntimeError("audio correlation produced no finite score")
    best_index = int(np.nanargmax(scores))
    best = float(scores[best_index])
    masked = scores.copy()
    exclusion = int(rate * 1.5)
    masked[max(0, best_index - exclusion):min(masked.size, best_index + exclusion + 1)] = -1.0
    second = float(np.max(masked)) if masked.size else -1.0
    match_sample = left + best_index
    match_s = match_sample / rate
    return {
        "ok": True,
        "sample_rate": rate,
        "match_start_s": round(match_s, 6),
        "expected_start_s": round(expected_s, 6),
        "offset_from_expected_s": round(match_s - expected_s, 6),
        "confidence": round(best, 6),
        "second_best_confidence": round(second, 6),
        "margin": round(best - second, 6),
        "reference_duration_s": round(reference.size / rate, 6),
        "search_start_s": round(left / rate, 6),
        "search_end_s": round(right / rate, 6),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("batch_wav")
    parser.add_argument("reference_wav")
    parser.add_argument("expected_local_s", type=float)
    parser.add_argument("--radius-s", type=float, default=82.0)
    args = parser.parse_args()
    batch, batch_rate = read_pcm(Path(args.batch_wav))
    reference, reference_rate = read_pcm(Path(args.reference_wav))
    if batch_rate != reference_rate:
        raise RuntimeError(f"sample-rate mismatch ({batch_rate} != {reference_rate})")
    print(json.dumps(locate(batch, reference, batch_rate, args.expected_local_s, args.radius_s), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
