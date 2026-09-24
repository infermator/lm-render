"""Unit tests run without downloading speech models or touching V1."""
import unittest
from dataclasses import dataclass

from transcript_quality import quality_signals, use_retry, agreed_silence, zero_duration_words, use_timing_retry


@dataclass
class Segment:
    text: str
    no_speech_prob: float = 0
    avg_logprob: float = 0
    compression_ratio: float = 1


class TranscriptQualityTests(unittest.TestCase):
    def test_crossed_confidence_thresholds(self):
        self.assertTrue(quality_signals(Segment("invented words", .95, -1.5))["suspected_hallucination"])
        self.assertFalse(quality_signals(Segment("quiet speech", .95, -.3))["suspected_hallucination"])
        self.assertTrue(quality_signals(Segment("yes yes yes yes yes yes yes yes"))["repeated_words"])

    def test_retry_requires_confidence_and_words(self):
        old = {"quality": {"avg_logprob": -1.8}, "words": [1, 2, 3, 4]}
        good = {"quality": {"avg_logprob": -.7, "suspected_hallucination": False},
                "words": [1, 2, 3]}
        self.assertTrue(use_retry(old, good))
        self.assertFalse(use_retry(old, {**good, "words": [1]}))
        self.assertFalse(use_retry(old, {**good, "quality": {"avg_logprob": -1.7}}))

    def test_zero_duration_word_retry_requires_same_spoken_content(self):
        original = {"quality": {"avg_logprob": -.9},
                    "words": [{"start_s": 1.74, "end_s": 1.74, "text": "use?"},
                              {"start_s": 1.74, "end_s": 1.9, "text": "Only"}]}
        recovered = {"quality": {"avg_logprob": -.85, "suspected_hallucination": False},
                     "words": [{"start_s": 1.6, "end_s": 1.72, "text": "use?"},
                               {"start_s": 1.74, "end_s": 1.9, "text": "Only"}]}
        self.assertEqual(zero_duration_words(original["words"]), 1)
        self.assertTrue(use_timing_retry(original, recovered))
        self.assertFalse(use_timing_retry(original, {**recovered,
            "words": [{"start_s": 1.6, "end_s": 1.72, "text": "invention"}]}))
        self.assertFalse(use_timing_retry(original, {**recovered,
            "quality": {"avg_logprob": -1.8, "suspected_hallucination": False}}))

    def test_only_two_pass_agreed_silence_is_dropped(self):
        old = {"quality": {"no_speech_prob": .9, "avg_logprob": -1.6}}
        self.assertTrue(agreed_silence(old, []))
        self.assertFalse(agreed_silence(old, [{"text": "actually spoken"}]))
        self.assertFalse(agreed_silence({"quality": {"no_speech_prob": .8, "avg_logprob": -1.6}}, []))


if __name__ == "__main__":
    unittest.main()
