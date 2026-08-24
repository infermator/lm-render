#!/usr/bin/env python3
"""Validate that Podcast artifacts target Reaction Lab's storage project."""

from __future__ import annotations

import re
from urllib.parse import urlparse


def supabase_project_ref(raw: str) -> str:
    parsed = urlparse(str(raw or "").strip())
    host = (parsed.hostname or "").lower()
    match = re.fullmatch(r"([a-z0-9]{15,40})\.supabase\.co", host)
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port
            or parsed.path not in {"", "/"} or parsed.params or parsed.query or parsed.fragment
            or not match):
        raise RuntimeError("Podcast storage URL must be a Supabase project origin")
    return match.group(1)


def assert_storage_project(storage_url: str, expected_ref: str) -> None:
    actual = supabase_project_ref(storage_url)
    expected = str(expected_ref or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9]{15,40}", expected):
        raise RuntimeError("Reaction Lab returned an invalid Podcast storage project")
    if actual != expected:
        raise RuntimeError(
            "podcast_storage_project_mismatch: worker storage does not match Reaction Lab storage"
        )
