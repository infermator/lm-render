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
