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
