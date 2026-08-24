#!/usr/bin/env python3
"""Make the pinned WPC browser provider compatible with hosted Linux CI.

nodriver must own the sandbox setting; adding --no-sandbox in a browser wrapper
does not update its Config object and Chrome can exit before the debugging
socket is ready. This patch is deliberately exact and fails closed if the
pinned provider changes upstream.
"""

from __future__ import annotations

import importlib.util
import pathlib


ORIGINAL = """        return nodriver.core.config.Config(
            headless=False,
            browser_executable_path=browser_executable_path,
            browser_args=browser_args
        )"""

PATCHED = """        return nodriver.core.config.Config(
            headless=False,
            browser_executable_path=browser_executable_path,
            browser_args=browser_args,
            sandbox=False
        )"""


def patch_provider(path: pathlib.Path) -> bool:
    source = path.read_text(encoding="utf-8")
    if PATCHED in source:
        return False
    if source.count(ORIGINAL) != 1:
        raise RuntimeError("Pinned WPC provider layout changed; refusing an unsafe browser patch")
    path.write_text(source.replace(ORIGINAL, PATCHED), encoding="utf-8")
    return True


def main() -> int:
    spec = importlib.util.find_spec("yt_dlp_plugins.extractor.getpot_wpc")
    if not spec or not spec.origin:
        raise RuntimeError("Pinned WPC provider is not installed")
    path = pathlib.Path(spec.origin).resolve()
    changed = patch_provider(path)
    print(f"[podcast-source] WPC hosted-runner sandbox patch {'applied' if changed else 'already present'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
