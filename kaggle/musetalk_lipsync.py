import json
import shutil
import subprocess
import sys
import traceback
from pathlib import Path

import requests

WORKING = Path('/kaggle/working')
TEMP = Path('/kaggle/temp/reaction-musetalk')
REPO = TEMP / 'MuseTalk'
JOB_FILE = Path(__file__).resolve().parent / 'job.json'
ERROR_FILE = WORKING / 'lipsync-error.txt'


def log(message: str) -> None:
    print(f'[reaction-musetalk] {message}', flush=True)


def run(args, *, cwd=None, env=None) -> None:
    log('$ ' + ' '.join(str(x) for x in args))
    subprocess.run([str(x) for x in args], cwd=cwd, env=env, check=True)


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f'Downloading {url} -> {dest}')
    with requests.get(url, stream=True, timeout=180) as response:
        response.raise_for_status()
        with dest.open('wb') as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)


def install_runtime() -> None:
    # Avoid the old mmcv/mmpose stack. A 2026 MuseTalk compatibility report shows
    # modern Python/PyTorch works when preprocessing is replaced with face-alignment.
    packages = [
        'numpy<2',
        'diffusers==0.30.2',
        'accelerate==0.28.0',
        'opencv-python-headless==4.9.0.80',
        'soundfile==0.12.1',
        'transformers==4.39.2',
        'huggingface_hub==0.30.2',
        'librosa==0.11.0',
        'einops==0.8.1',
        'requests',
        'imageio[ffmpeg]',
        'omegaconf',
        'ffmpeg-python',
        'moviepy<2',
        'face-alignment==1.4.1',
        'gdown',
    ]
    run([sys.executable, '-m', 'pip', 'install', '-q', '--upgrade', *packages])


def patch_preprocessing() -> None:
    target = REPO / 'musetalk' / 'utils' / 'preprocessing.py'
    patched = r'''import os
import cv2
import numpy as np
import torch
from tqdm import tqdm
import face_alignment

coord_placeholder = (0.0, 0.0, 0.0, 0.0)
device = 'cuda' if torch.cuda.is_available() else 'cpu'
fa = face_alignment.FaceAlignment(
    face_alignment.LandmarksType.TWO_D,
    flip_input=False,
    device=device,
)


def read_imgs(img_list):
    frames = []
    print('reading images...')
    for img_path in tqdm(img_list):
        frames.append(cv2.imread(img_path))
    return frames


def _bbox_from_landmarks(frame):
    landmarks = fa.get_landmarks_from_image(frame)
    if not landmarks:
        return coord_placeholder
    pts = np.asarray(landmarks[0], dtype=np.float32)
    h, w = frame.shape[:2]
    x1 = float(np.min(pts[:, 0])); x2 = float(np.max(pts[:, 0]))
    y1 = float(np.min(pts[:, 1])); y2 = float(np.max(pts[:, 1]))
    bw = max(1.0, x2 - x1); bh = max(1.0, y2 - y1)
    # MuseTalk wants a stable face region, not a tight mouth crop.
    x1 -= 0.12 * bw; x2 += 0.12 * bw
    y1 -= 0.18 * bh; y2 += 0.10 * bh
    x1 = max(0, int(round(x1))); y1 = max(0, int(round(y1)))
    x2 = min(w, int(round(x2))); y2 = min(h, int(round(y2)))
    if x2 <= x1 or y2 <= y1:
        return coord_placeholder
    return (x1, y1, x2, y2)


def get_landmark_and_bbox(img_list, upperbondrange=0):
    frames = read_imgs(img_list)
    coords = []
    last_valid = None
    for frame in tqdm(frames):
        box = _bbox_from_landmarks(frame)
        if box == coord_placeholder and last_valid is not None:
            box = last_valid
        if box != coord_placeholder:
            last_valid = box
        coords.append(box)
    valid = sum(1 for box in coords if box != coord_placeholder)
    print(f'face-alignment bbox success: {valid}/{len(coords)}')
    if not valid:
        raise RuntimeError('No face detected in avatar video')
    return coords, frames


def get_bbox_range(img_list, upperbondrange=0):
    return f'face-alignment preprocessing; bbox_shift={upperbondrange}'
'''
    target.write_text(patched)
    log('Patched MuseTalk preprocessing to face-alignment backend')


def download_models() -> None:
    from huggingface_hub import snapshot_download

    models = REPO / 'models'
    snapshot_download(
        repo_id='TMElyralab/MuseTalk',
        local_dir=str(models),
        allow_patterns=['musetalkV15/musetalk.json', 'musetalkV15/unet.pth'],
    )
    snapshot_download(
        repo_id='stabilityai/sd-vae-ft-mse',
        local_dir=str(models / 'sd-vae'),
        allow_patterns=['config.json', 'diffusion_pytorch_model.bin'],
    )
    snapshot_download(
        repo_id='openai/whisper-tiny',
        local_dir=str(models / 'whisper'),
        allow_patterns=['config.json', 'pytorch_model.bin', 'preprocessor_config.json'],
    )
    face_dir = models / 'face-parse-bisent'
    face_dir.mkdir(parents=True, exist_ok=True)
    run([
        sys.executable, '-m', 'gdown',
        '--id', '154JgKpzCPW82qINcVieuPH3fZ2e0P812',
        '-O', str(face_dir / '79999_iter.pth'),
    ])
    download(
        'https://download.pytorch.org/models/resnet18-5c106cde.pth',
        face_dir / 'resnet18-5c106cde.pth',
    )


def main() -> None:
    if not JOB_FILE.exists():
        raise RuntimeError(f'Missing {JOB_FILE}')
    job = json.loads(JOB_FILE.read_text())
    video_url = str(job.get('video_url') or '').strip()
    audio_url = str(job.get('audio_url') or '').strip()
    if not video_url or not audio_url:
        raise RuntimeError('job.json requires video_url and audio_url')

    shutil.rmtree(TEMP, ignore_errors=True)
    TEMP.mkdir(parents=True, exist_ok=True)
    WORKING.mkdir(parents=True, exist_ok=True)
    ERROR_FILE.unlink(missing_ok=True)

    log('GPU check')
    run(['nvidia-smi'])
    install_runtime()

    run(['git', 'clone', '--depth', '1', 'https://github.com/TMElyralab/MuseTalk.git', str(REPO)])
    patch_preprocessing()
    download_models()

    raw_video = TEMP / 'source-input.mp4'
    raw_audio = TEMP / 'audio-input'
    video = TEMP / 'source-25fps.mp4'
    audio = TEMP / 'speech.wav'
    download(video_url, raw_video)
    download(audio_url, raw_audio)

    run([
        'ffmpeg', '-y', '-i', str(raw_video),
        '-an', '-vf', 'fps=25', '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '18', '-pix_fmt', 'yuv420p', str(video),
    ])
    run([
        'ffmpeg', '-y', '-i', str(raw_audio),
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(audio),
    ])

    config = TEMP / 'test.yaml'
    config.write_text(
        'task_0:\n'
        f'  video_path: "{video}"\n'
        f'  audio_path: "{audio}"\n'
    )
    result_dir = TEMP / 'results'
    result_dir.mkdir(parents=True, exist_ok=True)

    run([
        sys.executable, '-m', 'scripts.inference',
        '--inference_config', str(config),
        '--result_dir', str(result_dir),
        '--unet_model_path', 'models/musetalkV15/unet.pth',
        '--unet_config', 'models/musetalkV15/musetalk.json',
        '--version', 'v15',
        '--batch_size', '4',
        '--use_float16',
    ], cwd=REPO)

    candidates = sorted(result_dir.rglob('*.mp4'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        candidates = [
            p for p in sorted(REPO.rglob('*.mp4'), key=lambda p: p.stat().st_mtime, reverse=True)
            if 'results' in p.parts
        ]
    if not candidates:
        raise RuntimeError('MuseTalk completed but no output MP4 was found')

    final = WORKING / 'lipsync-result.mp4'
    shutil.copy2(candidates[0], final)
    metadata = {
        'engine': 'MuseTalk 1.5',
        'preprocessing': 'face-alignment-modern',
        'video_url': video_url,
        'audio_url': audio_url,
        'result': final.name,
    }
    (WORKING / 'lipsync-result.json').write_text(json.dumps(metadata, indent=2))
    log(f'Done: {final} ({final.stat().st_size / 1024 / 1024:.1f} MiB)')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        WORKING.mkdir(parents=True, exist_ok=True)
        tb = traceback.format_exc()
        ERROR_FILE.write_text(tb)
        print(tb, flush=True)
        raise
