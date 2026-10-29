"""Package publication must fail closed when visibility cannot be verified."""

import importlib.util
import io
import os
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location(
    "check_private_ghcr",
    Path(__file__).resolve().parents[1] / "tools/check_private_ghcr.py",
)
assert spec and spec.loader
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PrivatePackageTests(unittest.TestCase):
    def setUp(self):
        self.token = patch.dict(os.environ, {"GH_TOKEN": "test-token"})
        self.token.start()
        self.addCleanup(self.token.stop)

    def test_private_package_is_accepted(self):
        with patch.object(
            guard, "urlopen", return_value=io.BytesIO(b'{"visibility":"private"}')
        ) as request:
            guard.check_package("owner", "image")
        self.assertEqual(
            request.call_args.args[0].headers["Authorization"], "Bearer test-token"
        )

    def test_public_internal_and_unspecified_visibility_are_rejected(self):
        for value in (b'{"visibility":"public"}', b'{"visibility":"internal"}', b"{}"):
            with (
                self.subTest(value=value),
                patch.object(guard, "urlopen", return_value=io.BytesIO(value)),
                self.assertRaisesRegex(RuntimeError, "non-private"),
            ):
                guard.check_package("owner", "image")

    def test_missing_package_is_only_allowed_before_publication(self):
        error = HTTPError("https://api.github.com/", 404, "Not found", {}, None)
        with patch.object(guard, "urlopen", side_effect=error):
            guard.check_package("owner", "image", allow_missing=True)
            with self.assertRaisesRegex(RuntimeError, "HTTP 404"):
                guard.check_package("owner", "image")

    def test_authentication_and_server_errors_never_allow_publication(self):
        for status in (401, 403, 429, 500):
            error = HTTPError("https://api.github.com/", status, "Failure", {}, None)
            with (
                self.subTest(status=status),
                patch.object(guard, "urlopen", side_effect=error),
                self.assertRaisesRegex(RuntimeError, f"HTTP {status}"),
            ):
                guard.check_package("owner", "image", allow_missing=True)

    def test_missing_token_fails_before_network_access(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(guard, "urlopen") as request,
        ):
            with self.assertRaisesRegex(RuntimeError, "GH_TOKEN"):
                guard.check_package("owner", "image", allow_missing=True)
            request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
