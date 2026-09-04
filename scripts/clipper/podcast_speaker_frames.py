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
SPEAKER_MODEL_PATH = Path(__file__).with_name("models") / "speaker_embedding_campplus.onnx"
ACTIVE_SPEAKER_MODEL_PATH = Path(__file__).with_name("models") / "active_speaker_light_asd.onnx"
#: Light-ASD answers "is this visible face producing the current sound", which
#: is the only evidence that separates two co-hosts sharing a shot. Measured on
#: seven reference clips: it more than halves wrong-subject seconds where voice
#: identity and lip-motion correlation both fail. Thresholds sit in open space -
#: correct picks score 0.49-0.98 above the runner-up, so this is a gate against
#: noise rather than a tuned boundary.
ASD_MIN_PROBABILITY = 0.25
ASD_MIN_MARGIN = 0.12
ASD_FPS = 25.0
ASD_CROP_SCALE = 0.40
#: Two chunks of the same voice score ~0.7 and up; different people score below
#: ~0.3. The gap is wide, so the threshold sits in open space rather than being
#: tuned. Two co-hosts with similar voices land near it, which is why this is
#: used to tell the guest from the hosts and never to split one host from
#: another.
VOICE_MATCH_THRESHOLD = 0.45
VOICE_CHUNK_S = 1.5
VOICE_MIN_RMS = 0.02
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


def _voice_segments(video_path: Path, duration: float) -> list[dict[str, Any]]:
    """Who is speaking, from the audio itself.

    The transcript's diarization labels every segment of a three-person podcast
    as one speaker, so it cannot say who has the floor. This measures it
    directly: overlapping chunks of speech are embedded with a speaker model and
    grouped, giving spans that can be matched to faces.

    Returns an empty list when the model or its dependencies are unavailable, so
    a runner without them keeps the previous behaviour instead of failing.
    """
    if not SPEAKER_MODEL_PATH.exists():
        return []
    try:
        import onnxruntime as ort
    except Exception:
        return []
    try:
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(video_path), "-vn", "-ac", "1",
             "-ar", "16000", "-f", "s16le", "-"],
            capture_output=True, timeout=300,
        )
        if raw.returncode != 0 or not raw.stdout:
            return []
        audio = np.frombuffer(raw.stdout, dtype=np.int16).astype(np.float32) / 32768.0
        session = ort.InferenceSession(str(SPEAKER_MODEL_PATH), providers=["CPUExecutionProvider"])
    except Exception:
        return []

    rate = 16000
    window = int(VOICE_CHUNK_S * rate)
    embeddings: list[np.ndarray] = []
    times: list[float] = []
    for start in range(0, max(0, len(audio) - window), window // 2):
        chunk = audio[start:start + window]
        # Silence has no speaker; embedding it would invent one.
        if float(np.sqrt(np.mean(np.square(chunk)))) < VOICE_MIN_RMS:
            continue
        try:
            features = _log_mel(chunk, rate)
            vector = session.run(None, {"feats": features[None]})[0][0]
        except Exception:
            return []
        norm = float(np.linalg.norm(vector))
        if norm <= 1e-6:
            continue
        embeddings.append(vector / norm)
        times.append(start / rate)
    if len(embeddings) < 3:
        return []

    # Group by similarity: each chunk joins the closest voice it is near enough
    # to, or starts a new one. Averaging as it goes keeps a single loud chunk
    # from defining a speaker.
    voices: list[dict[str, Any]] = []
    for time_s, vector in zip(times, embeddings):
        best, best_score = None, 0.0
        for voice in voices:
            score = float(np.dot(vector, voice["centroid"]))
            if score > best_score:
                best, best_score = voice, score
        if best is not None and best_score >= VOICE_MATCH_THRESHOLD:
            best["vectors"].append(vector)
            centroid = np.mean(np.stack(best["vectors"]), axis=0)
            best["centroid"] = centroid / (np.linalg.norm(centroid) + 1e-9)
            best["spans"].append(time_s)
        else:
            voices.append({
                "id": f"VOICE_{len(voices):02d}", "centroid": vector,
                "vectors": [vector], "spans": [time_s],
            })

    segments = []
    for voice in voices:
        for start in voice["spans"]:
            segments.append({
                "speaker": voice["id"],
                "start_s": start,
                "end_s": min(duration, start + VOICE_CHUNK_S),
            })
    return sorted(segments, key=lambda item: item["start_s"])


_MEL_BANKS: dict[tuple, "np.ndarray"] = {}


def _mel_filterbank(rate: int, n_fft: int, n_mels: int, fmin: float, fmax: float) -> "np.ndarray":
    """Slaney-scale triangular mel filters, built once.

    Written out rather than imported so the analyzer needs only numpy. librosa
    would pull numba and llvmlite onto the render runner for this one matrix.
    """
    f_sp = 200.0 / 3.0
    min_log_hz, min_log_mel = 1000.0, 1000.0 / (200.0 / 3.0)
    logstep = np.log(6.4) / 27.0

    def to_mel(hz):
        hz = np.asarray(hz, dtype=np.float64)
        return np.where(hz < min_log_hz, hz / f_sp,
                        min_log_mel + np.log(np.maximum(hz, 1e-9) / min_log_hz) / logstep)

    def to_hz(mel):
        mel = np.asarray(mel, dtype=np.float64)
        return np.where(mel < min_log_mel, mel * f_sp,
                        min_log_hz * np.exp(logstep * (mel - min_log_mel)))

    fft_freqs = np.linspace(0.0, rate / 2.0, 1 + n_fft // 2)
    mel_f = to_hz(np.linspace(to_mel(fmin), to_mel(fmax), n_mels + 2))
    diff = np.diff(mel_f)
    ramps = mel_f[:, None] - fft_freqs[None, :]
    lower = -ramps[:-2] / diff[:-1, None]
    upper = ramps[2:] / diff[1:, None]
    weights = np.maximum(0.0, np.minimum(lower, upper))
    # Slaney normalisation: equal area per filter, so wide high-frequency bands
    # do not dominate the narrow low ones.
    weights *= (2.0 / (mel_f[2:n_mels + 2] - mel_f[:n_mels]))[:, None]
    return weights.astype(np.float32)


def _log_mel(chunk: "np.ndarray", rate: int) -> "np.ndarray":
    """80-band log-mel with per-utterance mean normalisation, as the model expects."""
    n_fft, hop, n_mels = 400, 160, 80
    key = (rate, n_fft, n_mels)
    bank = _MEL_BANKS.get(key)
    if bank is None:
        bank = _MEL_BANKS[key] = _mel_filterbank(rate, n_fft, n_mels, 20.0, 7600.0)
    padded = np.pad(chunk, n_fft // 2, mode="reflect")
    frame_count = 1 + (len(padded) - n_fft) // hop
    frames = np.lib.stride_tricks.as_strided(
        padded, shape=(frame_count, n_fft),
        strides=(padded.strides[0] * hop, padded.strides[0]),
    )
    window = np.hanning(n_fft + 1)[:n_fft].astype(np.float32)
    power = np.abs(np.fft.rfft(frames * window, n=n_fft)) ** 2
    features = np.log(power @ bank.T + 1e-6).astype(np.float32)
    return features - features.mean(axis=0, keepdims=True)


def _mel_filterbanks(nfilt: int, nfft: int, rate: int) -> "np.ndarray":
    """Triangular mel filters on the HTK scale, as the ASD model was trained with."""
    def hz2mel(hz): return 2595 * np.log10(1 + hz / 700.0)
    def mel2hz(mel): return 700 * (10 ** (mel / 2595.0) - 1)
    points = np.linspace(hz2mel(0), hz2mel(rate / 2), nfilt + 2)
    bins = np.floor((nfft + 1) * mel2hz(points) / rate)
    bank = np.zeros([nfilt, nfft // 2 + 1])
    for j in range(nfilt):
        for i in range(int(bins[j]), int(bins[j + 1])):
            bank[j, i] = (i - bins[j]) / (bins[j + 1] - bins[j])
        for i in range(int(bins[j + 1]), int(bins[j + 2])):
            bank[j, i] = (bins[j + 2] - i) / (bins[j + 2] - bins[j + 1])
    return bank


def _mfcc(signal: "np.ndarray", rate: int = 16000, numcep: int = 13) -> "np.ndarray":
    """13-cepstra MFCC at 100fps, matching the ASD model's training front end.

    Written out rather than imported: the reference implementation is a third
    dependency on the render runner for one array. Verified to 7.4e-13 against
    python_speech_features on the same input.
    """
    winlen, winstep, nfilt, nfft, preemph, ceplifter = 0.025, 0.010, 26, 512, 0.97, 22
    signal = np.append(signal[0], signal[1:] - preemph * signal[:-1])
    flen, fstep = int(round(winlen * rate)), int(round(winstep * rate))
    frames_n = 1 if len(signal) <= flen else 1 + int(math.ceil((len(signal) - flen) / fstep))
    padded = np.concatenate([signal, np.zeros((frames_n - 1) * fstep + flen - len(signal))])
    index = (np.tile(np.arange(flen), (frames_n, 1))
             + np.tile(np.arange(0, frames_n * fstep, fstep), (flen, 1)).T)
    frames = padded[index.astype(np.int32)]
    power = 1.0 / nfft * np.square(np.absolute(np.fft.rfft(frames, nfft)))
    energy = np.where(np.sum(power, 1) == 0, np.finfo(float).eps, np.sum(power, 1))
    feature = np.dot(power, _mel_filterbanks(nfilt, nfft, rate).T)
    feature = np.log(np.where(feature == 0, np.finfo(float).eps, feature))
    # Orthonormal DCT-II.
    bands = feature.shape[1]
    k = np.arange(numcep)[:, None]
    m = np.arange(bands)[None, :]
    basis = np.cos(np.pi * k * (2 * m + 1) / (2 * bands))
    scale = np.full((numcep, 1), math.sqrt(2.0 / bands))
    scale[0] = math.sqrt(1.0 / bands)
    feature = feature @ (basis * scale).T
    lift = 1 + (ceplifter / 2.0) * np.sin(np.pi * np.arange(numcep) / ceplifter)
    feature = lift * feature
    feature[:, 0] = np.log(energy)
    return feature.astype(np.float32)


def _active_speaker_session():
    """Load the vendored active-speaker model, or fail loudly.

    This is production machinery, not an optional enhancement: without it two
    co-hosts sharing a shot cannot be told apart at all, and the framing would
    silently return to picking one of them for the whole shot. A missing model
    or runtime must stop the render rather than quietly produce worse video.
    """
    if not ACTIVE_SPEAKER_MODEL_PATH.exists():
        raise RuntimeError(
            f"active-speaker model missing at {ACTIVE_SPEAKER_MODEL_PATH}; "
            "podcast framing cannot separate co-hosts without it")
    try:
        import onnxruntime as ort
    except Exception as error:
        raise RuntimeError(
            "onnxruntime is required for podcast active-speaker framing") from error
    return ort.InferenceSession(str(ACTIVE_SPEAKER_MODEL_PATH),
                                providers=["CPUExecutionProvider"])


def _asd_track_scores(
    video_path: Path,
    duration: float,
    windows: list[tuple[float, float]],
    tracks_by_window: list[list[dict[str, Any]]],
) -> dict[int, "np.ndarray"]:
    """P(speaking) per track on a 25fps grid, for multi-face stretches only.

    Only shots with more than one visible face need this; a lone face is already
    unambiguous and scoring it would roughly quadruple the analysis cost for no
    decision. Returns an empty mapping when there is nothing to score.
    """
    if not windows:
        return {}
    session = _active_speaker_session()
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video_path), "-vn", "-ac", "1",
         "-ar", "16000", "-f", "s16le", "-"], capture_output=True, timeout=600)
    if raw.returncode != 0 or not raw.stdout:
        raise RuntimeError("could not decode audio for active-speaker scoring")
    audio = np.frombuffer(raw.stdout, dtype=np.int16).astype(np.float32)
    features = _mfcc(audio)

    capture = cv2.VideoCapture(str(video_path))
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 25.0)
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    total_frames = int(round(duration * ASD_FPS))

    # Which 25fps slots each track needs a crop for.
    wanted: dict[int, int] = {}
    for slot in range(total_frames):
        wanted[int(round(slot / ASD_FPS * source_fps))] = slot
    crops: dict[int, np.ndarray] = {}
    present: dict[int, np.ndarray] = {}
    positions: dict[int, list[tuple[float, dict[str, Any]]]] = {}
    for (start, end), tracks in zip(windows, tracks_by_window):
        for track in tracks:
            positions.setdefault(track["id"], []).extend(
                (item["time_s"], item) for item in track["items"])
    for track_id in positions:
        crops[track_id] = np.zeros((total_frames, 112, 112), dtype=np.float32)
        present[track_id] = np.zeros(total_frames, dtype=bool)

    scored_slots = set()
    for start, end in windows:
        for slot in range(max(0, int(start * ASD_FPS)), min(total_frames, int(end * ASD_FPS) + 1)):
            scored_slots.add(slot)

    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        slot = wanted.get(index)
        index += 1
        if slot is None or slot not in scored_slots:
            continue
        seconds = slot / ASD_FPS
        for track_id, items in positions.items():
            nearest = min(items, key=lambda item: abs(item[0] - seconds))
            if abs(nearest[0] - seconds) > 0.6:
                continue
            observation = nearest[1]
            centre_x = observation["center_x"] * frame_width
            centre_y = observation.get("center_y", 0.5) * frame_height
            face_h = max(observation.get("face_h", 0.0), 0.02) * frame_height
            half = face_h * (1 + ASD_CROP_SCALE) / 2
            x0, x1 = int(max(0, centre_x - half)), int(min(frame_width, centre_x + half))
            y0, y1 = int(max(0, centre_y - half)), int(min(frame_height, centre_y + half))
            if x1 - x0 < 8 or y1 - y0 < 8:
                continue
            face = cv2.resize(cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY), (224, 224))
            crops[track_id][slot] = face[56:168, 56:168].astype(np.float32)
            present[track_id][slot] = True
    capture.release()

    audio_len = total_frames * 4
    window_features = features[:audio_len]
    if len(window_features) < audio_len:
        window_features = np.pad(window_features, ((0, audio_len - len(window_features)), (0, 0)))
    scores: dict[int, np.ndarray] = {}
    for track_id in crops:
        if not present[track_id].any():
            continue
        output = session.run(None, {
            "audio": window_features[None].astype(np.float32),
            "visual": crops[track_id][None],
        })[0]
        values = np.asarray(output, dtype=np.float64).reshape(-1)[:total_frames]
        values[~present[track_id]] = np.nan
        scores[track_id] = values
    return scores


def _asd_at(scores: "np.ndarray | None", start: float, end: float) -> float:
    """Mean P(speaking) across an interval, ignoring frames with no face."""
    if scores is None:
        return float("nan")
    lo, hi = int(start * ASD_FPS), max(int(start * ASD_FPS) + 1, int(end * ASD_FPS))
    window = scores[lo:hi]
    window = window[~np.isnan(window)]
    return float(np.mean(window)) if window.size >= 2 else float("nan")


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


def _fill_uncertain_labels(
    labels: list[int | None],
    fallback_id: int,
    lead_in_id: int | None = None,
) -> list[int]:
    """Hold a proven subject through pauses; never flash to another layout.

    The opening of a shot is filled separately from the rest. Back-filling it
    with the first proven label points the crop at whoever speaks *next*, which
    is why a cut could land on a silent face over a second before they open
    their mouth: the camera cuts to a two-shot while the previous speaker is
    still finishing off-screen, and the frame commits to the upcoming one
    immediately. The lead-in instead holds whoever the shot should already be
    on - the speaker we were last confident about, if they are visible here -
    and only moves once someone actually starts.
    """
    filled: list[int] = []
    last = fallback_id
    for label in labels:
        if label is not None:
            last = label
        filled.append(last)
    opening = lead_in_id if lead_in_id is not None else next(
        (label for label in labels if label is not None), fallback_id
    )
    for index, label in enumerate(labels):
        if label is not None:
            break
        filled[index] = opening
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
    asd_scores: dict[int, "np.ndarray"] | None = None,
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
    # Per-instant active-speaker evidence. Unlike the shot-wide correlation
    # above, this can change inside a held shot, which is the only way two
    # co-hosts sharing one camera angle can ever be told apart.
    asd_labels: dict[float, int | None] = {}
    asd_detail: dict[float, tuple[float, float]] = {}
    if asd_scores:
        step = TIMELINE_SAMPLE_INTERVAL_S
        for seconds in times:
            ranked = []
            for track in visible_tracks:
                value = _asd_at(asd_scores.get(track["id"]), seconds, seconds + step)
                if not math.isnan(value):
                    ranked.append((value, track["id"]))
            if not ranked:
                continue
            ranked.sort(reverse=True)
            best_value, best_track = ranked[0]
            runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
            asd_detail[seconds] = (best_value, best_value - runner_up)
            if best_value >= ASD_MIN_PROBABILITY and (best_value - runner_up) >= ASD_MIN_MARGIN:
                asd_labels[seconds] = best_track

    labels: list[int | None] = []
    confidences: list[float] = []
    for seconds in times:
        decided = asd_labels.get(seconds)
        if decided is not None:
            labels.append(decided)
            confidences.append(min(1.0, asd_detail[seconds][1]))
            continue
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

    # Who the shot should open on before anybody speaks: the person we were
    # last confident about if this shot contains them, otherwise the subject
    # prominence already chose. Never the speaker who has not started yet.
    lead_in_track = next(
        (track for track in visible_tracks if _same_person(_track_identity(track), confident_identity)),
        None,
    )
    labels = _fill_uncertain_labels(
        labels, fallback_id, lead_in_track["id"] if lead_in_track else fallback_id,
    )

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
        # A decision the model actually made must not be reported under a
        # heuristic's name, and a heuristic must not borrow the model's.
        decided_by_model = times[index] in asd_labels and asd_labels[times[index]] == label
        reason = ("audiovisual_active_speaker" if decided_by_model
                  else "audio_synced_speaker" if sync_decides
                  else "active_speaker_motion")
        confidence = confidences[index]
        probability, margin = asd_detail.get(times[index], (float("nan"), float("nan")))
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
        # Provenance for every future bad pick: what the model thought of each
        # face, and whether it or a fallback settled the frame.
        if not math.isnan(probability):
            candidate["asd_probability"] = round(probability, 4)
            candidate["asd_margin"] = round(margin, 4)
            candidate["asd_model"] = ACTIVE_SPEAKER_MODEL_PATH.name
        if not decided_by_model and asd_scores:
            candidate["asd_abstained"] = True
        # Which evidence actually held the frame, by duration, so a merged run
        # is reported under whatever settled most of it.
        candidate["_reason_s"] = {reason: segment_end - segment_start}
        if segments and segments[-1]["layout"] == candidate["layout"]:
            if abs(segments[-1]["center_x"] - center_x) < 0.06:
                # Same subject, so this is one continuous run. Splitting it
                # because the evidence changed mid-run would manufacture
                # sub-second segments out of a frame that never moved.
                previous = segments[-1]
                previous["_reason_s"][candidate["reason"]] = (
                    previous["_reason_s"].get(candidate["reason"], 0.0)
                    + segment_end - segment_start)
                previous["end_s"] = segment_end
                previous["confidence"] = round(max(previous["confidence"], candidate["confidence"]), 3)
                if candidate.get("asd_probability") is not None and (
                        previous.get("asd_probability") is None
                        or candidate["asd_probability"] > previous["asd_probability"]):
                    previous["asd_probability"] = candidate["asd_probability"]
                    previous["asd_margin"] = candidate["asd_margin"]
                    previous["asd_model"] = candidate["asd_model"]
                continue
        segments.append(candidate)
    for segment in segments:
        spans = segment.pop("_reason_s", None)
        if spans:
            segment["reason"] = max(spans, key=spans.get)
            if segment["reason"] != "audiovisual_active_speaker":
                segment.pop("asd_probability", None)
                segment.pop("asd_margin", None)
                segment.pop("asd_model", None)
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
#: Which segments may teach a voice label whose face it is. Deliberately
#: narrower than PROVEN_REASONS: only shots settled without diarization's help,
#: where the face is unambiguous. Learning from a diarization-influenced choice
#: is self-fulfilling -- the label steers the crop onto one person, and that
#: same crop is then read back as proof the label belongs to them, so a voice
#: cluster covering two people can never be caught covering two people.
VOICE_LEARNING_REASONS = {"single_visible_face", "audio_synced_speaker"}


def _diarized_identity_for(
    start: float,
    end: float,
    speaker_identities: dict[str, Any],
    diarization: list[dict[str, Any]],
) -> "np.ndarray | None":
    """Where the current speaker sits, if that is known.

    Only useful once a speaker label has been seen on screen during a stretch
    we were sure about, and only while that label has pointed at exactly one
    face. A label seen on two different faces is a merged cluster -- two voices
    the model could not tell apart -- and answering from it would override real
    per-moment evidence with a coin flip. Such labels are skipped, which is the
    honest answer rather than a confident wrong one.
    """
    if not speaker_identities or not diarization:
        return None
    overlap: dict[str, float] = {}
    for entry in diarization:
        label = entry.get("speaker")
        if not label or len(speaker_identities.get(label, ())) != 1:
            continue
        covered = min(end, entry["end_s"]) - max(start, entry["start_s"])
        if covered > 0:
            overlap[label] = overlap.get(label, 0.0) + covered
    if not overlap:
        return None
    return speaker_identities[max(overlap, key=overlap.get)][0]


def _framing_plan(
    duration: float,
    cuts: list[float],
    observations: list[dict[str, Any]],
    diarization: list[dict[str, Any]] | None = None,
    envelope: "np.ndarray | None" = None,
    envelope_step_s: float = 0.0,
    asd_scores: dict[int, "np.ndarray"] | None = None,
) -> list[dict[str, Any]]:
    segments = []
    previous_center = 0.5
    # Only updated from shots where we actually knew who was speaking. A guess
    # must not become the anchor that justifies the next guess.
    confident_identity = None
    # label -> the distinct faces it has been seen on. More than one means the
    # voice model merged two people; see _diarized_identity_for.
    speaker_identities: dict[str, list[Any]] = {}
    for shot_index, (start, end) in enumerate(zip(cuts, cuts[1:])):
        shot_observations = [item for item in observations if start <= item["time_s"] < end]
        diarized_identity = _diarized_identity_for(start, end, speaker_identities, diarization or [])
        planned = _plan_shot_segments(
            start, end, shot_observations, previous_center, confident_identity, diarized_identity,
            envelope, envelope_step_s, asd_scores,
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
                    # Learn each speaker's face, but only where the shot was
                    # settled without diarization's help. See
                    # VOICE_LEARNING_REASONS.
                    if segment["reason"] in VOICE_LEARNING_REASONS:
                        label = _dominant_speaker(
                            segment["start_s"], segment["end_s"], diarization or [])
                        if label:
                            seen = speaker_identities.setdefault(label, [])
                            if not any(_same_person(identity, known) for known in seen):
                                seen.append(identity)
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
    # Measured voice spans beat the transcript's labels, which collapse every
    # speaker on this material into one. Fall back to the transcript when the
    # speaker model is unavailable.
    diarization = _voice_segments(video_path, duration) or _diarization_spans(samples, duration)
    envelope_step_s = TIMELINE_SAMPLE_INTERVAL_S
    envelope = _audio_envelope(video_path, duration, envelope_step_s)

    # Active-speaker scoring is only run where a decision actually exists: shots
    # showing more than one face. On this material that is under a quarter of
    # runtime, so the cost lands where it changes the frame.
    contested: list[tuple[float, float]] = []
    contested_tracks: list[list[dict[str, Any]]] = []
    for shot_start, shot_end in zip(cuts, cuts[1:]):
        shot_observations = [item for item in timeline if shot_start <= item["time_s"] < shot_end]
        if not shot_observations:
            continue
        tracks = _track_faces(shot_observations)
        visible = [t for t in tracks if len(t["items"]) >= max(1, len(shot_observations) // 3)]
        if len(visible) >= 2:
            contested.append((shot_start, shot_end))
            contested_tracks.append(visible)
    asd_scores = _asd_track_scores(video_path, duration, contested, contested_tracks)

    framing_segments = _framing_plan(
        duration, cuts, timeline, diarization, envelope, envelope_step_s, asd_scores,
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
