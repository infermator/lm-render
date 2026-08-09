import json
import os
import platform
import subprocess
from pathlib import Path

out = {
    'python': platform.python_version(),
    'platform': platform.platform(),
    'env': {
        'CUDA_VISIBLE_DEVICES': os.environ.get('CUDA_VISIBLE_DEVICES'),
        'NVIDIA_VISIBLE_DEVICES': os.environ.get('NVIDIA_VISIBLE_DEVICES'),
        'KAGGLE_KERNEL_RUN_TYPE': os.environ.get('KAGGLE_KERNEL_RUN_TYPE'),
    },
    'dev_nvidia': sorted(str(p) for p in Path('/dev').glob('nvidia*')),
}

try:
    out['nvidia_smi_path'] = subprocess.run(['which', 'nvidia-smi'], text=True, capture_output=True).stdout.strip() or None
except Exception as exc:
    out['nvidia_smi_error'] = repr(exc)

try:
    import torch
    out['torch'] = {
        'version': torch.__version__,
        'cuda_version': torch.version.cuda,
        'cuda_available': torch.cuda.is_available(),
        'device_count': torch.cuda.device_count(),
    }
    if torch.cuda.is_available():
        out['torch']['device_name'] = torch.cuda.get_device_name(0)
        out['torch']['capability'] = list(torch.cuda.get_device_capability(0))
except Exception as exc:
    out['torch_error'] = repr(exc)

Path('/kaggle/working').mkdir(parents=True, exist_ok=True)
Path('/kaggle/working/gpu-probe.json').write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2), flush=True)
