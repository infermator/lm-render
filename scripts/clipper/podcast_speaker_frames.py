#!/usr/bin/env python3
"""Build a shot-aware vertical framing plan from local face activity."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

MODEL_PATH = Path(__file__).with_name("models") / "face_detection_yunet_2023mar.onnx"
#: Below this YuNet is guessing. A wrong face moves the crop onto the wrong
#: thing, which is worse than not moving it, so low-confidence hits are dropped.
MIN_FACE_CONFIDENCE = 0.75

# Detection is deliberately capped below the source resolution. Running YuNet
# on a 4K podcast frame made faces inside paintings and taxidermy visible to the
# detector while the same model correctly ignored them at normal viewing size.
# It was also four times the pixels for no framing benefit. Normalized centres
# remain identical after the resize.
ANALYSIS_MAX_WIDTH = 960

# The crop plan is built from the actual edit, not from a two-second timer.
# Hard camera cuts are found frame-by-frame; face activity is sampled often
# enough to follow a speaker turn inside a held wide shot.
TIMELINE_SAMPLE_INTERVAL_S = 0.40
TIMELINE_MOTION_OFFSET_S = 0.14
SCENE_CHANGE_THRESHOLD = 0.52
MIN_SHOT_DURATION_S = 0.55

# Activity must be both absolute and clearly ahead of the next face. When that
# evidence is missing, the safe result is the whole shot, not a confident crop
# on the wrong listener.
ACTIVE_SPEAKER_MIN_ACTIVITY = 3.0
ACTIVE_SPEAKER_MIN_RATIO = 1.35
ACTIVE_SPEAKER_MARGIN = 0.8
ACTIVE_SPEAKER_WINDOW_S = 0.85
FACE_TRACK_MAX_DISTANCE = 0.14


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


def _analysis_size(width: int, height: int) -> tuple[int, int]:
    if width <= 0 or height <= 0:
        raise RuntimeError("video has invalid dimensions")
    scale = min(1.0, ANALYSIS_MAX_WIDTH / width)
    return max(32, int(round(width * scale))), max(32, int(round(height * scale)))


def _region_motion(
    before: np.ndarray,
    center: np.ndarray,
    after: np.ndarray,
    face: tuple[int, int, int, int],
    vertical: tuple[float, float],
) -> float:
    """Motion inside one normalized face region.

    Every crop is resized to the same dimensions, so the score does not reward
    a nearby face merely for containing more pixels.
    """
    x, y, width, height = face
    left = max(0, x + int(width * 0.14))
    right = min(center.shape[1], x + int(width * 0.86))
    top = max(0, y + int(height * vertical[0]))
    bottom = min(center.shape[0], y + int(height * vertical[1]))
    if right - left < 8 or bottom - top < 8:
        return 0.0
    regions = []
    for frame in (before, center, after):
        gray = cv2.cvtColor(frame[top:bottom, left:right], cv2.COLOR_BGR2GRAY)
        regions.append(cv2.resize(gray, (72, 48), interpolation=cv2.INTER_AREA))
    return float(
        (np.mean(cv2.absdiff(regions[0], regions[1]))
         + np.mean(cv2.absdiff(regions[1], regions[2]))) / 2.0
    )


def _face_observations(detector, before: np.ndarray, center: np.ndarray, after: np.ndarray) -> list[dict[str, float]]:
    """Measure every real face without deciding who deserves the crop yet."""
    frame_height, frame_width = center.shape[:2]
    observations = []
    for face, confidence in _detect_faces(detector, center):
        x, _, width, height = face
        mouth = _region_motion(before, center, after, face, (0.50, 0.92))
        upper = _region_motion(before, center, after, face, (0.08, 0.43))
        # Head turns and camera motion move the entire face. Subtracting the
        # upper-face baseline keeps lip motion while rejecting rigid movement.
        activity = max(0.0, mouth - upper * 0.65)
        observations.append({
            "center_x": (x + width / 2) / max(1, frame_width),
            "area": (width * height) / max(1, frame_width * frame_height),
            "confidence": confidence,
            "mouth_motion": mouth,
            "upper_motion": upper,
            "speech_activity": activity,
        })
    return observations


def _scene_change_score(previous: np.ndarray, current: np.ndarray) -> float:
    """A hard-cut score with a wide gap between edits and ordinary motion."""
    previous_hsv = cv2.cvtColor(previous, cv2.COLOR_BGR2HSV)
    current_hsv = cv2.cvtColor(current, cv2.COLOR_BGR2HSV)
    previous_hist = cv2.calcHist([previous_hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
    current_hist = cv2.calcHist([current_hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
    cv2.normalize(previous_hist, previous_hist, 1, 0, cv2.NORM_L1)
    cv2.normalize(current_hist, current_hist, 1, 0, cv2.NORM_L1)
    histogram_distance = cv2.compareHist(previous_hist, current_hist, cv2.HISTCMP_BHATTACHARYYA)
    previous_gray = cv2.cvtColor(previous, cv2.COLOR_BGR2GRAY)
    current_gray = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
    pixel_distance = float(np.mean(cv2.absdiff(previous_gray, current_gray))) / 255.0
    return float(histogram_distance + pixel_distance * 1.5)


def _timeline_observations(video_path: Path) -> tuple[float, list[float], list[dict[str, Any]]]:
    """Decode once, finding exact cuts and measuring faces on a dense grid."""
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("video could not be opened")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if not math.isfinite(fps) or fps <= 0 or frame_count <= 0:
        capture.release()
        raise RuntimeError("video has invalid timing metadata")
    duration = frame_count / fps
    analysis_width, analysis_height = _analysis_size(source_width, source_height)
    detector = _face_detector(analysis_width, analysis_height)

    motion_offset_frames = max(1, int(round(TIMELINE_MOTION_OFFSET_S * fps)))
    sample_step_frames = max(1, int(round(TIMELINE_SAMPLE_INTERVAL_S * fps)))
    sample_centers = list(range(motion_offset_frames, max(motion_offset_frames, frame_count - motion_offset_frames), sample_step_frames))
    needed_frames = {
        frame_index
        for center_index in sample_centers
        for frame_index in (center_index - motion_offset_frames, center_index, center_index + motion_offset_frames)
    }
    completes_at = {center_index + motion_offset_frames: center_index for center_index in sample_centers}
    stored_frames: dict[int, np.ndarray] = {}
    observations: list[dict[str, Any]] = []

    previous_scene = None
    cuts = [0.0]
    last_cut = 0.0
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok or frame is None:
            break
        if frame_index in needed_frames:
            stored_frames[frame_index] = cv2.resize(
                frame, (analysis_width, analysis_height), interpolation=cv2.INTER_AREA
            )
        scene = cv2.resize(frame, (192, 108), interpolation=cv2.INTER_AREA)
        if previous_scene is not None:
            score = _scene_change_score(previous_scene, scene)
            at = frame_index / fps
            if score >= SCENE_CHANGE_THRESHOLD and at - last_cut >= MIN_SHOT_DURATION_S:
                cuts.append(at)
                last_cut = at
        previous_scene = scene
        center_index = completes_at.get(frame_index)
        if center_index is not None:
            before = stored_frames.get(center_index - motion_offset_frames)
            center = stored_frames.get(center_index)
            after = stored_frames.get(center_index + motion_offset_frames)
            if before is not None and center is not None and after is not None:
                observations.append({
                    "time_s": center_index / fps,
                    "faces": _face_observations(detector, before, center, after),
                })
            # These frames cannot be needed by any later centre once its after
            # frame has arrived. Keeping the dictionary bounded matters on 4K.
            cutoff = center_index - motion_offset_frames
            for key in [key for key in stored_frames if key <= cutoff]:
                stored_frames.pop(key, None)
        frame_index += 1
    capture.release()
    if duration - cuts[-1] < MIN_SHOT_DURATION_S and len(cuts) > 1:
        cuts.pop()
    cuts.append(duration)
    return duration, cuts, observations


def _median(values: list[float]) -> float:
    return float(np.median(values)) if values else 0.0


def _track_faces(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Associate stable left-to-right face identities inside one camera shot."""
    tracks: list[dict[str, Any]] = []
    for observation in observations:
        used: set[int] = set()
        for face in sorted(observation["faces"], key=lambda item: item["area"], reverse=True):
            candidates = []
            for index, track in enumerate(tracks):
                if index in used:
                    continue
                center = _median([item["center_x"] for item in track["items"][-5:]])
                distance = abs(face["center_x"] - center)
                if distance <= FACE_TRACK_MAX_DISTANCE:
                    candidates.append((distance, index))
            if candidates:
                _, track_index = min(candidates)
            else:
                track_index = len(tracks)
                tracks.append({"id": track_index, "items": []})
            used.add(track_index)
            tracks[track_index]["items"].append({"time_s": observation["time_s"], **face})
    return tracks


def _activity_at(track: dict[str, Any], seconds: float) -> float:
    nearby = [
        item["speech_activity"]
        for item in track["items"]
        if abs(item["time_s"] - seconds) <= ACTIVE_SPEAKER_WINDOW_S
    ]
    if not nearby:
        return 0.0
    # A short pause between words should not surrender the frame, while one
    # listener head-turn must not win it. A modest upper percentile rewards
    # repeated lip motion across the window and ignores a lone motion spike.
    return float(np.percentile(nearby, 65))


def _track_center(track: dict[str, Any]) -> float:
    return _median([item["center_x"] for item in track["items"]])


def _fallback_track(tracks: list[dict[str, Any]], previous_center: float) -> dict[str, Any]:
    """Choose one stable subject when local speech evidence is uncertain.

    Strong repeated mouth activity wins first. Otherwise prominence and
    continuity decide the shot once, instead of changing the output layout or
    guessing again on every sample.
    """
    ranked = []
    for track in tracks:
        activities = [item["speech_activity"] for item in track["items"]]
        robust_activity = float(np.percentile(activities, 65)) if activities else 0.0
        proven_activity = robust_activity if robust_activity >= ACTIVE_SPEAKER_MIN_ACTIVITY else 0.0
        area = _median([item["area"] for item in track["items"]])
        coverage = len(track["items"])
        center = _track_center(track)
        ranked.append((proven_activity, area, coverage, -abs(center - previous_center), track))
    return max(ranked, key=lambda item: item[:-1])[-1]


def _fill_uncertain_labels(labels: list[int | None], fallback_id: int) -> list[int]:
    """Hold a proven subject through pauses; never flash to another layout."""
    filled: list[int] = []
    last = fallback_id
    for label in labels:
        if label is not None:
            last = label
        filled.append(last)
    first_proven = next((label for label in labels if label is not None), fallback_id)
    for index, label in enumerate(labels):
        if label is not None:
            break
        filled[index] = first_proven
    return filled


def _collapse_labels(labels: list[int | None]) -> list[int | None]:
    """Debounce active-speaker choices and bridge brief speech pauses."""
    if not labels:
        return []
    smoothed: list[int | None] = []
    for index, label in enumerate(labels):
        window = labels[max(0, index - 1):min(len(labels), index + 2)]
        votes = [value for value in window if value is not None]
        if votes:
            counts = {value: votes.count(value) for value in set(votes)}
            winner, count = max(counts.items(), key=lambda item: item[1])
            smoothed.append(winner if count >= 2 else label)
        else:
            smoothed.append(None)
    # An uncertain sample between the same speaker on both sides is a breath,
    # not a reason to flash to the wide fallback for four tenths of a second.
    for index in range(1, len(smoothed) - 1):
        if smoothed[index] is None and smoothed[index - 1] == smoothed[index + 1]:
            smoothed[index] = smoothed[index - 1]
    return smoothed


def _stabilize_label_runs(labels: list[int | None]) -> list[int | None]:
    """Keep only sustained speaker choices; bridge pauses between the same one."""
    stable = list(labels)

    def runs(values: list[int | None]) -> list[tuple[int, int, int | None]]:
        grouped = []
        start = 0
        for index in range(1, len(values) + 1):
            if index == len(values) or values[index] != values[start]:
                grouped.append((start, index, values[start]))
                start = index
        return grouped

    # A speaker has to win for roughly a second. Anything shorter is exactly
    # the kind of listener fidget that made the old crop jump.
    for start, end, label in runs(stable):
        if label is not None and end - start < 3:
            stable[start:end] = [None] * (end - start)

    # Preserve the same speaker across a breath or a momentary missed face.
    grouped = runs(stable)
    for index in range(1, len(grouped) - 1):
        start, end, label = grouped[index]
        left = grouped[index - 1][2]
        right = grouped[index + 1][2]
        if label is None and end - start <= 3 and left is not None and left == right:
            stable[start:end] = [left] * (end - start)

    # Offline look-ahead lets a sustained choice start on the shot boundary,
    # instead of visibly arriving a second late after the camera already cut.
    grouped = runs(stable)
    first_real = next((item for item in grouped if item[2] is not None), None)
    if first_real and first_real[0] <= 2 and first_real[1] - first_real[0] >= 3:
        stable[:first_real[0]] = [first_real[2]] * first_real[0]
    last_real = next((item for item in reversed(grouped) if item[2] is not None), None)
    if last_real and len(stable) - last_real[1] <= 2 and last_real[1] - last_real[0] >= 3:
        stable[last_real[1]:] = [last_real[2]] * (len(stable) - last_real[1])
    return stable


def _plan_shot_segments(
    start: float,
    end: float,
    observations: list[dict[str, Any]],
    previous_center: float = 0.5,
) -> list[dict[str, Any]]:
    tracks = _track_faces(observations)
    visible_tracks = [track for track in tracks if len(track["items"]) >= max(1, len(observations) // 3)]
    if not visible_tracks:
        return [{
            "start_s": start, "end_s": end, "layout": "crop",
            "center_x": round(max(0.0, min(1.0, previous_center)), 4),
            "reason": "no_stable_face_hold", "confidence": 0.0, "face_count": 0,
        }]
    if len(visible_tracks) == 1:
        track = visible_tracks[0]
        return [{
            "start_s": start, "end_s": end, "layout": "crop",
            "center_x": round(_track_center(track), 4),
            "reason": "single_visible_face", "confidence": 1.0, "face_count": 1,
        }]

    times = [observation["time_s"] for observation in observations]
    labels: list[int | None] = []
    confidences: list[float] = []
    for seconds in times:
        scored = sorted(
            [(_activity_at(track, seconds), track["id"]) for track in visible_tracks],
            reverse=True,
        )
        best_score, best_id = scored[0]
        second_score = scored[1][0] if len(scored) > 1 else 0.0
        confident = (
            best_score >= ACTIVE_SPEAKER_MIN_ACTIVITY
            and best_score >= second_score * ACTIVE_SPEAKER_MIN_RATIO + ACTIVE_SPEAKER_MARGIN
        )
        labels.append(best_id if confident else None)
        confidences.append(0.0 if not confident else min(1.0, (best_score - second_score) / max(best_score, 1e-6)))
    labels = _stabilize_label_runs(_collapse_labels(labels))

    fallback = _fallback_track(visible_tracks, previous_center)
    fallback_id = fallback["id"]

    # If nobody wins for a sustained run, hold one stable best subject for the
    # entire camera angle. If even one run is proven, keep those speaker choices
    # and bridge the uncertain pauses below. The old coverage threshold threw
    # useful speech evidence away merely because a shot contained long pauses.
    if not any(label is not None for label in labels):
        return [{
            "start_s": start, "end_s": end, "layout": "crop",
            "center_x": round(_track_center(fallback), 4),
            "reason": "ambiguous_stable_subject", "confidence": 0.0,
            "face_count": len(visible_tracks),
        }]

    labels = _fill_uncertain_labels(labels, fallback_id)

    track_by_id = {track["id"]: track for track in visible_tracks}
    boundaries = [start]
    for left, right in zip(times, times[1:]):
        boundaries.append((left + right) / 2)
    boundaries.append(end)
    segments = []
    for index, label in enumerate(labels):
        segment_start = boundaries[index]
        segment_end = boundaries[index + 1]
        layout = "crop"
        center_x = None
        reason = "active_speaker_motion"
        confidence = confidences[index]
        track = track_by_id[label]
        nearby_centers = [
            item["center_x"] for item in track["items"]
            if segment_start - ACTIVE_SPEAKER_WINDOW_S <= item["time_s"] <= segment_end + ACTIVE_SPEAKER_WINDOW_S
        ]
        center_x = round(_median(nearby_centers or [item["center_x"] for item in track["items"]]), 4)
        candidate = {
            "start_s": segment_start, "end_s": segment_end, "layout": layout,
            "center_x": center_x, "reason": reason, "confidence": round(confidence, 3),
            "face_count": len(visible_tracks),
        }
        if segments and segments[-1]["layout"] == candidate["layout"]:
            if abs(segments[-1]["center_x"] - center_x) < 0.06:
                segments[-1]["end_s"] = segment_end
                segments[-1]["confidence"] = round(max(segments[-1]["confidence"], candidate["confidence"]), 3)
                continue
        segments.append(candidate)
    return [segment for segment in segments if segment["end_s"] - segment["start_s"] > 0.02]


def _framing_plan(duration: float, cuts: list[float], observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments = []
    previous_center = 0.5
    for shot_index, (start, end) in enumerate(zip(cuts, cuts[1:])):
        shot_observations = [item for item in observations if start <= item["time_s"] < end]
        planned = _plan_shot_segments(start, end, shot_observations, previous_center)
        for segment in planned:
            segment["shot_index"] = shot_index
            segment["transition"] = "shot_cut" if abs(segment["start_s"] - start) < 0.02 else "speaker_switch"
            segments.append(segment)
        if planned:
            previous_center = float(planned[-1]["center_x"])
    if not segments:
        return [{
            "start_s": 0.0, "end_s": duration, "layout": "crop", "center_x": 0.5,
            "reason": "no_timeline_evidence_center", "confidence": 0.0, "face_count": 0,
            "shot_index": 0, "transition": "shot_cut",
        }]
    segments[0]["start_s"] = 0.0
    segments[-1]["end_s"] = duration
    return segments


def analyze(video_path: Path, samples: list[dict[str, Any]]) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("video could not be opened")
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    capture.release()

    duration, cuts, timeline = _timeline_observations(video_path)
    framing_segments = _framing_plan(duration, cuts, timeline)
    evidence: dict[str, list[dict[str, float]]] = {}
    inspected: list[dict[str, Any]] = []

    for sample in samples[:64]:
        seconds = max(0.0, float(sample.get("time_s") or 0.0))
        speaker = str(sample.get("speaker") or "").strip()
        segment = next(
            (item for item in framing_segments if item["start_s"] <= seconds < item["end_s"]),
            framing_segments[-1],
        )
        nearest = min(timeline, key=lambda item: abs(item["time_s"] - seconds)) if timeline else None
        row = {
            "time_s": round(seconds, 3),
            "speaker": speaker,
            "faces": len(nearest["faces"]) if nearest else 0,
            "layout": segment["layout"],
            "reason": segment["reason"],
            "shot_index": segment["shot_index"],
        }
        if segment["layout"] == "crop" and segment["center_x"] is not None:
            chosen = {
                "center_x": float(segment["center_x"]),
                "motion": 0.0,
                "area": 0.0,
                "confidence": float(segment["confidence"]),
            }
            row["chosen_center_x"] = round(chosen["center_x"], 4)
            row["confidence"] = round(chosen["confidence"], 3)
            if nearest and nearest["faces"]:
                face = min(nearest["faces"], key=lambda item: abs(item["center_x"] - chosen["center_x"]))
                row["mouth_motion"] = round(face["mouth_motion"], 3)
                row["upper_motion"] = round(face["upper_motion"], 3)
                row["speech_activity"] = round(face["speech_activity"], 3)
                chosen["motion"] = face["speech_activity"]
                chosen["area"] = face["area"]
            if speaker:
                evidence.setdefault(speaker, []).append(chosen)
        inspected.append(row)

    centers = {
        speaker: round(float(np.median([item["center_x"] for item in items])), 4)
        for speaker, items in evidence.items() if items
    }
    return {
        "ok": True,
        "method": "yunet-shot-aware-active-speaker-v3",
        "source": {"width": source_width, "height": source_height},
        "speaker_centers": centers,
        "speaker_evidence_count": {speaker: len(items) for speaker, items in evidence.items()},
        "samples": inspected,
        "framing_segments": framing_segments,
        "timeline": {
            "duration_s": round(duration, 3),
            "shot_count": max(0, len(cuts) - 1),
            "observation_count": len(timeline),
            "analysis_width": _analysis_size(source_width, source_height)[0],
            "sample_interval_s": TIMELINE_SAMPLE_INTERVAL_S,
            "cuts_s": [round(value, 3) for value in cuts[1:-1]],
        },
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
