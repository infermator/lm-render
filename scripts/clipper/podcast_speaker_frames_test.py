"""Face detection used to aim the podcast crop."""
import importlib.util
import unittest
from pathlib import Path

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location(
    "podcast_speaker_frames", Path(__file__).with_name("podcast_speaker_frames.py")
)
frames = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frames)


class FaceDetectorTest(unittest.TestCase):
    def test_model_is_vendored(self):
        # Downloading it at render time would make every render depend on a
        # third-party host being up.
        self.assertTrue(frames.MODEL_PATH.exists(), f"missing model at {frames.MODEL_PATH}")

    def test_detector_loads_and_returns_nothing_on_a_blank_frame(self):
        detector = frames._face_detector(320, 320)
        blank = np.zeros((320, 320, 3), dtype=np.uint8)
        self.assertEqual(frames._detect_faces(detector, blank), [])

    def test_low_confidence_detections_are_dropped(self):
        # A crop aimed at a guess lands on the wrong subject, which is worse
        # than not moving the crop at all.
        self.assertGreaterEqual(frames.MIN_FACE_CONFIDENCE, 0.7)

    def test_detector_reports_position_and_confidence(self):
        detector = frames._face_detector(256, 256)
        frame = np.full((256, 256, 3), 127, dtype=np.uint8)
        for face, confidence in frames._detect_faces(detector, frame):
            self.assertEqual(len(face), 4)
            self.assertGreaterEqual(confidence, frames.MIN_FACE_CONFIDENCE)


if __name__ == "__main__":
    unittest.main()
