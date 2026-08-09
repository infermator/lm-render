#!/usr/bin/env python3
import argparse
import json
import shutil
from pathlib import Path

from gradio_client import Client, handle_file


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--video-url', required=True)
    parser.add_argument('--audio-url', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--space', default='trymonolith/MuseTalk')
    parser.add_argument('--quality', default='Medium', choices=['Low', 'Medium', 'High'])
    parser.add_argument('--fps', type=float, default=25)
    args = parser.parse_args()

    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    client = Client(args.space, verbose=False)
    result = client.predict(
        audio_file=handle_file(args.audio_url),
        video_file=handle_file(args.video_url),
        fps=args.fps,
        quality=args.quality,
        api_name='/generate_lipsync_video',
    )

    if not isinstance(result, (tuple, list)) or not result:
        raise RuntimeError(f'Unexpected MuseTalk response: {result!r}')

    candidate = result[0]
    candidate_path = getattr(candidate, 'path', candidate)
    source = Path(str(candidate_path))
    if not source.exists() or source.stat().st_size < 1024:
        raise RuntimeError(f'MuseTalk returned no usable video: {result!r}')

    shutil.copy2(source, output)
    metadata = {
        'ok': True,
        'provider': 'huggingface_public_musetalk',
        'space': args.space,
        'quality': args.quality,
        'fps': args.fps,
        'status': str(result[1]) if len(result) > 1 else None,
        'bytes': output.stat().st_size,
        'output': str(output),
    }
    print(json.dumps(metadata), flush=True)


if __name__ == '__main__':
    main()
