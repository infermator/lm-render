#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
import unittest

from podcast_recovery_artifact import persist_recovery_artifact


class PodcastRecoveryArtifactTests(unittest.TestCase):
    def test_persists_content_addressed_transcript_and_manifest(self) -> None:
        payload = b"compressed-transcript"
        digest = hashlib.sha256(payload).hexdigest()
        vod_id = "09f68e91-d8f9-4755-92d9-c720a4059a11"
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / "recovery"
            artifact = persist_recovery_artifact(root, vod_id, digest, payload)
            self.assertEqual(artifact.read_bytes(), payload)
            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["artifact"]["sha256"], digest)
            self.assertEqual(manifest["artifact"]["bytes"], len(payload))
            self.assertEqual(
                manifest["artifact"]["path"],
                f"podcasts/{vod_id}/analysis/{digest}.json.gz",
            )

    def test_rejects_path_shaping_identifiers(self) -> None:
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(RuntimeError, "VOD id"):
            persist_recovery_artifact(pathlib.Path(temp), "../../escape", "a" * 64, b"payload")


if __name__ == "__main__":
    unittest.main()
