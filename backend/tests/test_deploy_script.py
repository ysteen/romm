"""Exercise deployment ordering and settings without starting real containers."""

import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


class DeploymentScriptTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="romm-deploy-script-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source_root = Path(__file__).resolve().parents[2]
        (self.root / "scripts").mkdir()
        (self.root / "deploy").mkdir()
        (self.root / "deploy/config.yml").write_text("{}\n")
        source = self.source_root / "scripts/deploy-dosbox-pure.sh"
        self.script = self.root / "scripts/deploy-dosbox-pure.sh"
        shutil.copy2(source, self.script)
        self.env_file = self.root / "deploy/.env"
        self.env_file.write_text("DB_PASSWORD=unchanged-secret\n")
        self.log = self.root / "calls.jsonl"
        fake = self.root / "docker"
        fake.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['DEPLOY_TEST_LOG'], 'a') as out:
    out.write(json.dumps(args) + '\\n')
if args == ['compose', 'version']:
    sys.exit(0)
if 'config' in args:
    env_path = Path(args[args.index('--env-file') + 1])
    env = dict(line.split('=', 1) for line in env_path.read_text().splitlines() if '=' in line)
    root = env_path.parent.parent
    print(json.dumps({'services': {'romm': {
        'environment': {'ROMFORGE_ENABLED': env.get('ROMFORGE_ENABLED', 'false')},
        'volumes': [{'source': str(root/'custom data'/name), 'target': '/romm/'+name}
                    for name in ['config', 'library', 'resources']],
        'ports': [{'published': '8087'}],
        'image': env.get('ROMM_IMAGE') or 'ghcr.io/ysteen/romm-custom:5.4.1'
    }, 'romforge': {'image': env.get('ROMFORGE_IMAGE') or 'ghcr.io/ysteen/romm-romforge:5.4.1'}}}))
if os.environ.get('DEPLOY_TEST_FAIL_BUILD') and args[-2:] == ['build', 'romm']:
    sys.exit(77)
if os.environ.get('DEPLOY_TEST_FAIL_PULL') and 'pull' in args:
    sys.exit(78)
""")
        fake.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{self.root}:{os.environ['PATH']}",
            "DEPLOY_TEST_LOG": str(self.log),
        }

    def run_script(self, *args):
        return subprocess.run(
            ["bash", str(self.script), *args],
            cwd="/tmp",
            env=self.env,
            check=False,
            capture_output=True,
            text=True,
        )

    def actions(self):
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return [
            args[args.index("romforge") + 1 :] for args in calls if "--profile" in args
        ]

    def test_enable_builds_app_before_worker_and_recreates_shared_network(self):
        result = self.run_script("--romforge", "--build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.actions(),
            [
                ["config", "--format", "json"],
                ["build", "romm"],
                ["build", "romforge"],
                ["stop", "romforge"],
                [
                    "up",
                    "-d",
                    "--no-build",
                    "--wait",
                    "--wait-timeout",
                    "360",
                    "database",
                    "romm",
                ],
                ["up", "-d", "--no-build", "--no-deps", "--force-recreate", "romforge"],
                ["ps"],
            ],
        )
        self.assertIn("ROMFORGE_NORMALIZE_3DS_ON_SCAN=true", self.env_file.read_text())
        self.assertTrue((self.root / "custom data/config/romforge/keys").is_dir())
        self.assertTrue((self.root / "custom data/config/config.yml").is_file())
        self.assertTrue((self.root / "custom data/resources").is_dir())
        self.assertNotIn("unchanged-secret", result.stdout + result.stderr)
        self.assertEqual(self.env_file.stat().st_mode & 0o777, 0o600)
        self.assertIn("compose.custom-dosbox-pure.yml", self.log.read_text())

    def test_default_pulls_before_stopping_and_never_builds(self):
        result = self.run_script("--romforge")
        self.assertEqual(result.returncode, 0, result.stderr)
        actions = self.actions()
        self.assertLess(
            actions.index(["pull", "database", "romm", "romforge"]),
            actions.index(["stop", "romforge"]),
        )
        self.assertFalse(any("build" in action for action in actions))
        self.assertNotIn("compose.custom-dosbox-pure.yml", self.log.read_text())

    def test_failed_pull_leaves_running_services_alone(self):
        self.env["DEPLOY_TEST_FAIL_PULL"] = "1"
        result = self.run_script("--romforge")
        self.assertEqual(result.returncode, 1)
        self.assertIn("read:packages", result.stderr)
        self.assertFalse(
            any("stop" in action or "up" in action for action in self.actions())
        )

    def test_old_generated_image_names_migrate_without_changing_secrets(self):
        self.env_file.write_text(
            "DB_PASSWORD=unchanged-secret\nROMM_IMAGE=romm-custom-dosbox-pure:5.3.1\n"
            "ROMFORGE_IMAGE=romm-romforge:local\n"
        )
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DB_PASSWORD=unchanged-secret", self.env_file.read_text())
        self.assertIn("ROMM_IMAGE=\n", self.env_file.read_text())
        self.assertIn("ROMFORGE_IMAGE=\n", self.env_file.read_text())
        self.assertIn(
            "Application image: ghcr.io/ysteen/romm-custom:5.4.1", result.stdout
        )

    def test_explicit_registry_references_are_preserved(self):
        values = "ROMM_IMAGE=example.org/app@sha256:abc\nROMFORGE_IMAGE=example.org/worker:pin\n"
        self.env_file.write_text(values)
        result = self.run_script("--romforge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(values, self.env_file.read_text())
        self.assertIn("Application image: example.org/app@sha256:abc", result.stdout)
        self.assertIn("Worker image: example.org/worker:pin", result.stdout)

    def test_preserves_disabled_normalization_and_never_executes_env(self):
        marker = self.root / "must-not-exist"
        self.env_file.write_text(
            f"DB_PASSWORD=$(touch {marker})\nROMFORGE_NORMALIZE_3DS_ON_SCAN=false\n"
        )
        result = self.run_script("--romforge", "--no-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ROMFORGE_NORMALIZE_3DS_ON_SCAN=false", self.env_file.read_text())
        self.assertFalse(marker.exists())
        self.assertFalse(any("build" in action for action in self.actions()))

    def test_disable_stops_worker_without_deleting_data(self):
        self.env_file.write_text("ROMFORGE_ENABLED=true\n")
        result = self.run_script("--no-romforge", "--no-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["stop", "romforge"], self.actions())
        self.assertFalse(any("--force-recreate" in action for action in self.actions()))
        self.assertIn("ROMFORGE_ENABLED=false", self.env_file.read_text())
        self.assertIn(["pull", "database", "romm"], self.actions())

    def test_default_keeps_an_existing_enabled_worker(self):
        self.env_file.write_text("ROMFORGE_ENABLED=true\n")
        result = self.run_script("--no-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any("--force-recreate" in action for action in self.actions()))

    def test_new_install_disables_jsdos(self):
        self.env_file.unlink()
        result = self.run_script("--no-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DISABLE_JSDOS=true", self.env_file.read_text())
        self.assertNotIn("ROMM_IMAGE=romm-custom", self.env_file.read_text())
        self.assertIn("ROMFORGE_ENABLED=false", self.env_file.read_text())

    def test_preserves_explicit_jsdos_opt_in(self):
        self.env_file.write_text("DISABLE_JSDOS=false\n")
        result = self.run_script("--no-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DISABLE_JSDOS=false", self.env_file.read_text())

    def test_failed_build_leaves_running_services_alone(self):
        self.env["DEPLOY_TEST_FAIL_BUILD"] = "1"
        result = self.run_script("--romforge", "--build")
        self.assertEqual(result.returncode, 77)
        self.assertFalse(
            any("stop" in action or "up" in action for action in self.actions())
        )

    def test_installation_bundle_has_only_deployment_files(self):
        bundle = self.root / "install.tar.gz"
        result = subprocess.run(
            [
                "bash",
                str(self.source_root / "scripts/package-deployment.sh"),
                str(bundle),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(bundle) as archive:
            self.assertEqual(
                set(archive.getnames()),
                {
                    "compose.dosbox-pure.yml",
                    "compose.romforge.yml",
                    "deploy/.env.example",
                    "deploy/config.yml",
                    "scripts/deploy-dosbox-pure.sh",
                    "docs/PRIVATE_GHCR.md",
                    "LICENSE",
                },
            )


if __name__ == "__main__":
    unittest.main()
