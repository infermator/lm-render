#!/usr/bin/env python3

from __future__ import annotations

import unittest

import numpy as np

from podcast_audio_align import locate


class PodcastAudioAlignmentTests(unittest.TestCase):
    def test_locates_a_stable_positive_offset(self) -> None:
        rate = 400
        rng = np.random.default_rng(20260823)
        source = rng.normal(0, 0.2, rate * 30).astype(np.float32)
        reference = source[rate * 10:rate * 16]
        shift_samples = int(rate * 2.25)
        batch = np.zeros(rate * 36, dtype=np.float32)
        batch[shift_samples:shift_samples + source.size] = source

        result = locate(batch, reference, rate, expected_s=10.0, radius_s=5.0)

        self.assertTrue(result["ok"])
        self.assertAlmostEqual(result["offset_from_expected_s"], 2.25, delta=1 / rate)
        self.assertGreater(result["confidence"], 0.99)
        self.assertGreater(result["margin"], 0.5)


if __name__ == "__main__":
    unittest.main()
