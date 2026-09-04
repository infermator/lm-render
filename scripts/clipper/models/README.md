# Vendored face detection model

`face_detection_yunet_2023mar.onnx` — YuNet, from
[opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet),
MIT licensed, by Shiqi Yu and Wei Wu.

It is committed here rather than downloaded because the renderer must not depend
on a third-party host being reachable at render time. Inference runs locally on
CPU through OpenCV's DNN module; nothing leaves the runner.

It replaced `haarcascade_frontalface_default.xml`, which matched a taxidermy
lion on a podcast set as a face while missing the host beside it because he had
turned his head. YuNet finds that host at 0.93 confidence and does not report
the lion at all.

`face_recognition_sface_2021dec.onnx` — SFace, from
[opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface),
Apache-2.0, by Zhong Yaoyao et al.

Committed for the same reason as the detector: a render must not depend on a
third-party host. It answers "is this the same person as before" across a camera
cut, which position cannot — the same host sits at a different x in every angle.
Measured on a finished clip: the same person scores 0.79-0.89 across cuts, two
different people 0.00-0.03, so the two populations do not overlap.

`speaker_embedding_campplus.onnx` — CAM++ speaker embedding, from
[WeSpeaker](https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus-LM),
Apache-2.0, trained on VoxCeleb.

The transcript's own diarization labels every segment of a three-person podcast
`SPEAKER_00`, so nothing downstream can tell who is talking. Classical features
cannot fix that: MFCC statistics score every pair of utterances 0.97-1.00, and
pitch varies by 46 Hz within a single speaker's own sentence.

These embeddings do separate them. Measured on a reference clip, the guest scores
0.70-0.76 against his own utterances and 0.08-0.25 against everyone else, and
clustering every speech chunk reproduces the independently-derived
single-speaker shots exactly. Two co-hosts with similar voices remain close
(~0.8), so this reliably answers "guest or host", not "which host".

## active_speaker_light_asd.onnx

Audiovisual active-speaker detection: given a face crop sequence and the
synchronised audio, it returns P(this visible face is speaking) per frame. This
is what separates the two co-hosts when both share one camera shot - the only
evidence that can, since neither host ever appears alone on camera and the
CAM++ voice embeddings merge them (0.810 across versus 0.740 within).

- Upstream: https://github.com/Junhua-Liao/Light-ASD (CVPR 2023,
  "A Light Weight Model for Active Speaker Detection")
- Licence: MIT (Copyright (c) 2023 Liao Junhua)
- Source weights: `weight/pretrain_AVA_CVPR.model`, committed in that repo
  (no third-party host, no runtime download)
  SHA-256 `d44bc3ea7baa8e0946fa3921311714a630ed8b90a1928fab0dbe30d918909317`
- Vendored ONNX SHA-256
  `450ab05d4e43c104feedc9503fd12ff9d467b35e1048ee4a7f7fedbf89a530f1` (3.92 MB)

Export notes, both of which are silent traps:

1. The final classifier lives in the training wrapper's `lossAV.FC`, not in
   `ASD_Model`. Exporting the model alone yields a 128-d embedding rather than a
   score, which looks plausible and is meaningless.
2. `audio_encoder` applies `MaxPool3d` to a 4-D tensor, which torch reads as
   unbatched but ONNX cannot represent. Depth is 1, so the equivalent
   `MaxPool2d` was substituted for export. onnxruntime additionally rejects the
   `dilations` attribute on 3-D MaxPool even when correctly sized; all values
   are the default 1 and the attribute is stripped.

The export was verified against the unmodified torch model: max absolute
difference 1.4e-8. The MFCC front end is reimplemented in numpy in
`podcast_speaker_frames.py` (verified to 7.4e-13 against
python_speech_features) so the runner needs only onnxruntime.

Input contract: audio `(1, 4T, 13)` MFCC at 100fps; visual `(1, T, 112, 112)`
grayscale face crops at 25fps, boxed at 1.40x face height, 224x224 then centre
112x112. Output `(T,)` probabilities.
