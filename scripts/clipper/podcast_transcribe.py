#!/usr/bin/env python3
"""Claim one CLIPPER podcast, create an immutable transcript artifact, and invoke Scout."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import tempfile
import traceback
from typing import Any, Optional

import librosa
import numpy as np
import requests
from faster_whisper import WhisperModel
from podcast_audio_source import download_podcast_audio
from podcast_diarization import local_acoustic_diarize
from podcast_recovery_artifact import persist_recovery_artifact
from podcast_source_cache import download_source_cache, upload_source_cache, validate_source_cache
from podcast_storage_contract import assert_storage_project


BUCKET = "clipper-media"
MAX_ALIGNMENT_BYTES = 512 * 1024 * 1024
WORKER_RUN_ID = "-".join(filter(None, [
    os.getenv("GITHUB_RUN_ID") or f"local-{os.getpid()}",
    os.getenv("GITHUB_RUN_ATTEMPT") or "1",
]))


def api(base_url: str, secret: str, path: str, payload: dict[str, Any], timeout: int = 300) -> dict[str, Any]:
    response = requests.post(
        f"{base_url.rstrip('/')}{path}",
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
        json=payload,
        timeout=timeout,
    )
    if not response.ok:
        raise RuntimeError(f"{path} HTTP {response.status_code}: {response.text[:1000]}")
    return response.json()


def progress(
    base_url: str,
    secret: str,
    vod_id: str,
    stage: str,
    message: str = "",
    error: str = "",
    source_cache: Optional[dict[str, Any]] = None,
) -> None:
    try:
        payload: dict[str, Any] = {
            "vod_id": vod_id, "stage": stage, "message": message, "error": error,
            "worker_run_id": WORKER_RUN_ID,
        }
        if source_cache is not None:
            payload["source_cache"] = source_cache
        api(base_url, secret, "/api/clipper/podcast/progress", payload, timeout=30)
    except Exception as exc:
        # Cache registration is a retry contract, not cosmetic progress. Fail
        # before Whisper if the control plane did not persist it.
        if source_cache is not None:
            raise
        # Ordinary progress must never hide the original worker failure.
        print(f"progress warning: {exc}", flush=True)


def upload_artifact(storage_url: str, storage_key: str, object_path: str, payload: bytes) -> None:
    encoded = "/".join(requests.utils.quote(part, safe="") for part in object_path.split("/"))
    response = requests.post(
        f"{storage_url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}",
        headers={
            "Authorization": f"Bearer {storage_key}",
            "apikey": storage_key,
            "x-upsert": "true",
            "Content-Type": "application/gzip",
            "Cache-Control": "3600",
        },
        data=payload,
        timeout=(20, 180),
    )
    if not response.ok:
        raise RuntimeError(f"transcript artifact upload HTTP {response.status_code}: {response.text[:1000]}")


def file_sha256(source: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def upload_file(
    storage_url: str,
    storage_key: str,
    object_path: str,
    source: pathlib.Path,
    content_type: str,
) -> None:
    encoded = "/".join(requests.utils.quote(part, safe="") for part in object_path.split("/"))
    size = source.stat().st_size
    with source.open("rb") as handle:
        response = requests.post(
            f"{storage_url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}",
            headers={
                "Authorization": f"Bearer {storage_key}",
                "apikey": storage_key,
                "x-upsert": "true",
                "Content-Type": content_type,
                "Content-Length": str(size),
                "Cache-Control": "3600",
            },
            data=handle,
            timeout=(20, 300),
        )
    if not response.ok:
        raise RuntimeError(f"alignment artifact upload HTTP {response.status_code}: {response.text[:1000]}")


def normalize_audio(source: pathlib.Path, wav: pathlib.Path) -> None:
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
    ], check=True)


def create_alignment_proxy(wav: pathlib.Path, target: pathlib.Path) -> None:
    # A mono 8 kHz FLAC preserves enough speech waveform detail for the 4 kHz
    # correlation gate while remaining far smaller than the transcription WAV.
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
        "-vn", "-ac", "1", "-ar", "8000", "-c:a", "flac", "-compression_level", "8", str(target),
    ], check=True)
    size = target.stat().st_size if target.is_file() else 0
    if size < 1 or size > MAX_ALIGNMENT_BYTES:
        raise RuntimeError("Podcast alignment proxy is outside the 1 byte–512 MB limit")


def transcribe(wav: pathlib.Path, model_name: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=max(2, os.cpu_count() or 2))
    stream, info = model.transcribe(
        str(wav), beam_size=5, vad_filter=True, word_timestamps=True,
        condition_on_previous_text=True,
    )
    segments: list[dict[str, Any]] = []
    for item in stream:
        text = (item.text or "").strip()
        if not text or item.end <= item.start:
            continue
        words = [{
            "start_s": round(float(word.start if word.start is not None else item.start), 3),
            "end_s": round(float(word.end if word.end is not None else item.end), 3),
            "text": (word.word or "").strip(),
        } for word in (item.words or []) if (word.word or "").strip()]
        segments.append({
            "start_s": round(float(item.start), 3), "end_s": round(float(item.end), 3),
            "text": text, "words": words,
        })
    return segments, {
        "language": str(info.language or "unknown"),
        "language_probability": float(info.language_probability or 0),
        "duration_s": float(info.duration or (segments[-1]["end_s"] if segments else 0)),
    }


def diarize(
    wav: pathlib.Path,
    segments: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    return local_acoustic_diarize(wav, segments)


def overlap_seconds(start: float, end: float, other_start: float, other_end: float) -> float:
    return max(0.0, min(end, other_end) - max(start, other_start))


def assign_speakers(segments: list[dict[str, Any]], turns: list[dict[str, Any]]) -> None:
    for segment in segments:
        scores: dict[str, float] = {}
        for turn in turns:
            overlap = overlap_seconds(segment["start_s"], segment["end_s"], turn["start_s"], turn["end_s"])
            if overlap > 0:
                scores[turn["speaker"]] = scores.get(turn["speaker"], 0.0) + overlap
        speaker = max(scores, key=scores.get) if scores else "SPEAKER_00"
        segment["speaker"] = speaker
        for word in segment.get("words", []):
            word_scores = {turn["speaker"]: overlap_seconds(word["start_s"], word["end_s"], turn["start_s"], turn["end_s"])
                           for turn in turns}
            word["speaker"] = max(word_scores, key=word_scores.get) if word_scores and max(word_scores.values()) > 0 else speaker


def safe_percentile(values: list[float], percentile: float, fallback: float) -> float:
    finite = [value for value in values if math.isfinite(value)]
    return float(np.percentile(finite, percentile)) if finite else fallback


def prosody_track(wav: pathlib.Path, segments: list[dict[str, Any]], turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    audio, sample_rate = librosa.load(str(wav), sr=16000, mono=True)
    raw: list[dict[str, Any]] = []
    for segment in segments:
        left = max(0, int(segment["start_s"] * sample_rate))
        right = min(len(audio), max(left + 1, int(segment["end_s"] * sample_rate)))
        samples = audio[left:right]
        rms = float(np.sqrt(np.mean(np.square(samples)))) if len(samples) else 0.0
        pitch_variance = 0.0
        if len(samples) >= sample_rate // 3:
            pitch = librosa.yin(samples, fmin=70, fmax=500, sr=sample_rate)
            voiced = pitch[np.isfinite(pitch)]
            if len(voiced) > 2:
                pitch_variance = float(np.std(np.log2(np.maximum(voiced, 1))))
        active_speakers = {turn["speaker"] for turn in turns
                           if overlap_seconds(segment["start_s"], segment["end_s"], turn["start_s"], turn["end_s"]) > 0.08}
        raw.append({"segment": segment, "rms": rms, "pitch": pitch_variance, "active_speakers": active_speakers})

    rms_low, rms_high = safe_percentile([x["rms"] for x in raw], 20, 0), safe_percentile([x["rms"] for x in raw], 90, 1)
    pitch_high = max(0.01, safe_percentile([x["pitch"] for x in raw], 90, 1))
    result: list[dict[str, Any]] = []
    for item in raw:
        segment = item["segment"]
        energy = float(np.clip((item["rms"] - rms_low) / max(1e-8, rms_high - rms_low), 0, 1))
        pitch = float(np.clip(item["pitch"] / pitch_high, 0, 1))
        explicit_laugh = bool(re.search(r"\b(?:ha(?:ha)+|laugh(?:s|ing|ter)?|chuckl(?:e|es|ing))\b", segment["text"], re.I))
        laughter = 1.0 if explicit_laugh else float(np.clip((energy * pitch) * 0.45, 0, 1))
        overlap = min(1.0, max(0, len(item["active_speakers"]) - 1) * 0.7)
        result.append({
            "start_s": segment["start_s"], "end_s": segment["end_s"], "speaker": segment["speaker"],
            "energy": round(energy, 4), "pitch_variance": round(pitch, 4),
            "laughter": round(laughter, 4), "overlap": round(overlap, 4),
        })
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=os.getenv("MAM_BASE") or "https://reaction-lab-coral.vercel.app")
    parser.add_argument("--secret", default=os.getenv("BUFFER_PUSH_SECRET") or os.getenv("REACTION_PIPELINE_SECRET"))
    # Keep alias precedence byte-for-byte equivalent in meaning to Stream V2:
    # explicit Shotlee names override the historical generic GitHub secrets.
    parser.add_argument("--storage-url", default=os.getenv("SHOTLEE_SUPABASE_URL") or os.getenv("SUPABASE_URL"))
    parser.add_argument("--storage-key", default=os.getenv("SHOTLEE_SUPABASE_SERVICE_ROLE_KEY") or os.getenv("MAM_SUPABASE_SERVICE_ROLE_KEY"))
    parser.add_argument("--vod-id", default="")
    parser.add_argument("--model", default="small")
    args = parser.parse_args()
    if not args.secret:
        raise SystemExit("BUFFER_PUSH_SECRET / REACTION_PIPELINE_SECRET is required")
    if not args.storage_url or not args.storage_key:
        raise SystemExit("Existing CLIPPER storage URL/service-role secret is required")

    claim = api(args.base_url, args.secret, "/api/clipper/podcast/claim", {
        "vod_id": args.vod_id or None, "worker_run_id": WORKER_RUN_ID,
    }, timeout=45)
    vod = claim.get("vod")
    if not vod:
        print("No queued podcast episode.")
        return 0
    vod_id = vod["id"]
    failure_stage = "claimed"
    try:
        expected_storage_ref = str(claim.get("storage_project_ref") or "").strip()
        if expected_storage_ref:
            assert_storage_project(args.storage_url, expected_storage_ref)
        recovery = claim.get("recovery") if isinstance(claim.get("recovery"), dict) else None
        if recovery and recovery.get("mode") == "transcript_artifact" and isinstance(recovery.get("artifact"), dict):
            try:
                result = api(args.base_url, args.secret, "/api/clipper/podcast/analyze", {
                    "vod_id": vod_id,
                    "worker_run_id": WORKER_RUN_ID,
                    "artifact": recovery["artifact"],
                }, timeout=330)
                print(json.dumps({
                    "vod_id": vod_id,
                    "candidate_count": result.get("candidate_count"),
                    "meta": result.get("meta"),
                    "recovered_from_artifact": True,
                }, indent=2))
                return 0
            except RuntimeError as exc:
                # A missing/tampered object is rejected before analyze advances
                # the lease, so rebuilding it from source is safe. Scout or DB
                # failures happen after that boundary and must not transcribe
                # into a second, unowned generation.
                if "HTTP 422" not in str(exc):
                    raise
                print("Stored transcript artifact was unavailable; rebuilding it from source.", flush=True)

        with tempfile.TemporaryDirectory(prefix="clipper-podcast-") as temp:
            root = pathlib.Path(temp)
            source = root / "source.audio"
            wav = root / "source.wav"
            alignment_proxy = root / "alignment.flac"
            failure_stage = "downloading"
            source_kind = str(vod.get("audio_source_kind") or "")
            source_message = "Fetching YouTube fallback audio once through the existing protected source path" \
                if source_kind == "youtube_fallback" else "Fetching open podcast audio channel"
            progress(args.base_url, args.secret, vod_id, failure_stage, source_message)
            prior_meta = vod.get("ingest_meta") if isinstance(vod.get("ingest_meta"), dict) else {}
            source_cache = validate_source_cache(vod_id, prior_meta.get("source_audio_cache")) \
                if source_kind == "youtube_fallback" else None
            if source_cache:
                try:
                    download_source_cache(args.storage_url, args.storage_key, source_cache, source)
                    progress(args.base_url, args.secret, vod_id, failure_stage, "Reused verified private YouTube source cache")
                except RuntimeError as exc:
                    if not str(exc).startswith(("podcast_source_cache_missing:", "podcast_source_cache_download_failed:")):
                        raise
                    print(f"{exc}; rebuilding from YouTube", flush=True)
                    source_cache = None
            if not source_cache:
                download_podcast_audio(vod, source)
                if source_kind == "youtube_fallback":
                    source_cache = upload_source_cache(args.storage_url, args.storage_key, vod_id, source)
                    progress(
                        args.base_url,
                        args.secret,
                        vod_id,
                        failure_stage,
                        "Cached verified YouTube source in private CLIPPER storage",
                        source_cache=source_cache,
                    )
            normalize_audio(source, wav)
            failure_stage = "transcribing"
            progress(args.base_url, args.secret, vod_id, failure_stage, f"Whisper {args.model} with word timestamps")
            segments, info = transcribe(wav, args.model)
            if not segments:
                raise RuntimeError("Whisper produced no transcript segments")
            failure_stage = "diarizing"
            progress(args.base_url, args.secret, vod_id, failure_stage, "Resolving 1–4 speakers with deterministic local acoustic clustering")
            turns, diarization_meta = diarize(wav, segments)
            assign_speakers(segments, turns)
            failure_stage = "prosody"
            progress(args.base_url, args.secret, vod_id, failure_stage, "Deriving local energy, pitch, laughter and overlap signals")
            prosody = prosody_track(wav, segments, turns)

            alignment_meta: Optional[dict[str, Any]] = None
            if source_kind != "youtube_fallback":
                failure_stage = "uploading_artifact"
                progress(args.base_url, args.secret, vod_id, failure_stage, "Persisting one reusable RSS alignment proxy")
                create_alignment_proxy(wav, alignment_proxy)
                alignment_digest = file_sha256(alignment_proxy)
                alignment_path = f"podcasts/{vod_id}/alignment/{alignment_digest}.flac"
                upload_file(
                    args.storage_url,
                    args.storage_key,
                    alignment_path,
                    alignment_proxy,
                    "audio/flac",
                )
                alignment_meta = {
                    "bucket": BUCKET,
                    "path": alignment_path,
                    "sha256": alignment_digest,
                    "bytes": alignment_proxy.stat().st_size,
                    "codec": "flac",
                    "sample_rate": 8000,
                    "channels": 1,
                }

            artifact = {
                "schema_version": "clipper-podcast-analysis-v1",
                "vod_id": vod_id,
                "transcript": {
                    "segments": segments,
                    "language": info["language"],
                    "model": f"faster-whisper/{args.model}",
                    "version": "clipper-podcast-transcript-v1",
                    "duration_s": info["duration_s"],
                    "word_count": sum(len(segment.get("words", [])) for segment in segments),
                },
                "prosody": prosody,
                "diarization": {**diarization_meta, "turns": turns},
                "ingest_meta": {
                    "runner": "github-actions",
                    "pipeline_version": "clipper-podcast-ingest-v3-local-diarization",
                    **({"alignment_audio": alignment_meta} if alignment_meta else {}),
                },
            }
            encoded = json.dumps(artifact, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            compressed = gzip.compress(encoded, compresslevel=9, mtime=0)
            digest = hashlib.sha256(compressed).hexdigest()
            object_path = f"podcasts/{vod_id}/analysis/{digest}.json.gz"
            recovery_root = str(os.getenv("CLIPPER_PODCAST_RECOVERY_DIR") or "").strip()
            if recovery_root:
                persist_recovery_artifact(pathlib.Path(recovery_root), vod_id, digest, compressed)
            failure_stage = "uploading_artifact"
            progress(args.base_url, args.secret, vod_id, failure_stage, "Uploading immutable transcript artifact to private CLIPPER storage")
            upload_artifact(args.storage_url, args.storage_key, object_path, compressed)

            result = api(args.base_url, args.secret, "/api/clipper/podcast/analyze", {
                "vod_id": vod_id,
                "worker_run_id": WORKER_RUN_ID,
                "artifact": {
                    "bucket": BUCKET,
                    "path": object_path,
                    "sha256": digest,
                    "bytes": len(compressed),
                    "content_encoding": "gzip",
                },
            }, timeout=330)
            print(json.dumps({"vod_id": vod_id, "candidate_count": result.get("candidate_count"), "meta": result.get("meta")}, indent=2))
            return 0
    except Exception as exc:
        traceback.print_exc()
        progress(args.base_url, args.secret, vod_id, failure_stage, error=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
