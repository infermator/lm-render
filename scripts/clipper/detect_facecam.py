#!/usr/bin/env python3
import json
import math
import sys
from pathlib import Path

try:
    import cv2
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"opencv unavailable: {exc}"}))
    sys.exit(2)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "video path required"}))
        return 2

    video = Path(sys.argv[1])
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "cannot open video"}))
        return 2

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frames / fps if fps > 0 and frames > 0 else 0

    cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(str(cascade_path))
    if cascade.empty():
        print(json.dumps({"ok": False, "error": "face cascade unavailable"}))
        return 2

    # Sample across the selected clip. Persistent detections in roughly the same
    # region are much more likely to be a creator facecam than an in-game face.
    sample_times = []
    if duration > 0:
        for frac in (0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.92):
            sample_times.append(duration * frac)
    else:
        sample_times = [0]

    detections = []
    for t in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        min_side = max(28, int(min(width, height) * 0.035))
        faces = cascade.detectMultiScale(gray, scaleFactor=1.12, minNeighbors=5, minSize=(min_side, min_side))
        for x, y, w, h in faces:
            area_ratio = (w * h) / max(1, width * height)
            if area_ratio < 0.001 or area_ratio > 0.18:
                continue
            cx = (x + w / 2) / max(1, width)
            cy = (y + h / 2) / max(1, height)
            detections.append({
                "x": x / max(1, width),
                "y": y / max(1, height),
                "w": w / max(1, width),
                "h": h / max(1, height),
                "cx": cx,
                "cy": cy,
                "area": area_ratio,
            })

    cap.release()

    if not detections:
        print(json.dumps({"ok": True, "detected": False, "source": {"width": width, "height": height}}))
        return 0

    # Cluster by normalized center; a facecam should recur at a stable location.
    clusters = []
    for d in detections:
        best = None
        best_dist = 999
        for c in clusters:
            dist = math.hypot(d["cx"] - c["cx"], d["cy"] - c["cy"])
            if dist < 0.16 and dist < best_dist:
                best = c
                best_dist = dist
        if best is None:
            clusters.append({**d, "items": [d]})
        else:
            best["items"].append(d)
            n = len(best["items"])
            best["cx"] = sum(i["cx"] for i in best["items"]) / n
            best["cy"] = sum(i["cy"] for i in best["items"]) / n

    clusters.sort(key=lambda c: (len(c["items"]), sum(i["area"] for i in c["items"]) / len(c["items"])), reverse=True)
    c = clusters[0]
    items = c["items"]
    confidence = min(1.0, len(items) / max(3, len(sample_times) * 0.7))

    avg_x = sum(i["x"] for i in items) / len(items)
    avg_y = sum(i["y"] for i in items) / len(items)
    avg_w = sum(i["w"] for i in items) / len(items)
    avg_h = sum(i["h"] for i in items) / len(items)

    # Expand generously around the face so shoulders/body and facecam border survive.
    crop_w = clamp(avg_w * 3.2, 0.20, 0.48)
    crop_h = clamp(avg_h * 3.6, 0.20, 0.52)
    cx = clamp(avg_x + avg_w / 2, crop_w / 2, 1 - crop_w / 2)
    cy = clamp(avg_y + avg_h / 2, crop_h / 2, 1 - crop_h / 2)
    x = clamp(cx - crop_w / 2, 0, 1 - crop_w)
    y = clamp(cy - crop_h / 2, 0, 1 - crop_h)

    print(json.dumps({
        "ok": True,
        "detected": confidence >= 0.35,
        "confidence": round(confidence, 3),
        "samples": len(sample_times),
        "hits": len(items),
        "source": {"width": width, "height": height},
        "crop": {"x": round(x, 5), "y": round(y, 5), "w": round(crop_w, 5), "h": round(crop_h, 5)},
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
