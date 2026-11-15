#!/usr/bin/env python3
"""Resumable (TUS 1.0.0) uploads to Supabase Storage in 6 MB chunks.

Reaction Lab's storage is reached through a Cloudflare-proxied hostname
(https://api.21media.online since the 2026-11-15 MAM separation), and Cloudflare
rejects request bodies over 100 MB. A TUS upload sends every chunk as its own
request, so arbitrarily large files pass. Supabase Cloud speaks the same
protocol, so this works against either backend.
"""

from __future__ import annotations

import base64
import pathlib
from typing import Mapping

import requests

CHUNK_BYTES = 6 * 1024 * 1024  # Supabase Storage requires 6 MB chunks (last one may be shorter)
# Above this, uploads go through TUS; below, a single request is simpler and well under the proxy cap.
TUS_THRESHOLD_BYTES = 64 * 1024 * 1024


def _b64(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


def tus_upload(
    storage_url: str,
    auth_headers: Mapping[str, str],
    bucket: str,
    object_name: str,
    source: pathlib.Path,
    content_type: str,
    cache_control: str = "3600",
    upsert: bool = True,
    signed: bool = False,
    timeout: tuple[int, int] = (20, 120),
) -> None:
    """Upload `source` to bucket/object_name. `signed=True` uses /upload/resumable/sign with an
    `x-signature` token in auth_headers instead of a bearer key. Raises RuntimeError without
    echoing URLs or keys."""
    size = source.stat().st_size
    base = storage_url.rstrip("/")
    endpoint = f"{base}/storage/v1/upload/resumable" + ("/sign" if signed else "")
    metadata = ",".join([
        f"bucketName {_b64(bucket)}",
        f"objectName {_b64(object_name)}",
        f"contentType {_b64(content_type)}",
        f"cacheControl {_b64(cache_control)}",
    ])
    headers = {"Tus-Resumable": "1.0.0", **auth_headers}
    try:
        created = requests.post(
            endpoint,
            headers={**headers, "Upload-Length": str(size), "Upload-Metadata": metadata,
                     "x-upsert": "true" if upsert else "false"},
            timeout=timeout,
        )
    except requests.RequestException:
        raise RuntimeError("storage_tus_failed: create request failed") from None
    location = created.headers.get("Location", "")
    if created.status_code != 201 or not location:
        raise RuntimeError(f"storage_tus_failed: create HTTP {created.status_code}")
    if location.startswith("/"):
        location = base + location
    offset = 0
    with source.open("rb") as handle:
        while offset < size:
            handle.seek(offset)
            chunk = handle.read(CHUNK_BYTES)
            for attempt in range(4):
                try:
                    resp = requests.patch(
                        location,
                        headers={**headers, "Upload-Offset": str(offset),
                                 "Content-Type": "application/offset+octet-stream"},
                        data=chunk,
                        timeout=timeout,
                    )
                except requests.RequestException:
                    resp = None
                if resp is not None and resp.status_code == 204:
                    break
                # A lost response may still have been applied: ask the server where it is.
                try:
                    head = requests.head(location, headers=headers, timeout=timeout)
                    server_offset = int(head.headers.get("Upload-Offset", "-1"))
                except (requests.RequestException, ValueError):
                    server_offset = -1
                if server_offset == offset + len(chunk):
                    break
                if attempt == 3:
                    code = resp.status_code if resp is not None else "no-response"
                    raise RuntimeError(f"storage_tus_failed: chunk at {offset} HTTP {code}")
            offset += len(chunk)
