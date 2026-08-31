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


MODEL_PATH = Path(__file__).with_name("models") / "face_detection_yunet_2023mar.onnx"
#: Below this YuNet is guessing. A wrong face moves the crop onto the wrong
#: thing, which is worse than not moving it, so low-confidence hits are dropped.
MIN_FACE_CONFIDENCE = 0.75


def _face_detector(width: int, height: int):
    """YuNet, run locally on CPU.

    Replaces the Haar cascade, which matched a taxidermy lion on a podcast set
    as a face while missing the host beside it because he had turned his head.
    Cascades also return no confidence, so there was no way to tell a certain
    detection from a guess before aiming a crop at it.
    """
    if not MODEL_PATH.exists():
        raise RuntimeError(f"face detection model is missing at {MODEL_PATH}")
    return cv2.FaceDetectorYN.create(
        str(MODEL_PATH), "", (max(32, width), max(32, height)), MIN_FACE_CONFIDENCE, 0.3, 5000
    )


def _detect_faces(detector, frame) -> list:
    """Return [((x, y, w, h), confidence)] for faces the model is sure about."""
    height, width = frame.shape[:2]
    detector.setInputSize((width, height))
    _, raw = detector.detect(frame)
    faces = []
    for row in raw if raw is not None else []:
        x, y, box_width, box_height = (int(round(float(value))) for value in row[:4])
        confidence = float(row[-1])
        if box_width < 8 or box_height < 8 or confidence < MIN_FACE_CONFIDENCE:
            continue
        faces.append(((max(0, x), max(0, y), box_width, box_height), confidence))
    return faces


def analyze(video_path: Path, samples: list[dict[str, Any]]) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("video could not be opened")
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    detector = _face_detector(source_width, source_height)
    evidence: dict[str, list[dict[str, float]]] = {}
    inspected: list[dict[str, Any]] = []

    for sample in samples[:64]:
        seconds = max(0.0, float(sample.get("time_s") or 0.0))
        # A sample with no speaker is a shot-tracking probe: it still reports
        # where the face is, it just does not vote on who sits where.
        speaker = str(sample.get("speaker") or "").strip()
        before = frame_at(capture, max(0.0, seconds - 0.14))
        center = frame_at(capture, seconds)
        after = frame_at(capture, seconds + 0.14)
        if before is None or center is None or after is None:
            continue
        faces = _detect_faces(detector, center)
        scored = []
        for face, confidence in faces:
            x, _, width, _ = face
            motion = mouth_motion(before, center, after, face)
            scored.append({
                "center_x": (x + width / 2) / max(1, source_width),
                "motion": motion,
                "area": width * face[3],
                "confidence": confidence,
            })
        if not scored:
            inspected.append({"time_s": seconds, "speaker": speaker, "faces": 0})
            continue
        # No size filter here on purpose. Discarding small detections was a
        # workaround for the cascade reporting wall decoration as a face; with a
        # model that does not do that, the same rule would throw away a real
        # second person who simply sits further from the camera.
        chosen = max(scored, key=lambda item: (item["motion"], item["area"]))
        if speaker:
            evidence.setdefault(speaker, []).append(chosen)
        inspected.append({
            "time_s": round(seconds, 3), "speaker": speaker, "faces": len(scored),
            "chosen_center_x": round(chosen["center_x"], 4), "mouth_motion": round(chosen["motion"], 3),
            "confidence": round(chosen["confidence"], 3),
        })

    capture.release()
    centers = {
        speaker: round(float(np.median([item["center_x"] for item in items])), 4)
        for speaker, items in evidence.items() if items
    }
    return {
        "ok": True,
        "method": "yunet-mouth-motion-v1",
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
