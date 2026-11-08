"""Check installer initialization, preservation and package validation without Docker."""

import hashlib
import json
import shutil
import subprocess  # nosec B404
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "deploy/netplay/install.py"


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copy2(SOURCE, self.root / "install.py")
        (self.root / "config.example.yml").write_text("exclude: {}\n")
        files = {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in self.root.iterdir()
        }
        (self.root / "manifest.json").write_text(json.dumps({"sha256": files}))

    def run_installer(self, *args):
        return subprocess.run(  # nosec B603 B607: fixed commands with argument vectors, no shell
            [sys.executable, str(self.root / "install.py"), *args],
            capture_output=True,
            text=True,
        )

    def test_init_and_secret_preservation(self):
        result = self.run_installer(
            "init",
            "--origin",
            "https://romm.example.com:8443",
            "--native-host",
            "native.example.com",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        env = self.root / ".env"
        original = env.read_bytes()
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        values = dict(line.split("=", 1) for line in original.decode().splitlines())
        self.assertEqual(
            values["NETPLAY_BRIDGE_PUBLIC_URL"], "https://romm.example.com:8443/netplay"
        )
        self.assertEqual(values["NETPLAY_BRIDGE_PUBLIC_HOST"], "native.example.com")
        self.assertEqual(len(values["NETPLAY_BRIDGE_TOKEN"]), 64)
        self.assertNotEqual(values["DB_PASSWORD"], values["DB_ROOT_PASSWORD"])
        self.assertNotIn(values["NETPLAY_BRIDGE_TOKEN"], result.stdout)
        self.assertTrue((self.root / "data/config/config.yml").is_file())
        repeated = self.run_installer("init", "--origin", "https://other.example.com")
        self.assertNotEqual(repeated.returncode, 0)
        self.assertEqual(env.read_bytes(), original)

    def test_invalid_origin_creates_no_secrets(self):
        for origin in [
            "http://romm.example.com",
            "https://user:pass@romm.example.com",
            "https://romm.example.com/path",
            "https://romm.example.com?token=x",
        ]:
            with self.subTest(origin=origin):
                result = self.run_installer("init", "--origin", origin)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / ".env").exists())

    def test_corruption_is_rejected_before_initialization(self):
        (self.root / "config.example.yml").write_text("corrupt")
        result = self.run_installer("init", "--origin", "https://romm.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertFalse((self.root / ".env").exists())

    def test_manifest_cannot_escape_bundle(self):
        (self.root / "manifest.json").write_text(
            json.dumps({"sha256": {"../outside": "bad"}})
        )
        result = self.run_installer("init", "--origin", "https://romm.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe package path", result.stderr)
        self.assertFalse((self.root / ".env").exists())


if __name__ == "__main__":
    unittest.main()
