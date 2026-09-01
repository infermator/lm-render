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


class ShotAwarePlannerTest(unittest.TestCase):
    @staticmethod
    def _face(center_x, activity, area=0.02):
        return {
            "center_x": center_x,
            "area": area,
            "confidence": 0.95,
            "mouth_motion": activity + 2,
            "upper_motion": 2,
            "speech_activity": activity,
        }

    def _observations(self, rows):
        return [
            {"time_s": time_s, "faces": [self._face(*face) for face in faces]}
            for time_s, faces in rows
        ]

    def test_detection_resolution_is_bounded_for_4k_sources(self):
        self.assertEqual(frames._analysis_size(3840, 2160), (960, 540))
        self.assertEqual(frames._analysis_size(640, 360), (640, 360))

    def test_hard_cut_score_separates_an_edit_from_small_motion(self):
        black = np.zeros((108, 192, 3), dtype=np.uint8)
        almost_black = np.full((108, 192, 3), 2, dtype=np.uint8)
        white = np.full((108, 192, 3), 255, dtype=np.uint8)
        self.assertLess(frames._scene_change_score(black, almost_black), frames.SCENE_CHANGE_THRESHOLD)
        self.assertGreater(frames._scene_change_score(black, white), frames.SCENE_CHANGE_THRESHOLD)

    def test_single_face_is_held_for_the_whole_camera_shot(self):
        observations = self._observations([
            (0.2, [(0.48, 0.0)]),
            (0.6, [(0.50, 0.0)]),
            (1.0, [(0.49, 0.0)]),
        ])
        planned = frames._plan_shot_segments(0.0, 1.2, observations)
        self.assertEqual(len(planned), 1)
        self.assertEqual(planned[0]["layout"], "crop")
        self.assertAlmostEqual(planned[0]["center_x"], 0.49, places=2)

    def test_sustained_speaker_wins_without_being_the_largest_face(self):
        observations = self._observations([
            (time_s, [(0.22, 0.6, 0.04), (0.76, 9.0, 0.018)])
            for time_s in (0.2, 0.6, 1.0, 1.4, 1.8, 2.2, 2.6)
        ])
        planned = frames._plan_shot_segments(0.0, 2.8, observations)
        self.assertEqual(len(planned), 1)
        self.assertEqual(planned[0]["layout"], "crop")
        self.assertGreater(planned[0]["center_x"], 0.7)

    def test_one_listener_motion_spike_cannot_take_the_crop(self):
        rows = []
        for index, time_s in enumerate((0.2, 0.6, 1.0, 1.4, 1.8, 2.2, 2.6)):
            listener = 30.0 if index == 3 else 0.2
            rows.append((time_s, [(0.22, listener, 0.04), (0.76, 8.0, 0.018)]))
        planned = frames._plan_shot_segments(0.0, 2.8, self._observations(rows))
        self.assertEqual(len(planned), 1)
        self.assertEqual(planned[0]["layout"], "crop")
        self.assertGreater(planned[0]["center_x"], 0.7)

    def test_ambiguous_multiple_faces_preserve_the_whole_shot(self):
        observations = self._observations([
            (time_s, [(0.22, 1.0), (0.76, 1.1)])
            for time_s in (0.2, 0.6, 1.0, 1.4, 1.8, 2.2)
        ])
        planned = frames._plan_shot_segments(0.0, 2.4, observations)
        self.assertEqual(planned, [{
            "start_s": 0.0,
            "end_s": 2.4,
            "layout": "fit_blur",
            "center_x": None,
            "reason": "ambiguous_multiple_faces",
            "confidence": 0.0,
            "face_count": 2,
        }])

    def test_camera_cut_boundaries_are_used_exactly(self):
        observations = self._observations([
            (0.2, [(0.25, 0.0)]), (0.6, [(0.25, 0.0)]),
            (2.2, [(0.75, 0.0)]), (2.6, [(0.75, 0.0)]),
        ])
        planned = frames._framing_plan(4.0, [0.0, 2.0, 4.0], observations)
        self.assertEqual([item["start_s"] for item in planned], [0.0, 2.0])
        self.assertEqual([item["center_x"] for item in planned], [0.25, 0.75])
        self.assertTrue(all(item["transition"] == "shot_cut" for item in planned))


if __name__ == "__main__":
    unittest.main()
