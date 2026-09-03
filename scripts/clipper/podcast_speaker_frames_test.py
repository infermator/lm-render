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

    def test_ambiguous_multiple_faces_hold_one_portrait_subject(self):
        observations = self._observations([
            (time_s, [(0.22, 1.0), (0.76, 1.1)])
            for time_s in (0.2, 0.6, 1.0, 1.4, 1.8, 2.2)
        ])
        planned = frames._plan_shot_segments(0.0, 2.4, observations)
        self.assertEqual(len(planned), 1)
        segment = planned[0]
        # Asserted field by field rather than as a whole dict: the planner grew
        # center_y and face_h for vertical framing, and an exact-dict compare
        # fails on any added field even when the behaviour under test is
        # unchanged.
        self.assertEqual(segment["start_s"], 0.0)
        self.assertEqual(segment["end_s"], 2.4)
        self.assertEqual(segment["layout"], "crop")
        self.assertEqual(segment["center_x"], 0.76)
        self.assertEqual(segment["reason"], "ambiguous_stable_subject")
        self.assertEqual(segment["confidence"], 0.0)
        self.assertEqual(segment["face_count"], 2)
        # The vertical fields must still be present and usable by the crop.
        self.assertIn("center_y", segment)
        self.assertIn("face_h", segment)
        self.assertGreaterEqual(segment["center_y"], 0.0)
        self.assertLessEqual(segment["center_y"], 1.0)

    def test_missing_faces_hold_the_previous_portrait_center(self):
        planned = frames._plan_shot_segments(1.0, 2.0, [], previous_center=0.73)
        self.assertEqual(planned[0]["layout"], "crop")
        self.assertEqual(planned[0]["center_x"], 0.73)
        self.assertEqual(planned[0]["reason"], "no_stable_face_hold")

    def test_a_sustained_speaker_run_is_kept_even_with_long_uncertain_pauses(self):
        observations = self._observations([
            (time_s, [(0.22, 0.4), (0.76, 8.0 if 3 <= index <= 5 else 0.3)])
            for index, time_s in enumerate((0.2, 0.6, 1.0, 1.4, 1.8, 2.2, 2.6, 3.0, 3.4, 3.8, 4.2, 4.6))
        ])
        planned = frames._plan_shot_segments(0.0, 4.8, observations)
        self.assertTrue(all(item["layout"] == "crop" for item in planned))
        self.assertTrue(all(item["reason"] == "active_speaker_motion" for item in planned))
        self.assertGreater(planned[0]["center_x"], 0.7)

    def test_every_planned_segment_is_a_finite_portrait_crop(self):
        observations = self._observations([
            (0.2, [(0.22, 1.0), (0.76, 1.1)]),
            (0.6, [(0.22, 1.0), (0.76, 1.1)]),
            (2.2, []), (2.6, []),
        ])
        planned = frames._framing_plan(4.0, [0.0, 2.0, 4.0], observations)
        self.assertTrue(all(item["layout"] == "crop" for item in planned))
        self.assertTrue(all(0.0 <= item["center_x"] <= 1.0 for item in planned))

    def test_camera_cut_boundaries_are_used_exactly(self):
        observations = self._observations([
            (0.2, [(0.25, 0.0)]), (0.6, [(0.25, 0.0)]),
            (2.2, [(0.75, 0.0)]), (2.6, [(0.75, 0.0)]),
        ])
        planned = frames._framing_plan(4.0, [0.0, 2.0, 4.0], observations)
        self.assertEqual([item["start_s"] for item in planned], [0.0, 2.0])
        self.assertEqual([item["center_x"] for item in planned], [0.25, 0.75])
        self.assertTrue(all(item["transition"] == "shot_cut" for item in planned))


class AmbiguousShotResolutionTest(unittest.TestCase):
    """What decides the frame when no face shows usable lip motion."""

    @staticmethod
    def _identity(seed):
        vector = np.zeros(128, dtype=np.float32)
        vector[seed] = 1.0
        return vector

    def _track(self, track_id, center, area, identity_seed, items=6):
        embedding = self._identity(identity_seed)
        return {
            "id": track_id,
            "items": [
                {"center_x": center, "center_y": 0.4, "face_h": 0.12, "area": area,
                 "speech_activity": 0.0, "time_s": index * 0.4, "embedding": embedding}
                for index in range(items)
            ],
        }

    def test_the_last_confident_speaker_keeps_the_frame(self):
        # About nine per cent of runtime across three finished clips reached
        # this branch: several faces visible, none provably talking. Ranking on
        # prominence hands the frame to whoever sits nearest the camera, so it
        # settles on a listener while somebody else speaks.
        listener_closer = self._track(1, 0.30, area=0.09, identity_seed=1)
        speaker_further = self._track(2, 0.72, area=0.05, identity_seed=2)
        chosen = frames._fallback_track(
            [listener_closer, speaker_further], previous_center=0.5,
            confident_identity=self._identity(2),
        )
        self.assertEqual(chosen["id"], 2, "the frame must stay on the last proven speaker")

    def test_identity_is_matched_across_a_camera_cut(self):
        # The reason this is identity and not position: the same host sits at a
        # different x in every angle, so matching on centre never fired once on
        # a real clip. The speaker here has moved right across the cut.
        moved_speaker = self._track(1, 0.85, area=0.04, identity_seed=7)
        other_person = self._track(2, 0.20, area=0.10, identity_seed=9)
        chosen = frames._fallback_track(
            [moved_speaker, other_person], previous_center=0.2,
            confident_identity=self._identity(7),
        )
        self.assertEqual(chosen["id"], 1, "identity must beat both position and size")

    def test_diarization_outranks_continuity(self):
        held = self._track(1, 0.30, area=0.09, identity_seed=1)
        diarized = self._track(2, 0.72, area=0.05, identity_seed=2)
        chosen = frames._fallback_track(
            [held, diarized], previous_center=0.3,
            confident_identity=self._identity(1), diarized_identity=self._identity(2),
        )
        self.assertEqual(chosen["id"], 2)

    def test_prominence_still_decides_with_no_other_signal(self):
        small = self._track(1, 0.25, area=0.03, identity_seed=1)
        large = self._track(2, 0.70, area=0.11, identity_seed=2)
        chosen = frames._fallback_track([small, large], previous_center=0.5)
        self.assertEqual(chosen["id"], 2)

    def test_an_unknown_face_never_counts_as_a_match(self):
        # A track with no usable embedding must not be treated as the speaker
        # just because nothing contradicts it.
        faceless = self._track(1, 0.30, area=0.09, identity_seed=1)
        for item in faceless["items"]:
            item["embedding"] = None
        self.assertFalse(frames._same_person(frames._track_identity(faceless), self._identity(1)))

    def test_a_guess_never_becomes_the_anchor_for_the_next_guess(self):
        # Only reasons backed by evidence may anchor a later decision.
        self.assertEqual(
            frames.PROVEN_REASONS,
            {"audio_synced_speaker", "active_speaker_motion", "single_visible_face"},
        )
        self.assertNotIn("ambiguous_stable_subject", frames.PROVEN_REASONS)


class FaceIdentityTest(unittest.TestCase):
    def test_a_track_identity_averages_its_frames(self):
        base = np.zeros(128, dtype=np.float32); base[3] = 1.0
        noise = np.zeros(128, dtype=np.float32); noise[4] = 1.0
        track = {"items": [{"embedding": base}, {"embedding": base}, {"embedding": noise}]}
        identity = frames._track_identity(track)
        # Two frames agree and one does not; the pair must dominate.
        self.assertGreater(float(np.dot(identity, base)), float(np.dot(identity, noise)))

    def test_identity_threshold_separates_the_measured_populations(self):
        # Measured on a finished clip: same person 0.79-0.89 across cuts,
        # different people 0.00-0.03. The threshold must sit between them.
        self.assertGreater(frames.IDENTITY_MATCH_THRESHOLD, 0.05)
        self.assertLess(frames.IDENTITY_MATCH_THRESHOLD, 0.75)


class DiarizationSpanTest(unittest.TestCase):
    def test_labelled_instants_become_contiguous_spans(self):
        spans = frames._diarization_spans(
            [{"time_s": 0.0, "speaker": "SPEAKER_00"}, {"time_s": 4.0, "speaker": "SPEAKER_01"}], 10.0
        )
        self.assertEqual(len(spans), 2)
        self.assertEqual(spans[0], {"speaker": "SPEAKER_00", "start_s": 0.0, "end_s": 4.0})
        self.assertEqual(spans[1]["end_s"], 10.0)

    def test_unlabelled_samples_are_not_evidence(self):
        spans = frames._diarization_spans(
            [{"time_s": 0.0, "speaker": "SPEAKER_00"}, {"time_s": 2.0, "speaker": None}], 6.0
        )
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["speaker"], "SPEAKER_00")

    def test_no_learned_faces_means_no_diarized_answer(self):
        # Before any shot has been resolved confidently there is nothing to map
        # a speaker label onto, and guessing would be worse than abstaining.
        spans = frames._diarization_spans(
            [{"time_s": t, "speaker": "SPEAKER_00"} for t in (0.0, 2.0, 4.0)], 6.0
        )
        self.assertIsNone(frames._diarized_identity_for(0.0, 6.0, {}, spans))


class AudioSyncTest(unittest.TestCase):
    """Who is talking is decided by the mouth that moves with the sound."""

    @staticmethod
    def _track(track_id, motions, start=0.0, step=0.4):
        return {
            "id": track_id,
            "items": [
                {"time_s": start + index * step, "mouth_motion": value,
                 "center_x": 0.5, "center_y": 0.4, "face_h": 0.12,
                 "area": 0.05, "speech_activity": value, "embedding": None}
                for index, value in enumerate(motions)
            ],
        }

    def test_the_face_that_moves_with_the_audio_scores_highest(self):
        # A listener chewing or nodding produces mouth motion just like a
        # talker. Only the talker's motion rises and falls with the sound.
        envelope = np.array([2.0, -1.0, 2.0, -1.0, 2.0, -1.0, 2.0, -1.0], dtype=np.float64)
        speaker = self._track(1, [9.0, 1.0, 9.0, 1.0, 9.0, 1.0, 9.0, 1.0])
        fidget = self._track(2, [1.0, 9.0, 1.0, 9.0, 1.0, 9.0, 1.0, 9.0])
        speaker_score = frames._audio_sync_score(speaker, envelope, 0.4, 0.0, 4.0)
        fidget_score = frames._audio_sync_score(fidget, envelope, 0.4, 0.0, 4.0)
        self.assertGreater(speaker_score, frames.AUDIO_SYNC_MIN_CORRELATION)
        self.assertLess(fidget_score, 0.0, "anti-correlated motion is not speech")

    def test_constant_motion_carries_no_information(self):
        # A face whose mouth region never changes cannot be correlated with
        # anything; it must score zero rather than a spurious value.
        envelope = np.array([2.0, -1.0, 2.0, -1.0, 2.0, -1.0, 2.0, -1.0], dtype=np.float64)
        flat = self._track(1, [5.0] * 8)
        self.assertEqual(frames._audio_sync_score(flat, envelope, 0.4, 0.0, 4.0), 0.0)

    def test_missing_audio_falls_back_rather_than_inventing_evidence(self):
        speaker = self._track(1, [9.0, 1.0, 9.0, 1.0, 9.0, 1.0, 9.0, 1.0])
        self.assertEqual(frames._audio_sync_score(speaker, None, 0.4, 0.0, 4.0), 0.0)

    def test_too_few_overlapping_samples_is_not_evidence(self):
        envelope = np.array([2.0, -1.0, 2.0, -1.0], dtype=np.float64)
        short = self._track(1, [9.0, 1.0])
        self.assertEqual(frames._audio_sync_score(short, envelope, 0.4, 0.0, 4.0), 0.0)


class ShotLeadInTest(unittest.TestCase):
    """What the frame sits on before anyone in a new shot has spoken."""

    def test_the_opening_does_not_jump_to_whoever_speaks_next(self):
        # Reported at 0:04: the camera cuts to a two-shot while the previous
        # speaker is still finishing off-screen, and the crop committed to the
        # upcoming speaker 1.2s before he opened his mouth. Back-filling the
        # lead-in with the first proven label is what caused that.
        labels = [None, None, None, 7, 7, 7]
        filled = frames._fill_uncertain_labels(labels, fallback_id=3, lead_in_id=3)
        self.assertEqual(filled[:3], [3, 3, 3], "the opening holds, it does not pre-empt")
        self.assertEqual(filled[3:], [7, 7, 7], "and moves once someone actually speaks")

    def test_without_a_lead_in_subject_it_behaves_as_before(self):
        labels = [None, None, 7, 7]
        self.assertEqual(frames._fill_uncertain_labels(labels, fallback_id=3), [7, 7, 7, 7])

    def test_a_pause_after_speech_still_holds_the_speaker(self):
        # Mid-shot silence must not surrender the frame; only the opening is
        # treated differently.
        labels = [7, None, None, 7]
        self.assertEqual(frames._fill_uncertain_labels(labels, 3, lead_in_id=3), [7, 7, 7, 7])

    def test_a_shot_where_nobody_ever_speaks_holds_the_lead_in(self):
        self.assertEqual(
            frames._fill_uncertain_labels([None, None, None], 3, lead_in_id=5), [5, 5, 5]
        )


class VoiceIdentityTest(unittest.TestCase):
    """Speaker embeddings computed locally, and the limits of trusting them."""

    @staticmethod
    def _identity(index):
        vector = np.zeros(128, dtype=np.float32)
        vector[index] = 1.0
        return vector

    def _spans(self, label, start, end):
        return [{"speaker": label, "start_s": start, "end_s": end}]

    def test_model_is_vendored(self):
        self.assertTrue(
            frames.SPEAKER_MODEL_PATH.exists(), f"missing model at {frames.SPEAKER_MODEL_PATH}"
        )

    def test_a_label_seen_on_one_face_answers_for_that_face(self):
        face = self._identity(1)
        identity = frames._diarized_identity_for(
            0.0, 4.0, {"VOICE_00": [face]}, self._spans("VOICE_00", 0.0, 4.0)
        )
        self.assertIsNotNone(identity)
        self.assertTrue(frames._same_person(identity, face))

    def test_a_label_seen_on_two_faces_answers_for_neither(self):
        # Two co-hosts measured 0.810 against each other and 0.740 against
        # themselves, so the voice model merges them into one label. Answering
        # from a merged label would override real per-moment evidence with a
        # coin flip, which is how the wrong host ends up centred.
        merged = {"VOICE_01": [self._identity(1), self._identity(2)]}
        self.assertIsNone(
            frames._diarized_identity_for(0.0, 4.0, merged, self._spans("VOICE_01", 0.0, 4.0))
        )

    def test_only_unambiguous_shots_may_teach_a_voice_its_face(self):
        # A choice that diarization itself influenced must never be read back as
        # proof, or a merged label can never be caught being merged.
        self.assertIn("single_visible_face", frames.VOICE_LEARNING_REASONS)
        self.assertIn("audio_synced_speaker", frames.VOICE_LEARNING_REASONS)
        self.assertNotIn("active_speaker_motion", frames.VOICE_LEARNING_REASONS)
        self.assertTrue(frames.VOICE_LEARNING_REASONS <= frames.PROVEN_REASONS)

    def test_log_mel_is_mean_normalised_at_the_expected_width(self):
        tone = np.sin(np.arange(24000, dtype=np.float32) * 0.05) * 0.2
        features = frames._log_mel(tone, 16000)
        self.assertEqual(features.shape[1], 80)
        self.assertLess(float(np.max(np.abs(features.mean(axis=0)))), 1e-3)

    def test_mel_filterbank_covers_the_requested_band_only(self):
        bank = frames._mel_filterbank(16000, 400, 80, 20.0, 7600.0)
        self.assertEqual(bank.shape, (80, 201))
        self.assertTrue(np.all(bank >= 0.0))
        # Every filter must carry energy, or the model reads a dead band.
        self.assertTrue(np.all(bank.sum(axis=1) > 0.0))

    def test_a_missing_model_degrades_instead_of_failing(self):
        # A runner without the model must still render, using the previous
        # evidence, rather than crashing the job.
        original = frames.SPEAKER_MODEL_PATH
        frames.SPEAKER_MODEL_PATH = Path("/nonexistent-speaker-model.onnx")
        try:
            self.assertEqual(frames._voice_segments(Path("/nonexistent.mp4"), 10.0), [])
        finally:
            frames.SPEAKER_MODEL_PATH = original

if __name__ == "__main__":
    unittest.main()
