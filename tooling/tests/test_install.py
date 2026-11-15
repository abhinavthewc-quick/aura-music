import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer',ROOT / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_launcher_runs_from_another_directory_and_install_preserves_private_config(self):
        with tempfile.TemporaryDirectory(prefix='aura tooling ') as temporary:
            root = Path(temporary)
            launcher = installer.install(root/'bin',root/'config',root/'data')
            config = root/'config/version-worker.json'
            self.assertEqual(config.stat().st_mode & 0o777,0o600)
            config.write_text('{"private":"preserved"}')
            installer.install(root/'bin',root/'config',root/'data')
            self.assertEqual(config.read_text(),'{"private":"preserved"}')
            result = subprocess.run([str(launcher),'--help'],cwd=root,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('--dry-run',result.stdout)
            config.unlink()
            installer.install(root/'bin',root/'config',root/'data')
            self.assertTrue(config.exists())
            self.assertFalse((root/'data/install-backups').exists())

    def test_existing_launcher_is_backed_up_before_linking(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'bin').mkdir()
            (root/'bin/aura-version-worker').write_text('old launcher')
            launcher = installer.install(root/'bin',root/'config',root/'data')
            self.assertTrue(launcher.is_symlink())
            backups = list((root/'data/install-backups').iterdir())
            self.assertEqual(len(backups),1)
            self.assertEqual(backups[0].read_text(),'old launcher')
