#!/usr/bin/env python3
"""Build a shot-aware vertical framing plan from local face activity."""

from __future__ import annotations

import argparse
import json
import subprocess
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

MODEL_PATH = Path(__file__).with_name("models") / "face_detection_yunet_2023mar.onnx"
RECOGNITION_MODEL_PATH = Path(__file__).with_name("models") / "face_recognition_sface_2021dec.onnx"
#: Two embeddings of the same face score 0.79-0.89 across camera cuts on the
#: reference clip; two different people score 0.00-0.03. Anything in between is
#: treated as "not the same person", because a wrong identity moves the crop to
#: the wrong host, while a missed match only falls back to the older behaviour.
IDENTITY_MATCH_THRESHOLD = 0.40
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


def _face_recognizer():
    """SFace, run locally on CPU.

    Identity is the only thing that survives a camera cut. Position does not:
    the same host sits at a different x in every angle, which is why matching
    the previous speaker by centre never fired on a real clip.
    """
    if not RECOGNITION_MODEL_PATH.exists():
        return None
    try:
        return cv2.FaceRecognizerSF.create(str(RECOGNITION_MODEL_PATH), "")
    except Exception:
        # An OpenCV build without the recognition module must degrade to the
        # previous behaviour rather than fail the render.
        return None


def _face_embedding(recognizer, frame, face_row) -> "np.ndarray | None":
    if recognizer is None or face_row is None:
        return None
    try:
        embedding = recognizer.feature(recognizer.alignCrop(frame, face_row)).flatten()
    except Exception:
        return None
    norm = float(np.linalg.norm(embedding))
    if norm <= 1e-6:
        return None
    return embedding / norm


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
        # The raw row is kept alongside the box: face alignment needs the
        # landmarks it carries, and cropping to the box alone measurably
        # degrades the embedding.
        faces.append(((max(0, x), max(0, y), box_width, box_height), confidence, row))
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


def _face_observations(
    detector,
    before: np.ndarray,
    center: np.ndarray,
    after: np.ndarray,
    recognizer=None,
    full_res: tuple = None,
) -> list[dict[str, float]]:
    """Measure every real face without deciding who deserves the crop yet."""
    frame_height, frame_width = center.shape[:2]
    observations = []
    for face, confidence, raw_row in _detect_faces(detector, center):
        x, y, width, height = face
        # Measure on the full-resolution frames when they are available, with
        # the box scaled up to match. The detection box comes from the small
        # copy; the pixels it points at are far more informative at source size.
        if full_res is not None:
            scale = full_res[1].shape[1] / max(1, center.shape[1])
            scaled = tuple(int(round(value * scale)) for value in face)
            mouth = _region_motion(full_res[0], full_res[1], full_res[2], scaled, (0.50, 0.92))
            upper = _region_motion(full_res[0], full_res[1], full_res[2], scaled, (0.08, 0.43))
        else:
            mouth = _region_motion(before, center, after, face, (0.50, 0.92))
            upper = _region_motion(before, center, after, face, (0.08, 0.43))
        # Head turns and camera motion move the entire face. Subtracting the
        # upper-face baseline keeps lip motion while rejecting rigid movement.
        activity = max(0.0, mouth - upper * 0.65)
        observations.append({
            "center_x": (x + width / 2) / max(1, frame_width),
            # Vertical position and apparent size, both normalised. Without
            # these the crop can only slide sideways across a full-height slice
            # of the source, which leaves a seated speaker's head jammed at the
            # top of the output with his chest filling the lower half, and
            # renders anyone in a wide shot too small to see.
            "center_y": (y + height / 2) / max(1, frame_height),
            "face_h": height / max(1, frame_height),
            "area": (width * height) / max(1, frame_width * frame_height),
            "confidence": confidence,
            "mouth_motion": mouth,
            "upper_motion": upper,
            "speech_activity": activity,
            "embedding": _face_embedding(recognizer, center, raw_row),
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


def _audio_envelope(video_path: Path, duration: float, step_s: float) -> "np.ndarray | None":
    """Loudness of the speech track, sampled on the same grid as the frames.

    Mouth pixels moving is not evidence of speech. A listener nods, chews, or
    turns their head and the mouth region changes just as much as a talker's,
    which is how a confidently-wrong face gets the crop. Speech is the one thing
    that must line up with the audio, so the envelope is what turns motion into
    evidence.
    """
    if duration <= 0 or step_s <= 0:
        return None
    rate = 16000
    try:
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(video_path), "-vn",
             "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
            capture_output=True, timeout=300,
        )
    except Exception:
        return None
    if raw.returncode != 0 or not raw.stdout:
        return None
    samples = np.frombuffer(raw.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if samples.size == 0:
        return None
    slots = max(1, int(round(duration / step_s)))
    per_slot = max(1, samples.size // slots)
    usable = samples[: slots * per_slot].reshape(slots, per_slot)
    envelope = np.sqrt(np.mean(np.square(usable), axis=1))
    # Silence carries no information about who is talking; comparing shapes
    # matters, not absolute level.
    spread = float(envelope.max() - envelope.min())
    if spread <= 1e-6:
        return None
    return (envelope - envelope.mean()) / (envelope.std() + 1e-9)


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
    recognizer = _face_recognizer()

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
            # Both sizes are kept: detection runs on the small copy because it
            # is cheap, but mouth motion is measured on the full frame. At 960px
            # a face in a wide two-shot is ~43px tall, leaving a mouth region of
            # ~17px whose "motion" is mostly sensor noise - which is exactly the
            # shot where the wrong host kept winning. Frames are pruned as soon
            # as their sample completes, so only a handful are ever resident.
            stored_frames[frame_index] = (
                cv2.resize(frame, (analysis_width, analysis_height), interpolation=cv2.INTER_AREA),
                frame.copy(),
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
                    "faces": _face_observations(
                        detector, before[0], center[0], after[0], recognizer,
                        (before[1], center[1], after[1]),
                    ),
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


#: Correlation below this is not evidence of speech. A talker's mouth tracks the
#: envelope strongly; a listener's incidental movement does not line up with it.
AUDIO_SYNC_MIN_CORRELATION = 0.22


def _audio_sync_score(
    track: dict[str, Any],
    envelope: "np.ndarray | None",
    step_s: float,
    start: float,
    end: float,
) -> float:
    """How well this face's mouth motion follows the speech envelope.

    This is the difference between "a mouth moved" and "a mouth moved *when
    speech happened*". Raw motion cannot tell a listener chewing from a host
    mid-sentence; correlation with the audio can, because only one of them is
    synchronised with the sound.

    Returns 0.0 when there is nothing to correlate, so the caller falls back to
    the motion-only behaviour rather than trusting a number built from noise.
    """
    if envelope is None or step_s <= 0:
        return 0.0
    pairs = []
    for item in track["items"]:
        if not (start <= item["time_s"] < end):
            continue
        index = int(round(item["time_s"] / step_s))
        if 0 <= index < envelope.size:
            pairs.append((float(envelope[index]), float(item["mouth_motion"])))
    if len(pairs) < 4:
        return 0.0
    audio = np.array([p[0] for p in pairs], dtype=np.float64)
    motion = np.array([p[1] for p in pairs], dtype=np.float64)
    if float(motion.std()) <= 1e-6 or float(audio.std()) <= 1e-6:
        return 0.0
    correlation = float(np.corrcoef(audio, motion)[0, 1])
    return correlation if math.isfinite(correlation) else 0.0


def track_by_index(tracks: list[dict[str, Any]], track_id: int) -> dict[str, Any]:
    return next(track for track in tracks if track["id"] == track_id)


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


def _track_identity(track: dict[str, Any]) -> "np.ndarray | None":
    """One averaged embedding for a track, so a single bad frame cannot define it."""
    vectors = [item["embedding"] for item in track["items"] if item.get("embedding") is not None]
    if not vectors:
        return None
    mean = np.mean(np.stack(vectors), axis=0)
    norm = float(np.linalg.norm(mean))
    return mean / norm if norm > 1e-6 else None


def _same_person(left: "np.ndarray | None", right: "np.ndarray | None") -> bool:
    if left is None or right is None:
        return False
    return float(np.dot(left, right)) >= IDENTITY_MATCH_THRESHOLD


def _track_center(track: dict[str, Any]) -> float:
    return _median([item["center_x"] for item in track["items"]])


def _track_vertical(track: dict[str, Any], items: list[dict[str, Any]] | None = None) -> tuple[float, float]:
    """Median vertical centre and apparent face height for a track.

    Medians rather than means: one frame where the detector clips a face to the
    eyebrows would otherwise pull the whole shot's framing upward.
    """
    source = items or track["items"]
    centers = [item.get("center_y") for item in source if item.get("center_y") is not None]
    heights = [item.get("face_h") for item in source if item.get("face_h") is not None]
    return (
        _median(centers) if centers else 0.5,
        _median(heights) if heights else 0.0,
    )


#: How close a track has to sit to the last proven speaker to count as the same
#: person continuing. Wider than detector jitter, tighter than the gap between
#: two people sharing a table.
CONTINUITY_MATCH_TOLERANCE = 0.12


def _fallback_track(
    tracks: list[dict[str, Any]],
    previous_center: float,
    confident_identity: "np.ndarray | None" = None,
    diarized_identity: "np.ndarray | None" = None,
) -> dict[str, Any]:
    """Choose one subject when this shot has no usable lip-motion evidence.

    Measured on three finished clips, roughly nine per cent of runtime lands
    here: several faces on screen and nothing to say which is talking. Ranking
    that by prominence alone picks whoever sits closest to the camera, so the
    frame settles on a listener while someone else speaks.

    Two better signals are used first when they exist. A face that the
    transcript's diarization places as the current speaker wins outright. So
    does the face we were last *confidently* on, because a shot with no new
    evidence is far more likely to be the same person still talking than a
    silent hand-off to the person beside them.
    """
    ranked = []
    for track in tracks:
        activities = [item["speech_activity"] for item in track["items"]]
        robust_activity = float(np.percentile(activities, 65)) if activities else 0.0
        proven_activity = robust_activity if robust_activity >= ACTIVE_SPEAKER_MIN_ACTIVITY else 0.0
        area = _median([item["area"] for item in track["items"]])
        coverage = len(track["items"])
        center = _track_center(track)
        identity = _track_identity(track)
        matches_diarized = _same_person(identity, diarized_identity)
        continues_confident = _same_person(identity, confident_identity)
        ranked.append((
            proven_activity,
            1 if matches_diarized else 0,
            1 if continues_confident else 0,
            area,
            coverage,
            -abs(center - previous_center),
            track,
        ))
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
    confident_identity: "np.ndarray | None" = None,
    diarized_identity: "np.ndarray | None" = None,
    envelope: "np.ndarray | None" = None,
    envelope_step_s: float = 0.0,
) -> list[dict[str, Any]]:
    tracks = _track_faces(observations)
    visible_tracks = [track for track in tracks if len(track["items"]) >= max(1, len(observations) // 3)]
    if not visible_tracks:
        return [{
            "start_s": start, "end_s": end, "layout": "crop",
            "center_x": round(max(0.0, min(1.0, previous_center)), 4),
            "center_y": 0.5, "face_h": 0.0,
            "reason": "no_stable_face_hold", "confidence": 0.0, "face_count": 0,
        }]
    if len(visible_tracks) == 1:
        track = visible_tracks[0]
        return [{
            "start_s": start, "end_s": end, "layout": "crop",
            "center_x": round(_track_center(track), 4),
            "center_y": round(_track_vertical(track)[0], 4),
            "face_h": round(_track_vertical(track)[1], 4),
            "reason": "single_visible_face", "confidence": 1.0, "face_count": 1,
        }]

    # Which face, across this whole shot, actually moves in time with the
    # speech. Motion alone repeatedly handed the crop to the wrong host with
    # full confidence; only one face can be synchronised with the sound.
    sync = {
        track["id"]: _audio_sync_score(track, envelope, envelope_step_s, start, end)
        for track in visible_tracks
    }
    ranked_sync = sorted(sync.values(), reverse=True)
    sync_leader = max(sync, key=sync.get) if sync else None
    sync_decides = (
        sync_leader is not None
        and ranked_sync[0] >= AUDIO_SYNC_MIN_CORRELATION
        and (len(ranked_sync) < 2 or ranked_sync[0] >= ranked_sync[1] + 0.10)
    )

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
        if sync_decides:
            # The audio says who is talking across this shot. A per-instant
            # motion spike on another face is noise against that, so it must not
            # be allowed to steal the frame.
            if confident and best_id != sync_leader:
                confident = False
            if not confident and _activity_at(track_by_index(visible_tracks, sync_leader), seconds) > 0:
                best_id, confident = sync_leader, True
        labels.append(best_id if confident else None)
        confidences.append(0.0 if not confident else min(1.0, (best_score - second_score) / max(best_score, 1e-6)))
    labels = _stabilize_label_runs(_collapse_labels(labels))

    fallback = _fallback_track(visible_tracks, previous_center, confident_identity, diarized_identity)
    fallback_id = fallback["id"]

    # If nobody wins for a sustained run, hold one stable best subject for the
    # entire camera angle. If even one run is proven, keep those speaker choices
    # and bridge the uncertain pauses below. The old coverage threshold threw
    # useful speech evidence away merely because a shot contained long pauses.
    if not any(label is not None for label in labels):
        return [{
            "start_s": start, "end_s": end, "layout": "crop",
            "center_x": round(_track_center(fallback), 4),
            "center_y": round(_track_vertical(fallback)[0], 4),
            "face_h": round(_track_vertical(fallback)[1], 4),
            "reason": (
                "diarized_speaker_hold" if _same_person(_track_identity(fallback), diarized_identity)
                else "confident_speaker_hold" if _same_person(_track_identity(fallback), confident_identity)
                else "ambiguous_stable_subject"
            ),
            "confidence": 0.0,
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
        reason = "audio_synced_speaker" if sync_decides else "active_speaker_motion"
        confidence = confidences[index]
        track = track_by_id[label]
        nearby_centers = [
            item["center_x"] for item in track["items"]
            if segment_start - ACTIVE_SPEAKER_WINDOW_S <= item["time_s"] <= segment_end + ACTIVE_SPEAKER_WINDOW_S
        ]
        nearby_items = [
            item for item in track["items"]
            if segment_start - ACTIVE_SPEAKER_WINDOW_S <= item["time_s"] <= segment_end + ACTIVE_SPEAKER_WINDOW_S
        ]
        center_x = round(_median(nearby_centers or [item["center_x"] for item in track["items"]]), 4)
        center_y, face_h = _track_vertical(track, nearby_items)
        candidate = {
            "start_s": segment_start, "end_s": segment_end, "layout": layout,
            "center_x": center_x,
            "center_y": round(center_y, 4), "face_h": round(face_h, 4),
            "reason": reason, "confidence": round(confidence, 3),
            "face_count": len(visible_tracks),
        }
        if segments and segments[-1]["layout"] == candidate["layout"]:
            if abs(segments[-1]["center_x"] - center_x) < 0.06:
                segments[-1]["end_s"] = segment_end
                segments[-1]["confidence"] = round(max(segments[-1]["confidence"], candidate["confidence"]), 3)
                continue
        segments.append(candidate)
    return [segment for segment in segments if segment["end_s"] - segment["start_s"] > 0.02]


def _dominant_speaker(start: float, end: float, diarization: list[dict[str, Any]]) -> str | None:
    overlap: dict[str, float] = {}
    for entry in diarization:
        label = entry.get("speaker")
        if not label:
            continue
        covered = min(end, entry["end_s"]) - max(start, entry["start_s"])
        if covered > 0:
            overlap[label] = overlap.get(label, 0.0) + covered
    return max(overlap, key=overlap.get) if overlap else None


#: Reasons that mean "we actually knew who was talking".
PROVEN_REASONS = {"audio_synced_speaker", "active_speaker_motion", "single_visible_face"}


def _diarized_identity_for(
    start: float,
    end: float,
    speaker_identities: dict[str, Any],
    diarization: list[dict[str, Any]],
) -> "np.ndarray | None":
    """Where the transcript says the current speaker sits, if that is known.

    Only useful once a speaker label has been seen on screen during a stretch
    we were sure about. On an episode whose diarization collapses every host
    into one label this returns nothing, which is the honest answer rather than
    a confident wrong one.
    """
    if not speaker_identities or not diarization:
        return None
    overlap: dict[str, float] = {}
    for entry in diarization:
        label = entry.get("speaker")
        if not label or label not in speaker_identities:
            continue
        covered = min(end, entry["end_s"]) - max(start, entry["start_s"])
        if covered > 0:
            overlap[label] = overlap.get(label, 0.0) + covered
    if not overlap:
        return None
    return speaker_identities[max(overlap, key=overlap.get)]


def _framing_plan(
    duration: float,
    cuts: list[float],
    observations: list[dict[str, Any]],
    diarization: list[dict[str, Any]] | None = None,
    envelope: "np.ndarray | None" = None,
    envelope_step_s: float = 0.0,
) -> list[dict[str, Any]]:
    segments = []
    previous_center = 0.5
    # Only updated from shots where we actually knew who was speaking. A guess
    # must not become the anchor that justifies the next guess.
    confident_identity = None
    speaker_identities: dict[str, Any] = {}
    for shot_index, (start, end) in enumerate(zip(cuts, cuts[1:])):
        shot_observations = [item for item in observations if start <= item["time_s"] < end]
        diarized_identity = _diarized_identity_for(start, end, speaker_identities, diarization or [])
        planned = _plan_shot_segments(
            start, end, shot_observations, previous_center, confident_identity, diarized_identity,
            envelope, envelope_step_s,
        )
        shot_tracks = _track_faces(shot_observations)
        for segment in planned:
            segment["shot_index"] = shot_index
            segment["transition"] = "shot_cut" if abs(segment["start_s"] - start) < 0.02 else "speaker_switch"
            segments.append(segment)
            if segment["reason"] in PROVEN_REASONS:
                # Remember who that was, not where they sat. The identity is
                # taken from the track nearest the chosen centre within this
                # shot, which is the face the crop actually framed.
                subject = min(
                    (t for t in shot_tracks if _track_identity(t) is not None),
                    key=lambda t: abs(_track_center(t) - float(segment["center_x"])),
                    default=None,
                )
                identity = _track_identity(subject) if subject is not None else None
                if identity is not None:
                    confident_identity = identity
                    # Learn each diarized speaker's face, but only from shots
                    # whose subject we were sure of.
                    label = _dominant_speaker(segment["start_s"], segment["end_s"], diarization or [])
                    if label:
                        speaker_identities[label] = identity
        if planned:
            previous_center = float(planned[-1]["center_x"])
    if not segments:
        return [{
            "start_s": 0.0, "end_s": duration, "layout": "crop", "center_x": 0.5,
            "center_y": 0.5, "face_h": 0.0,
            "reason": "no_timeline_evidence_center", "confidence": 0.0, "face_count": 0,
            "shot_index": 0, "transition": "shot_cut",
        }]
    segments[0]["start_s"] = 0.0
    segments[-1]["end_s"] = duration
    return segments


def _diarization_spans(samples: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    """Turn labelled instants into contiguous speaker spans.

    Each labelled sample owns the time until the next one, so a shot can ask
    which speaker covers most of it. Samples with no label are skipped rather
    than inheriting a neighbour's, since an unlabelled instant is not evidence.
    """
    labelled = sorted(
        (
            {"time_s": float(item.get("time_s") or 0.0), "speaker": str(item.get("speaker") or "").strip()}
            for item in samples
            if str(item.get("speaker") or "").strip()
        ),
        key=lambda item: item["time_s"],
    )
    spans = []
    for index, item in enumerate(labelled):
        end = labelled[index + 1]["time_s"] if index + 1 < len(labelled) else duration
        if end > item["time_s"]:
            spans.append({"speaker": item["speaker"], "start_s": item["time_s"], "end_s": end})
    return spans


def analyze(video_path: Path, samples: list[dict[str, Any]]) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("video could not be opened")
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    capture.release()

    duration, cuts, timeline = _timeline_observations(video_path)
    # Diarization arrives as one label per sampled instant. Turning it into
    # spans lets a shot ask who the transcript says is talking across it.
    diarization = _diarization_spans(samples, duration)
    envelope_step_s = TIMELINE_SAMPLE_INTERVAL_S
    envelope = _audio_envelope(video_path, duration, envelope_step_s)
    framing_segments = _framing_plan(
        duration, cuts, timeline, diarization, envelope, envelope_step_s,
    )
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
