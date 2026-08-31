"""Face-selection rules for podcast speaker localisation."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "podcast_speaker_frames", Path(__file__).with_name("podcast_speaker_frames.py")
)
frames = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frames)


class DeduplicateFacesTest(unittest.TestCase):
    def test_overlapping_detections_count_once(self):
        # Frontal and profile cascades both match a three-quarter view. Counting
        # it twice would let one person outvote a real second face.
        merged = frames._deduplicate_faces([(100, 100, 200, 200), (110, 105, 190, 195)])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0][2] * merged[0][3], 200 * 200, "the larger box survives")

    def test_two_real_faces_are_both_kept(self):
        merged = frames._deduplicate_faces([(100, 100, 200, 200), (900, 120, 180, 180)])
        self.assertEqual(len(merged), 2)

    def test_empty_input(self):
        self.assertEqual(frames._deduplicate_faces([]), [])


if __name__ == "__main__":
    unittest.main()
