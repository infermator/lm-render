#!/usr/bin/env python3
"""Estimate visible x positions for diarized speakers from local mouth motion."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


def frame_at(capture: cv2.VideoCapture, seconds: float) -> np.ndarray | None:
    capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, seconds) * 1000.0)
    ok, frame = capture.read()
    return frame if ok and frame is not None else None


def mouth_motion(before: np.ndarray, center: np.ndarray, after: np.ndarray, face: tuple[int, int, int, int]) -> float:
    x, y, width, height = face
    top = y + int(height * 0.48)
    bottom = min(center.shape[0], y + height)
    left = max(0, x)
    right = min(center.shape[1], x + width)
    if right - left < 8 or bottom - top < 8:
        return 0.0
    regions = []
    for frame in (before, center, after):
        gray = cv2.cvtColor(frame[top:bottom, left:right], cv2.COLOR_BGR2GRAY)
        regions.append(cv2.resize(gray, (96, 64), interpolation=cv2.INTER_AREA))
    return float((np.mean(cv2.absdiff(regions[0], regions[1])) + np.mean(cv2.absdiff(regions[1], regions[2]))) / 2.0)


def analyze(video_path: Path, samples: list[dict[str, Any]]) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("video could not be opened")
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    evidence: dict[str, list[dict[str, float]]] = {}
    inspected: list[dict[str, Any]] = []

    for sample in samples[:48]:
        seconds = max(0.0, float(sample.get("time_s") or 0.0))
        speaker = str(sample.get("speaker") or "").strip()
        if not speaker:
            continue
        before = frame_at(capture, max(0.0, seconds - 0.14))
        center = frame_at(capture, seconds)
        after = frame_at(capture, seconds + 0.14)
        if before is None or center is None or after is None:
            continue
        gray = cv2.cvtColor(center, cv2.COLOR_BGR2GRAY)
        min_face = max(32, int(min(source_width, source_height) * 0.055))
        faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=5, minSize=(min_face, min_face))
        scored = []
        for face_raw in faces:
            face = tuple(int(value) for value in face_raw)
            x, _, width, _ = face
            motion = mouth_motion(before, center, after, face)
            area_weight = (width * face[3]) / max(1, source_width * source_height)
            scored.append({"center_x": (x + width / 2) / max(1, source_width), "motion": motion, "area": area_weight})
        if not scored:
            inspected.append({"time_s": seconds, "speaker": speaker, "faces": 0})
            continue
        chosen = max(scored, key=lambda item: (item["motion"], item["area"]))
        evidence.setdefault(speaker, []).append(chosen)
        inspected.append({
            "time_s": round(seconds, 3), "speaker": speaker, "faces": len(scored),
            "chosen_center_x": round(chosen["center_x"], 4), "mouth_motion": round(chosen["motion"], 3),
        })

    capture.release()
    centers = {
        speaker: round(float(np.median([item["center_x"] for item in items])), 4)
        for speaker, items in evidence.items() if items
    }
    return {
        "ok": True,
        "method": "haar-mouth-motion-v1",
        "source": {"width": source_width, "height": source_height},
        "speaker_centers": centers,
        "speaker_evidence_count": {speaker: len(items) for speaker, items in evidence.items()},
        "samples": inspected,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("samples_json")
    args = parser.parse_args()
    samples = json.loads(Path(args.samples_json).read_text(encoding="utf-8"))
    print(json.dumps(analyze(Path(args.video), samples), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
