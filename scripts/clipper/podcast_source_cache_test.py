#!/usr/bin/env python3

from __future__ import annotations

import unittest

from podcast_source_cache import validate_source_cache


class PodcastSourceCacheTests(unittest.TestCase):
    def test_accepts_only_the_content_addressed_vod_path(self) -> None:
        vod_id = "09f68e91-d8f9-4755-92d9-c720a4059a11"
        digest = "a" * 64
        expected = {
            "bucket": "clipper-media",
            "path": f"podcasts/{vod_id}/source/{digest}.audio",
            "sha256": digest,
            "bytes": 123,
        }
        self.assertEqual(validate_source_cache(vod_id, expected), expected)
        self.assertIsNone(validate_source_cache(vod_id, {**expected, "path": "../../source.audio"}))
        self.assertIsNone(validate_source_cache(vod_id, {**expected, "sha256": "not-a-digest"}))

    def test_rejects_oversized_or_wrong_bucket_objects(self) -> None:
        vod_id = "09f68e91-d8f9-4755-92d9-c720a4059a11"
        digest = "b" * 64
        base = {
            "bucket": "clipper-media",
            "path": f"podcasts/{vod_id}/source/{digest}.audio",
            "sha256": digest,
            "bytes": 123,
        }
        self.assertIsNone(validate_source_cache(vod_id, {**base, "bucket": "reaction-media"}))
        self.assertIsNone(validate_source_cache(vod_id, {**base, "bytes": 2_000_000_001}))


if __name__ == "__main__":
    unittest.main()
