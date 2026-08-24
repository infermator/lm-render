#!/usr/bin/env python3
"""Materialize one Podcast V3 analysis audio source.

RSS/direct audio stays on plain HTTP. Only the explicit youtube_fallback kind
uses the established yt-dlp wrapper, which injects the existing WARP/cookie
configuration without exposing it to the Python process or logs.
"""

from __future__ import annotations

import argparse
import ipaddress
import pathlib
import socket
import subprocess
from typing import Any, Mapping, Optional
from urllib.parse import urljoin, urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.poolmanager import PoolManager


MAX_AUDIO_BYTES = 2_000_000_000
MAX_REDIRECTS = 5


def _public_socket(connection: HTTPConnection) -> socket.socket:
    """Resolve once at connect time, validate every answer, then dial its sockaddr."""
    try:
        addresses = socket.getaddrinfo(
            connection._dns_host, connection.port, family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
        )
    except OSError:
        raise RuntimeError("Podcast audio host could not be resolved") from None
    if not addresses:
        raise RuntimeError("Podcast audio host could not be resolved")
    for _, _, _, _, sockaddr in addresses:
        try:
            if not ipaddress.ip_address(sockaddr[0]).is_global:
                raise RuntimeError("Podcast audio URL resolved to a non-public address")
        except ValueError:
            raise RuntimeError("Podcast audio host returned an invalid address") from None

    last_error: Optional[OSError] = None
    for family, socktype, proto, _, sockaddr in addresses:
        candidate = socket.socket(family, socktype, proto)
        try:
            candidate.settimeout(connection.timeout)
            for option in connection.socket_options or []:
                candidate.setsockopt(*option)
            if connection.source_address:
                candidate.bind(connection.source_address)
            # sockaddr came from the validated lookup above. No library gets a
            # hostname to resolve again, while urllib3 still retains the
            # original host for HTTP Host and HTTPS SNI/certificate checks.
            candidate.connect(sockaddr)
            return candidate
        except OSError as exc:
            last_error = exc
            candidate.close()
    raise last_error or RuntimeError("Podcast audio connection failed")


class _PublicHTTPConnection(HTTPConnection):
    def _new_conn(self) -> socket.socket:
        return _public_socket(self)


class _PublicHTTPSConnection(HTTPSConnection):
    def _new_conn(self) -> socket.socket:
        return _public_socket(self)


class _PublicHTTPConnectionPool(HTTPConnectionPool):
    ConnectionCls = _PublicHTTPConnection


class _PublicHTTPSConnectionPool(HTTPSConnectionPool):
    ConnectionCls = _PublicHTTPSConnection


class _PublicAddressAdapter(HTTPAdapter):
    def init_poolmanager(self, connections: int, maxsize: int, block: bool = False, **pool_kwargs: Any) -> None:
        self.poolmanager = PoolManager(num_pools=connections, maxsize=maxsize, block=block, **pool_kwargs)
        self.poolmanager.pool_classes_by_scheme = {
            "http": _PublicHTTPConnectionPool,
            "https": _PublicHTTPSConnectionPool,
        }


def _assert_public_http_url(raw: str) -> str:
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("Podcast audio URL must use public HTTP(S)")
    if parsed.username or parsed.password:
        raise RuntimeError("Podcast audio URL must not contain credentials")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or 0, type=socket.SOCK_STREAM)}
    except OSError:
        raise RuntimeError("Podcast audio host could not be resolved") from None
    if not addresses:
        raise RuntimeError("Podcast audio host could not be resolved")
    for address in addresses:
        try:
            if not ipaddress.ip_address(address).is_global:
                raise RuntimeError("Podcast audio URL resolved to a non-public address")
        except ValueError:
            raise RuntimeError("Podcast audio host returned an invalid address") from None
    return raw


def _download_http_audio(url: str, target: pathlib.Path) -> None:
    try:
        current = _assert_public_http_url(url)
        with requests.Session() as session:
            # Never inherit a process proxy for arbitrary RSS/direct sources;
            # the custom adapter must own the actual target connection.
            session.trust_env = False
            adapter = _PublicAddressAdapter(max_retries=0)
            session.mount("http://", adapter)
            session.mount("https://", adapter)
            for redirect_count in range(MAX_REDIRECTS + 1):
                with session.get(
                    current,
                    stream=True,
                    allow_redirects=False,
                    timeout=(20, 120),
                    headers={"User-Agent": "ReactionLab-CLIPPER/3.0"},
                ) as response:
                    if 300 <= response.status_code < 400:
                        location = response.headers.get("location")
                        if not location:
                            raise RuntimeError("Podcast audio redirected without a location")
                        if redirect_count >= MAX_REDIRECTS:
                            raise RuntimeError("Podcast audio redirected too many times")
                        current = _assert_public_http_url(urljoin(current, location))
                        continue
                    response.raise_for_status()
                    total = 0
                    with target.open("wb") as handle:
                        for chunk in response.iter_content(1024 * 1024):
                            if not chunk:
                                continue
                            total += len(chunk)
                            if total > MAX_AUDIO_BYTES:
                                raise RuntimeError("Podcast audio exceeds the 2 GB ingest limit")
                            handle.write(chunk)
                    return
        raise RuntimeError("Podcast audio redirected too many times")
    except requests.RequestException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        detail = f" (HTTP {status})" if status else ""
        # Do not let a signed enclosure URL appear in a public Action traceback.
        raise RuntimeError(f"Podcast audio download failed{detail}") from None


def _download_youtube_audio(url: str, target: pathlib.Path) -> None:
    subprocess.run([
        "yt-dlp",
        "--no-playlist",
        "--js-runtimes", "node",
        "--remote-components", "ejs:github",
        "--max-filesize", "2000M",
        "-f", "ba/b",
        "-o", str(target),
        url,
    ], check=True)
    if not target.is_file() or target.stat().st_size < 1:
        raise RuntimeError("yt-dlp completed without a podcast audio source")
    if target.stat().st_size > MAX_AUDIO_BYTES:
        raise RuntimeError("Podcast audio exceeds the 2 GB ingest limit")


def download_podcast_audio(vod: Mapping[str, Any], target: pathlib.Path) -> str:
    kind = str(vod.get("audio_source_kind") or "").strip()
    audio_url = str(vod.get("audio_source_url") or "").strip()
    if kind == "youtube_fallback":
        youtube_url = str(vod.get("video_source_url") or audio_url).strip()
        if not youtube_url:
            raise RuntimeError("YouTube fallback podcast is missing its video URL")
        _download_youtube_audio(youtube_url, target)
        return "youtube_fallback"
    if kind not in {"rss", "direct"}:
        raise RuntimeError(f"Unsupported podcast audio source kind: {kind or 'missing'}")
    if not audio_url:
        raise RuntimeError("Podcast audio URL is missing")
    _download_http_audio(audio_url, target)
    return kind


def main() -> int:
    parser = argparse.ArgumentParser(description="Safely materialize one public HTTP podcast audio source")
    parser.add_argument("--http-url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    _download_http_audio(args.http_url, pathlib.Path(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
