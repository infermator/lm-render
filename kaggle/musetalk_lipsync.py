import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import requests

WORKING = Path('/kaggle/working')
TEMP = Path('/kaggle/temp/reaction-musetalk')
REPO = TEMP / 'MuseTalk'
JOB_FILE = Path(__file__).resolve().parent / 'job.json'


def log(message: str) -> None:
    print(f'[reaction-musetalk] {message}', flush=True)


def run(args, *, cwd=None) -> None:
    log('$ ' + ' '.join(str(x) for x in args))
    subprocess.run([str(x) for x in args], cwd=cwd, check=True)


def download(url: str, dest: Path) -> None:
    log(f'Downloading {url} -> {dest}')
    with requests.get(url, stream=True, timeout=120) as response:
        response.raise_for_status()
        with dest.open('wb') as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)


def install_runtime() -> None:
    # Kaggle already ships CUDA/PyTorch. Install MuseTalk's user-space runtime
    # without forcing its TensorFlow/Gradio demo dependencies onto the image.
    packages = [
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
    ]
    run([sys.executable, '-m', 'pip', 'install', '-q', *packages])


def main() -> None:
    if not JOB_FILE.exists():
        raise RuntimeError(f'Missing {JOB_FILE}')
    job = json.loads(JOB_FILE.read_text())
    video_url = str(job.get('video_url') or '').strip()
    audio_url = str(job.get('audio_url') or '').strip()
    bbox_shift = int(job.get('bbox_shift') or 0)
    if not video_url or not audio_url:
        raise RuntimeError('job.json requires video_url and audio_url')

    shutil.rmtree(TEMP, ignore_errors=True)
    TEMP.mkdir(parents=True, exist_ok=True)
    WORKING.mkdir(parents=True, exist_ok=True)

    log('GPU check')
    run(['nvidia-smi'])
    install_runtime()

    run(['git', 'clone', '--depth', '1', 'https://github.com/TMElyralab/MuseTalk.git', str(REPO)])
    run(['bash', './download_weights.sh'], cwd=REPO)

    raw_video = TEMP / 'source-input'
    raw_audio = TEMP / 'audio-input'
    video = TEMP / 'source-25fps.mp4'
    audio = TEMP / 'speech.wav'
    download(video_url, raw_video)
    download(audio_url, raw_audio)

    # MuseTalk was trained at 25 fps. Normalize only for the lip-sync pass;
    # the Reaction renderer can later place this segment back on its timeline.
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
        f'  bbox_shift: {bbox_shift}\n'
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
    ], cwd=REPO)

    candidates = sorted(result_dir.rglob('*.mp4'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        # Keep this fallback in case upstream changes its result directory.
        candidates = sorted(REPO.rglob('*.mp4'), key=lambda p: p.stat().st_mtime, reverse=True)
        candidates = [p for p in candidates if 'results' in p.parts]
    if not candidates:
        raise RuntimeError('MuseTalk completed but no output MP4 was found')

    final = WORKING / 'lipsync-result.mp4'
    shutil.copy2(candidates[0], final)
    metadata = {
        'engine': 'MuseTalk 1.5',
        'video_url': video_url,
        'audio_url': audio_url,
        'bbox_shift': bbox_shift,
        'result': final.name,
    }
    (WORKING / 'lipsync-result.json').write_text(json.dumps(metadata, indent=2))
    log(f'Done: {final} ({final.stat().st_size / 1024 / 1024:.1f} MiB)')


if __name__ == '__main__':
    main()
