#!/usr/bin/env python3
"""Deterministic, dependency-light acoustic speaker clustering for Podcast V3.

This is the always-available diarization path. It intentionally uses only the
NumPy/librosa stack already required for Podcast prosody, so transcript ingest
does not depend on a model-gated credential.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


MIN_SPEAKERS = 1
MAX_SPEAKERS = 4
MAX_FEATURE_UNITS = 2400
MAX_CLUSTER_UNITS = 600
MIN_SEGMENT_S = 0.40
MAX_SAMPLE_S = 4.0


@dataclass(frozen=True)
class ClusterResult:
    labels: np.ndarray
    speaker_count: int
    metadata: dict[str, Any]


def _even_indices(size: int, limit: int) -> np.ndarray:
    if size <= limit:
        return np.arange(size, dtype=np.int64)
    # linspace is deterministic and keeps evidence from the full episode rather
    # than overrepresenting the opening conversation.
    return np.unique(np.linspace(0, size - 1, num=limit, dtype=np.int64))


def _standardize(training: np.ndarray, values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    median = np.median(training, axis=0)
    q25, q75 = np.percentile(training, [25, 75], axis=0)
    scale = q75 - q25
    standard_deviation = np.std(training, axis=0)
    scale = np.where(scale > 1e-6, scale, standard_deviation)
    scale = np.where(scale > 1e-6, scale, 1.0)
    return (
        np.clip((training - median) / scale, -8.0, 8.0),
        np.clip((values - median) / scale, -8.0, 8.0),
    )


def _initial_centroids(values: np.ndarray, count: int) -> np.ndarray:
    center = np.mean(values, axis=0)
    first = int(np.argmax(np.sum(np.square(values - center), axis=1)))
    chosen = [first]
    nearest = np.sum(np.square(values - values[first]), axis=1)
    while len(chosen) < count:
        candidate = int(np.argmax(nearest))
        if candidate in chosen:
            candidate = next(index for index in range(values.shape[0]) if index not in chosen)
        chosen.append(candidate)
        distance = np.sum(np.square(values - values[candidate]), axis=1)
        nearest = np.minimum(nearest, distance)
    return values[np.asarray(chosen, dtype=np.int64)].copy()


def _fit_kmeans(values: np.ndarray, weights: np.ndarray, count: int) -> tuple[np.ndarray, np.ndarray]:
    centroids = _initial_centroids(values, count)
    labels = np.zeros(values.shape[0], dtype=np.int64)
    for _ in range(60):
        distances = np.sum(np.square(values[:, None, :] - centroids[None, :, :]), axis=2)
        next_labels = np.argmin(distances, axis=1)
        # Farthest-point initialization normally prevents empty clusters, but
        # repair them deterministically if two centroids converge.
        counts = np.bincount(next_labels, minlength=count)
        for cluster in range(count):
            if counts[cluster] > 0:
                continue
            nearest = distances[np.arange(values.shape[0]), next_labels]
            nearest[counts[next_labels] <= 1] = -np.inf
            replacement = int(np.argmax(nearest))
            donor = int(next_labels[replacement])
            next_labels[replacement] = cluster
            counts[donor] -= 1
            counts[cluster] += 1

        next_centroids = []
        for cluster in range(count):
            mask = next_labels == cluster
            next_centroids.append(np.average(values[mask], axis=0, weights=weights[mask]))
        updated = np.asarray(next_centroids, dtype=np.float64)
        if np.array_equal(next_labels, labels) and np.allclose(updated, centroids, atol=1e-7, rtol=0):
            labels = next_labels
            centroids = updated
            break
        labels = next_labels
        centroids = updated
    return labels, centroids


def _cluster_quality(
    values: np.ndarray,
    weights: np.ndarray,
    labels: np.ndarray,
    centroids: np.ndarray,
) -> dict[str, float]:
    own = np.sqrt(np.sum(np.square(values - centroids[labels]), axis=1))
    all_distances = np.sqrt(np.sum(np.square(values[:, None, :] - centroids[None, :, :]), axis=2))
    all_distances[np.arange(values.shape[0]), labels] = np.inf
    other = np.min(all_distances, axis=1)
    silhouette = np.divide(
        other - own,
        np.maximum(other, own),
        out=np.zeros_like(own),
        where=np.maximum(other, own) > 1e-9,
    )
    total_weight = float(np.sum(weights))
    fractions = [float(np.sum(weights[labels == cluster]) / total_weight) for cluster in range(centroids.shape[0])]
    counts = [int(np.sum(labels == cluster)) for cluster in range(centroids.shape[0])]
    pairwise = np.sqrt(np.sum(np.square(centroids[:, None, :] - centroids[None, :, :]), axis=2))
    pairwise[pairwise == 0] = np.inf
    within_rms = float(np.sqrt(np.average(np.square(own), weights=weights)))
    separation = float(np.min(pairwise) / max(within_rms, 1e-9))
    return {
        "silhouette": float(np.average(silhouette, weights=weights)),
        "min_cluster_fraction": min(fractions),
        "min_cluster_units": float(min(counts)),
        "separation": separation,
    }


def cluster_acoustic_embeddings(
    features: np.ndarray,
    weights: np.ndarray | None = None,
    max_speakers: int = MAX_SPEAKERS,
) -> ClusterResult:
    """Cluster acoustic embeddings without randomness or external models."""
    values = np.asarray(features, dtype=np.float64)
    if values.ndim != 2 or values.shape[0] < 1 or values.shape[1] < 1:
        raise ValueError("features must be a non-empty two-dimensional array")
    if not np.isfinite(values).all():
        raise ValueError("features contain non-finite values")
    sample_weights = np.ones(values.shape[0], dtype=np.float64) if weights is None else np.asarray(weights, dtype=np.float64)
    if sample_weights.shape != (values.shape[0],) or not np.isfinite(sample_weights).all() or np.any(sample_weights <= 0):
        raise ValueError("weights must be finite positive values matching features")

    training_indices = _even_indices(values.shape[0], MAX_CLUSTER_UNITS)
    training, standardized = _standardize(values[training_indices], values)
    training_weights = sample_weights[training_indices]
    maximum = max(MIN_SPEAKERS, min(MAX_SPEAKERS, int(max_speakers), training.shape[0] // 3))
    candidates: list[dict[str, Any]] = [{
        "speaker_count": 1,
        "silhouette": 0.0,
        "separation": 0.0,
        "min_cluster_fraction": 1.0,
        "min_cluster_units": float(training.shape[0]),
        "selection_score": 0.0,
    }]
    selected_count = 1
    selected_score = 0.0
    selected_centroids = np.asarray([np.average(training, axis=0, weights=training_weights)])

    for count in range(2, maximum + 1):
        labels, centroids = _fit_kmeans(training, training_weights, count)
        quality = _cluster_quality(training, training_weights, labels, centroids)
        # The penalty resists inventing speakers from phonetic variation in one
        # voice. Strong, balanced acoustic groups still clear it comfortably.
        score = quality["silhouette"] - 0.055 * (count - 1)
        eligible = (
            quality["silhouette"] >= 0.38
            and quality["separation"] >= 1.35
            and quality["min_cluster_fraction"] >= 0.06
            and quality["min_cluster_units"] >= 3
        )
        candidate = {
            "speaker_count": count,
            **quality,
            "selection_score": score,
            "eligible": eligible,
        }
        candidates.append(candidate)
        if eligible and score > selected_score + 0.025:
            selected_count = count
            selected_score = score
            selected_centroids = centroids

    distances = np.sum(np.square(standardized[:, None, :] - selected_centroids[None, :, :]), axis=2)
    labels = np.argmin(distances, axis=1).astype(np.int64)
    return ClusterResult(
        labels=labels,
        speaker_count=selected_count,
        metadata={
            "speaker_bounds": [MIN_SPEAKERS, MAX_SPEAKERS],
            "training_units": int(training.shape[0]),
            "feature_dimension": int(values.shape[1]),
            "selected_speakers": selected_count,
            "selection_score": round(float(selected_score), 6),
            "candidates": [{
                key: round(float(value), 6) if isinstance(value, (float, np.floating)) else value
                for key, value in candidate.items()
            } for candidate in candidates],
        },
    )


def _segment_embedding(samples: np.ndarray, sample_rate: int) -> np.ndarray | None:
    import librosa

    if samples.size < int(sample_rate * MIN_SEGMENT_S):
        return None
    samples = np.asarray(samples, dtype=np.float32)
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(np.square(samples))))
    if not np.isfinite(rms) or rms < 1e-5 or peak < 1e-4:
        return None
    normalized = samples / max(peak, 1e-6)
    mfcc = librosa.feature.mfcc(
        y=normalized,
        sr=sample_rate,
        n_mfcc=13,
        n_fft=512,
        hop_length=160,
        n_mels=40,
        fmin=60,
        fmax=min(7600, sample_rate // 2),
    )
    if mfcc.shape[1] < 2 or not np.isfinite(mfcc).all():
        return None
    # Exclude coefficient zero (mostly loudness); vocal-tract shape is carried by
    # the remaining cepstral coefficients. Median and IQR reduce sensitivity to
    # a particular word or transient inside the Whisper segment.
    voice = mfcc[1:13]
    median = np.median(voice, axis=1)
    spread = np.percentile(voice, 75, axis=1) - np.percentile(voice, 25, axis=1)
    delta = np.diff(voice, axis=1)
    movement = np.median(np.abs(delta), axis=1) if delta.size else np.zeros(voice.shape[0])
    return np.concatenate([median, spread, movement]).astype(np.float64)


def _extract_embeddings(
    audio: np.ndarray,
    sample_rate: int,
    segments: list[dict[str, Any]],
) -> tuple[list[int], np.ndarray, np.ndarray]:
    candidates = [index for index, segment in enumerate(segments)
                  if float(segment.get("end_s", 0)) - float(segment.get("start_s", 0)) >= MIN_SEGMENT_S]
    chosen_positions = _even_indices(len(candidates), MAX_FEATURE_UNITS)
    selected_indices: list[int] = []
    features: list[np.ndarray] = []
    weights: list[float] = []
    for position in chosen_positions:
        index = candidates[int(position)]
        segment = segments[index]
        start = max(0.0, float(segment.get("start_s", 0)))
        end = max(start, float(segment.get("end_s", start)))
        if end - start > MAX_SAMPLE_S:
            midpoint = (start + end) / 2
            start, end = midpoint - MAX_SAMPLE_S / 2, midpoint + MAX_SAMPLE_S / 2
        left = max(0, int(start * sample_rate))
        right = min(audio.size, int(end * sample_rate))
        embedding = _segment_embedding(audio[left:right], sample_rate)
        if embedding is None:
            continue
        selected_indices.append(index)
        features.append(embedding)
        weights.append(max(0.5, min(MAX_SAMPLE_S, end - start)))
    if not features:
        return [], np.empty((0, 36), dtype=np.float64), np.empty((0,), dtype=np.float64)
    return selected_indices, np.vstack(features), np.asarray(weights, dtype=np.float64)


def turns_from_segment_labels(
    segments: list[dict[str, Any]],
    evidence_indices: list[int],
    evidence_labels: np.ndarray,
) -> list[dict[str, Any]]:
    if not segments:
        return []
    if not evidence_indices:
        evidence_indices = [0]
        evidence_labels = np.zeros(1, dtype=np.int64)

    # Stable public names follow first appearance rather than arbitrary centroid
    # ordering, so rerunning the same artifact yields the same SPEAKER_XX labels.
    first_seen: dict[int, int] = {}
    for index, label in zip(evidence_indices, evidence_labels.tolist()):
        first_seen.setdefault(int(label), index)
    ordered = sorted(first_seen, key=lambda label: (first_seen[label], label))
    public_label = {label: f"SPEAKER_{position:02d}" for position, label in enumerate(ordered)}

    evidence_midpoints = np.asarray([
        (float(segments[index].get("start_s", 0)) + float(segments[index].get("end_s", 0))) / 2
        for index in evidence_indices
    ], dtype=np.float64)
    assigned: list[str] = []
    for segment in segments:
        midpoint = (float(segment.get("start_s", 0)) + float(segment.get("end_s", 0))) / 2
        insertion = int(np.searchsorted(evidence_midpoints, midpoint))
        neighbors = [max(0, insertion - 1), min(len(evidence_indices) - 1, insertion)]
        nearest = min(neighbors, key=lambda position: (abs(float(evidence_midpoints[position]) - midpoint), position))
        assigned.append(public_label[int(evidence_labels[nearest])])

    turns: list[dict[str, Any]] = []
    for segment, speaker in zip(segments, assigned):
        start = max(0.0, float(segment.get("start_s", 0)))
        end = max(start, float(segment.get("end_s", start)))
        if end <= start:
            continue
        if turns and turns[-1]["speaker"] == speaker and start - float(turns[-1]["end_s"]) <= 0.35:
            turns[-1]["end_s"] = round(max(float(turns[-1]["end_s"]), end), 3)
        else:
            turns.append({"start_s": round(start, 3), "end_s": round(end, 3), "speaker": speaker})
    return turns


def local_acoustic_diarize(
    wav: Path,
    segments: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    import librosa

    audio, sample_rate = librosa.load(str(wav), sr=16000, mono=True)
    evidence_indices, features, weights = _extract_embeddings(audio, sample_rate, segments)
    if features.shape[0] >= 1:
        clustered = cluster_acoustic_embeddings(features, weights, max_speakers=MAX_SPEAKERS)
        labels = clustered.labels
        selection = clustered.metadata
        speaker_count = clustered.speaker_count
    else:
        labels = np.zeros(max(1, len(evidence_indices)), dtype=np.int64)
        selection = {
            "speaker_bounds": [MIN_SPEAKERS, MAX_SPEAKERS],
            "training_units": 0,
            "feature_dimension": 36,
            "selected_speakers": 1,
            "selection_score": 0.0,
            "candidates": [],
            "reason": "No transcript segment had enough finite voiced audio for clustering",
        }
        speaker_count = 1
    turns = turns_from_segment_labels(segments, evidence_indices, labels)
    return turns, {
        "status": "completed",
        "method": "local_acoustic_clustering",
        "model": "librosa-mfcc-deterministic-kmeans-v1",
        "deterministic": True,
        "credential_required": False,
        "speaker_count": int(speaker_count),
        "speaker_bounds": [MIN_SPEAKERS, MAX_SPEAKERS],
        "turn_count": len(turns),
        "analysis_unit_count": len(evidence_indices),
        "transcript_segment_count": len(segments),
        "analysis_coverage": round(len(evidence_indices) / max(1, len(segments)), 6),
        "analysis_unit_cap": MAX_FEATURE_UNITS,
        "overlap_detection": False,
        "selection": selection,
    }
