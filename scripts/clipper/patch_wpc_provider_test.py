#!/usr/bin/env python3

from __future__ import annotations

import pathlib
import tempfile
import unittest

from patch_wpc_provider import ORIGINAL, PATCHED, patch_provider


class PatchWpcProviderTests(unittest.TestCase):
    def test_exact_provider_patch_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = pathlib.Path(temp) / "getpot_wpc.py"
            target.write_text(f"before\n{ORIGINAL}\nafter\n", encoding="utf-8")
            self.assertTrue(patch_provider(target))
            self.assertFalse(patch_provider(target))
            self.assertIn(PATCHED, target.read_text(encoding="utf-8"))

    def test_unknown_provider_layout_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = pathlib.Path(temp) / "getpot_wpc.py"
            target.write_text("unexpected upstream layout\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "layout changed"):
                patch_provider(target)


if __name__ == "__main__":
    unittest.main()
