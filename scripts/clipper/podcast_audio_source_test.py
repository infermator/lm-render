#!/usr/bin/env python3

from __future__ import annotations

import pathlib
import tempfile
import unittest
from unittest.mock import patch

from podcast_audio_source import _assert_public_http_url, _download_http_audio, download_podcast_audio


class PodcastAudioSourceTests(unittest.TestCase):
    def test_http_audio_rejects_private_network_targets(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "non-public"):
            _assert_public_http_url("http://127.0.0.1/latest/meta-data")

    def test_http_audio_revalidates_and_pins_dns_at_connect_time(self) -> None:
        public_answer = [
            (2, 1, 6, "", ("93.184.216.34", 443)),
        ]
        rebound_answer = [
            (2, 1, 6, "", ("127.0.0.1", 443)),
        ]
        with tempfile.TemporaryDirectory() as temp, \
                patch("podcast_audio_source.socket.getaddrinfo", side_effect=[public_answer, rebound_answer]):
            target = pathlib.Path(temp) / "source.audio"
            with self.assertRaisesRegex(RuntimeError, "non-public"):
                _download_http_audio("https://podcast.example.test/episode.mp3", target)
            self.assertFalse(target.exists())

    def test_youtube_fallback_uses_one_wrapped_audio_download(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = pathlib.Path(temp) / "source.audio"

            def materialize(command: list[str], check: bool) -> None:
                self.assertTrue(check)
                pathlib.Path(command[command.index("-o") + 1]).write_bytes(b"audio")

            with patch("podcast_audio_source.subprocess.run", side_effect=materialize) as run:
                kind = download_podcast_audio({
                    "audio_source_kind": "youtube_fallback",
                    "audio_source_url": "https://www.youtube.com/watch?v=abcDEF_1234",
                    "video_source_url": "https://www.youtube.com/watch?v=abcDEF_1234",
                }, target)

            self.assertEqual(kind, "youtube_fallback")
            self.assertEqual(run.call_count, 1)
            command = run.call_args.args[0]
            self.assertEqual(command[0], "yt-dlp")
            self.assertIn("ba/b", command)
            self.assertEqual(command[-1], "https://www.youtube.com/watch?v=abcDEF_1234")

    def test_rss_audio_never_invokes_youtube_downloader(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = pathlib.Path(temp) / "source.audio"
            with patch("podcast_audio_source._download_http_audio") as http_download, \
                    patch("podcast_audio_source._download_youtube_audio") as youtube_download:
                kind = download_podcast_audio({
                    "audio_source_kind": "rss",
                    "audio_source_url": "https://cdn.example.test/episode.mp3",
                }, target)
            self.assertEqual(kind, "rss")
            http_download.assert_called_once()
            youtube_download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
