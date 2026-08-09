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
STAGE_FILE = WORKING / 'musetalk-stage.json'
ERROR_FILE = WORKING / 'musetalk-error.log'


def log(message: str) -> None:
    print(f'[reaction-musetalk] {message}', flush=True)


def stage(name: str, **extra) -> None:
    WORKING.mkdir(parents=True, exist_ok=True)
    payload = {'stage': name, **extra}
    STAGE_FILE.write_text(json.dumps(payload, indent=2))
    log(f'STAGE {name}')


def run(args, *, cwd=None) -> str:
    args = [str(x) for x in args]
    log('$ ' + ' '.join(args))
    proc = subprocess.Popen(
        args,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    tail = []
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line, end='', flush=True)
        tail.append(line.rstrip())
        if len(tail) > 160:
            tail.pop(0)
    code = proc.wait()
    output = '\n'.join(tail)
    if code != 0:
        raise RuntimeError(f'Command failed ({code}): {" ".join(args)}\n--- tail ---\n{output}')
    return output


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
    stage('installing_runtime')
    packages = [
        'setuptools<81',
        'numpy==1.26.4',
        'diffusers==0.30.2',
        'accelerate==0.28.0',
        'opencv-python-headless==4.9.0.80',
        'soundfile==0.12.1',
        'transformers==4.39.2',
        'huggingface_hub==0.30.2',
        'librosa==0.11.0',
        'einops==0.8.1',
        'gdown',
        'requests',
        'imageio[ffmpeg]',
        'omegaconf',
        'ffmpeg-python',
        'moviepy<2',
        'tqdm',
    ]
    run([sys.executable, '-m', 'pip', 'install', '-q', *packages])


def patch_modern_runtime() -> None:
    # MuseTalk's upstream preprocessing imports the MMLab stack. Modern Kaggle
    # images frequently use Python/PyTorch combos without matching mmcv wheels.
    # For inference we only need a reliable face crop, so use MuseTalk's own
    # bundled SFD detector and bypass MMPose entirely.
    preprocessing = REPO / 'musetalk' / 'utils' / 'preprocessing.py'
    preprocessing.write_text(r'''import sys
from pathlib import Path

import cv2
import numpy as np
import torch

UTILS_DIR = Path(__file__).resolve().parent
if str(UTILS_DIR) not in sys.path:
    sys.path.insert(0, str(UTILS_DIR))

from face_detection import FaceAlignment, LandmarksType

coord_placeholder = (0.0, 0.0, 0.0, 0.0)
device = 'cuda' if torch.cuda.is_available() else 'cpu'
fa = FaceAlignment(LandmarksType._2D, flip_input=False, device=device)


def read_imgs(img_list):
    frames = []
    for img_path in img_list:
        frame = cv2.imread(str(img_path))
        if frame is None:
            raise RuntimeError(f'Could not read frame: {img_path}')
        frames.append(frame)
    return frames


def _safe_bbox(f, frame):
    if f is None:
        return coord_placeholder
    x1, y1, x2, y2 = [int(v) for v in f[:4]]
    h, w = frame.shape[:2]
    x1 = max(0, min(w - 2, x1))
    y1 = max(0, min(h - 2, y1))
    x2 = max(x1 + 1, min(w, x2))
    y2 = max(y1 + 1, min(h, y2))
    if x2 - x1 < 24 or y2 - y1 < 24:
        return coord_placeholder
    return (x1, y1, x2, y2)


def get_landmark_and_bbox(img_list, upperbondrange=0):
    frames = read_imgs(img_list)
    if not frames:
        return [], []
    detections = fa.get_detections_for_batch(np.asarray(frames))
    coords = [_safe_bbox(det, frame) for det, frame in zip(detections, frames)]
    return coords, frames


def get_bbox_range(img_list, upperbondrange=0):
    coords, _ = get_landmark_and_bbox(img_list, upperbondrange)
    valid = [c for c in coords if c != coord_placeholder]
    return f'Total frame: {len(coords)}; detected: {len(valid)}; bbox_shift: {upperbondrange}'
''')

    # PyTorch 2.6+ changed torch.load's default to weights_only=True. MuseTalk's
    # trusted upstream checkpoints include objects that require the legacy load.
    # sitecustomize is imported automatically by the inference subprocess.
    (REPO / 'sitecustomize.py').write_text(r'''import torch
_original_torch_load = torch.load

def _reaction_torch_load(*args, **kwargs):
    kwargs.setdefault('weights_only', False)
    return _original_torch_load(*args, **kwargs)

torch.load = _reaction_torch_load
''')


def download_weights() -> None:
    stage('downloading_weights')
    # Use huggingface_hub directly instead of upstream download_weights.sh,
    # which relies on CLI/mirror behavior that has changed over time.
    script = r'''
from pathlib import Path
from huggingface_hub import hf_hub_download

root = Path("models")

def hf(repo, filename, local_dir):
    Path(local_dir).mkdir(parents=True, exist_ok=True)
    hf_hub_download(repo_id=repo, filename=filename, local_dir=local_dir)

hf("TMElyralab/MuseTalk", "musetalkV15/musetalk.json", root)
hf("TMElyralab/MuseTalk", "musetalkV15/unet.pth", root)
hf("stabilityai/sd-vae-ft-mse", "config.json", root / "sd-vae")
hf("stabilityai/sd-vae-ft-mse", "diffusion_pytorch_model.bin", root / "sd-vae")
hf("openai/whisper-tiny", "config.json", root / "whisper")
hf("openai/whisper-tiny", "pytorch_model.bin", root / "whisper")
hf("openai/whisper-tiny", "preprocessor_config.json", root / "whisper")
'''
    run([sys.executable, '-c', script], cwd=REPO)

    face_dir = REPO / 'models' / 'face-parse-bisent'
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
    WORKING.mkdir(parents=True, exist_ok=True)
    ERROR_FILE.unlink(missing_ok=True)
    STAGE_FILE.unlink(missing_ok=True)

    if not JOB_FILE.exists():
        raise RuntimeError(f'Missing {JOB_FILE}')
    job = json.loads(JOB_FILE.read_text())
    video_url = str(job.get('video_url') or '').strip()
    audio_url = str(job.get('audio_url') or '').strip()
    if not video_url or not audio_url:
        raise RuntimeError('job.json requires video_url and audio_url')

    shutil.rmtree(TEMP, ignore_errors=True)
    TEMP.mkdir(parents=True, exist_ok=True)

    stage('gpu_preflight')
    run(['nvidia-smi'])
    run([sys.executable, '-c', 'import torch,sys; print(sys.version); print(torch.__version__); print(torch.version.cuda); print(torch.cuda.get_device_name(0)); print(torch.cuda.get_device_capability(0))'])

    install_runtime()

    stage('cloning_musetalk')
    run(['git', 'clone', '--depth', '1', 'https://github.com/TMElyralab/MuseTalk.git', str(REPO)])
    patch_modern_runtime()
    download_weights()

    raw_video = TEMP / 'source-input'
    raw_audio = TEMP / 'audio-input'
    video = TEMP / 'source-25fps.mp4'
    audio = TEMP / 'speech.wav'

    stage('downloading_media')
    download(video_url, raw_video)
    download(audio_url, raw_audio)

    stage('normalizing_media')
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
        '  bbox_shift: 0\n'
    )
    result_dir = TEMP / 'results'
    result_dir.mkdir(parents=True, exist_ok=True)

    stage('preflight_import')
    run([
        sys.executable, '-c',
        'import torch; from musetalk.utils.preprocessing import get_landmark_and_bbox; '
        'from musetalk.utils.face_parsing import FaceParsing; print("MuseTalk imports OK")',
    ], cwd=REPO)

    stage('musetalk_inference')
    run([
        sys.executable, '-m', 'scripts.inference',
        '--inference_config', str(config),
        '--result_dir', str(result_dir),
        '--unet_model_path', 'models/musetalkV15/unet.pth',
        '--unet_config', 'models/musetalkV15/musetalk.json',
        '--version', 'v15',
        '--use_float16',
    ], cwd=REPO)

    candidates = sorted(result_dir.rglob('*.mp4'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        candidates = sorted(REPO.rglob('*.mp4'), key=lambda p: p.stat().st_mtime, reverse=True)
        candidates = [p for p in candidates if 'results' in p.parts]
    if not candidates:
        raise RuntimeError('MuseTalk completed but no output MP4 was found')

    stage('publishing_result')
    final = WORKING / 'lipsync-result.mp4'
    shutil.copy2(candidates[0], final)
    metadata = {
        'engine': 'MuseTalk 1.5',
        'preprocessing': 'bundled_sfd_bbox_fallback',
        'video_url': video_url,
        'audio_url': audio_url,
        'result': final.name,
    }
    (WORKING / 'lipsync-result.json').write_text(json.dumps(metadata, indent=2))
    stage('complete', result=final.name, size_bytes=final.stat().st_size)
    log(f'Done: {final} ({final.stat().st_size / 1024 / 1024:.1f} MiB)')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        WORKING.mkdir(parents=True, exist_ok=True)
        details = traceback.format_exc()
        ERROR_FILE.write_text(details)
        try:
            stage_payload = json.loads(STAGE_FILE.read_text()) if STAGE_FILE.exists() else {}
        except Exception:
            stage_payload = {}
        stage_payload['failed'] = True
        STAGE_FILE.write_text(json.dumps(stage_payload, indent=2))
        print(details, flush=True)
        raise
