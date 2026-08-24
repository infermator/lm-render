#!/usr/bin/env python3
"""Content-addressed private source cache for Podcast YouTube fallbacks."""

from __future__ import annotations

import hashlib
import pathlib
from typing import Any, Mapping, Optional

import requests


BUCKET = "clipper-media"
MAX_SOURCE_BYTES = 2_000_000_000


def validate_source_cache(vod_id: str, raw: Any) -> Optional[dict[str, Any]]:
    if not isinstance(raw, Mapping):
        return None
    sha256 = str(raw.get("sha256") or "").strip().lower()
    try:
        size = int(raw.get("bytes") or 0)
    except (TypeError, ValueError):
        return None
    path = str(raw.get("path") or "").strip()
    if (raw.get("bucket") != BUCKET
            or len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256)
            or path != f"podcasts/{vod_id}/source/{sha256}.audio"
            or size < 1 or size > MAX_SOURCE_BYTES):
        return None
    return {"bucket": BUCKET, "path": path, "sha256": sha256, "bytes": size}


def _object_url(storage_url: str, object_path: str) -> str:
    encoded = "/".join(requests.utils.quote(part, safe="") for part in object_path.split("/"))
    return f"{storage_url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}"


def download_source_cache(
    storage_url: str,
    storage_key: str,
    cache: Mapping[str, Any],
    target: pathlib.Path,
) -> None:
    expected_size = int(cache["bytes"])
    expected_hash = str(cache["sha256"])
    digest = hashlib.sha256()
    size = 0
    try:
        with requests.get(
            _object_url(storage_url, str(cache["path"])),
            headers={"Authorization": f"Bearer {storage_key}", "apikey": storage_key},
            stream=True,
            timeout=(20, 180),
        ) as response:
            if response.status_code == 404:
                raise RuntimeError("podcast_source_cache_missing: cached source object was not found")
            if not response.ok:
                raise RuntimeError(f"podcast_source_cache_download_failed: storage HTTP {response.status_code}")
            with target.open("wb") as handle:
                for chunk in response.iter_content(1024 * 1024):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > expected_size or size > MAX_SOURCE_BYTES:
                        raise RuntimeError("podcast_source_cache_invalid: cached source exceeds its declared size")
                    digest.update(chunk)
                    handle.write(chunk)
    except requests.RequestException:
        raise RuntimeError("podcast_source_cache_download_failed: storage request failed") from None
    if size != expected_size or digest.hexdigest() != expected_hash:
        target.unlink(missing_ok=True)
        raise RuntimeError("podcast_source_cache_invalid: cached source integrity check failed")


def upload_source_cache(
    storage_url: str,
    storage_key: str,
    vod_id: str,
    source: pathlib.Path,
) -> dict[str, Any]:
    size = source.stat().st_size
    if size < 1 or size > MAX_SOURCE_BYTES:
        raise RuntimeError("Podcast source is outside the 1 byte–2 GB cache limit")
    digest = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    sha256 = digest.hexdigest()
    path = f"podcasts/{vod_id}/source/{sha256}.audio"
    try:
        with source.open("rb") as handle:
            response = requests.post(
                _object_url(storage_url, path),
                headers={
                    "Authorization": f"Bearer {storage_key}",
                    "apikey": storage_key,
                    "x-upsert": "true",
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(size),
                    "Cache-Control": "86400",
                },
                data=handle,
                timeout=(20, 300),
            )
    except requests.RequestException:
        raise RuntimeError("podcast_source_cache_upload_failed: storage request failed") from None
    if not response.ok:
        raise RuntimeError(f"podcast_source_cache_upload_failed: storage HTTP {response.status_code}")
    return {"bucket": BUCKET, "path": path, "sha256": sha256, "bytes": size}
