#!/usr/bin/env python3
"""Persist only the compressed transcript needed for a one-day CI recovery."""

from __future__ import annotations

import json
import pathlib
import re


def persist_recovery_artifact(
    root: pathlib.Path,
    vod_id: str,
    digest: str,
    compressed: bytes,
) -> pathlib.Path:
    if not re.fullmatch(r"[0-9a-f-]{36}", vod_id, re.I):
        raise RuntimeError("Podcast recovery VOD id is invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RuntimeError("Podcast recovery digest is invalid")
    if not compressed:
        raise RuntimeError("Podcast recovery artifact is empty")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    artifact = root / f"{vod_id}-{digest}.json.gz"
    artifact.write_bytes(compressed)
    artifact.chmod(0o600)
    manifest = root / "manifest.json"
    manifest.write_text(json.dumps({
        "vod_id": vod_id,
        "artifact": {
            "bucket": "clipper-media",
            "path": f"podcasts/{vod_id}/analysis/{digest}.json.gz",
            "sha256": digest,
            "bytes": len(compressed),
            "content_encoding": "gzip",
        },
    }, separators=(",", ":")), encoding="utf-8")
    manifest.chmod(0o600)
    return artifact
