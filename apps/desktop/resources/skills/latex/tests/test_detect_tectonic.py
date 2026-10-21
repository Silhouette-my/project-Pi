from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.fspath(Path(__file__).resolve().parents[1] / "scripts"))

import detect_tectonic  # noqa: E402


class DetectTectonicTest(unittest.TestCase):
    def test_shared_app_compiler_works_without_plugin_binary(self) -> None:
        with tempfile.TemporaryDirectory(prefix="latex app café ") as directory:
            root = Path(directory)
            executable = root / "relocated app" / "tectonic" / detect_tectonic.executable_name()
            executable.parent.mkdir(parents=True)
            executable.touch()
            with (
                patch.dict(os.environ, {"PI_TECTONIC_PATH": os.fspath(executable)}),
                patch.object(detect_tectonic, "plugin_root", return_value=root / "plugin"),
                patch.object(detect_tectonic, "tectonic_version", return_value="Tectonic test"),
            ):
                result = detect_tectonic.detect_tectonic()
            self.assertEqual(result["status"], "available")
            self.assertEqual(result["source"], "app")
            self.assertEqual(result["path"], os.fspath(executable.resolve()))

    def test_standalone_plugin_fallback_survives_invalid_app_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "bin" / detect_tectonic.executable_name()
            executable.parent.mkdir()
            executable.touch()
            for app_path in ["relative/tectonic", os.fspath(root / "missing")]:
                with (
                    self.subTest(app_path=app_path),
                    patch.dict(os.environ, {"CODEX_TECTONIC_PATH": app_path}),
                    patch.object(detect_tectonic, "plugin_root", return_value=root),
                    patch.object(detect_tectonic, "tectonic_version", return_value="Tectonic test"),
                ):
                    result = detect_tectonic.detect_tectonic()
                    self.assertEqual(result["source"], "bundled")
                    self.assertEqual(result["path"], os.fspath(executable.resolve()))


if __name__ == "__main__":
    unittest.main()
