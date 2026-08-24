#!/usr/bin/env python3

from __future__ import annotations

import unittest

import numpy as np

from podcast_diarization import cluster_acoustic_embeddings, turns_from_segment_labels


class PodcastDiarizationTests(unittest.TestCase):
    def test_two_separated_speakers_are_deterministic(self) -> None:
        rng = np.random.default_rng(20260823)
        left = rng.normal(-3.0, 0.12, size=(12, 12))
        right = rng.normal(3.0, 0.12, size=(12, 12))
        features = np.vstack([left, right])

        first = cluster_acoustic_embeddings(features)
        second = cluster_acoustic_embeddings(features)

        self.assertEqual(first.speaker_count, 2)
        np.testing.assert_array_equal(first.labels, second.labels)
        self.assertEqual(len(set(first.labels[:12].tolist())), 1)
        self.assertEqual(len(set(first.labels[12:].tolist())), 1)
        self.assertNotEqual(first.labels[0], first.labels[-1])

    def test_one_compact_voice_is_not_overclustered(self) -> None:
        rng = np.random.default_rng(17)
        features = rng.normal(0.0, 0.04, size=(30, 10))

        result = cluster_acoustic_embeddings(features)

        self.assertEqual(result.speaker_count, 1)
        self.assertEqual(set(result.labels.tolist()), {0})

    def test_identical_evidence_does_not_create_empty_cluster_failure(self) -> None:
        result = cluster_acoustic_embeddings(np.ones((18, 8)))

        self.assertEqual(result.speaker_count, 1)
        self.assertEqual(set(result.labels.tolist()), {0})

    def test_speaker_count_is_bounded_at_four(self) -> None:
        rng = np.random.default_rng(44)
        groups = [rng.normal(index * 5.0, 0.08, size=(8, 9)) for index in range(5)]

        result = cluster_acoustic_embeddings(np.vstack(groups), max_speakers=10)

        self.assertGreaterEqual(result.speaker_count, 1)
        self.assertLessEqual(result.speaker_count, 4)
        self.assertEqual(result.metadata["speaker_bounds"], [1, 4])

    def test_four_strong_acoustic_groups_can_be_selected(self) -> None:
        rng = np.random.default_rng(104)
        groups = []
        for index in range(4):
            center = np.zeros(12)
            center[index * 2:index * 2 + 2] = 6.0
            groups.append(center + rng.normal(0.0, 0.08, size=(12, 12)))

        result = cluster_acoustic_embeddings(np.vstack(groups))

        self.assertEqual(result.speaker_count, 4)
        self.assertEqual(len(set(result.labels.tolist())), 4)

    def test_turn_labels_follow_first_appearance_and_fill_all_segments(self) -> None:
        segments = [
            {"start_s": 0.0, "end_s": 1.0},
            {"start_s": 1.1, "end_s": 2.0},
            {"start_s": 3.0, "end_s": 4.0},
        ]

        turns = turns_from_segment_labels(segments, [0, 2], np.asarray([7, 3]))

        self.assertEqual(turns, [
            {"start_s": 0.0, "end_s": 2.0, "speaker": "SPEAKER_00"},
            {"start_s": 3.0, "end_s": 4.0, "speaker": "SPEAKER_01"},
        ])


if __name__ == "__main__":
    unittest.main()
