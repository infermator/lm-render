#!/usr/bin/env python3

from __future__ import annotations

import unittest

from podcast_storage_contract import assert_storage_project, supabase_project_ref


class PodcastStorageContractTests(unittest.TestCase):
    def test_extracts_exact_supabase_project_ref(self) -> None:
        self.assertEqual(
            supabase_project_ref("https://fyflgsyxlfoygsjrlyyy.supabase.co/"),
            "fyflgsyxlfoygsjrlyyy",
        )

    def test_rejects_credentials_paths_and_non_supabase_hosts(self) -> None:
        for value in [
            "https://user:pass@fyflgsyxlfoygsjrlyyy.supabase.co",
            "https://fyflgsyxlfoygsjrlyyy.supabase.co/rest/v1",
            "https://supabase.example.test",
        ]:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "project origin"):
                supabase_project_ref(value)

    def test_mismatch_is_sanitized(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "^podcast_storage_project_mismatch:") as raised:
            assert_storage_project(
                "https://fyflgsyxlfoygsjrlyyy.supabase.co",
                "ohpmhtcebavqeuxhjkze",
            )
        self.assertNotIn("fyflgsyxlfoygsjrlyyy", str(raised.exception))
        self.assertNotIn("ohpmhtcebavqeuxhjkze", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
