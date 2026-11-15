import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('database_tools',Path(__file__).resolve().parents[1]/'database/versions.py')
database = importlib.util.module_from_spec(spec)
spec.loader.exec_module(database)


class DatabaseTests(unittest.TestCase):
    def test_backups_cannot_be_written_inside_git(self):
        with patch.object(database.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'outside the repository'):
                database.backup(['wrangler','d1','versions'],database.ROOT/'tooling/backups')
            run.assert_not_called()

    def test_migration_backs_up_first_and_applies_only_version_schemas(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls=[]
            def run(args,**kwargs):
                calls.append(args)
                if 'export' in args:
                    Path(args[args.index('--output')+1]).write_text('CREATE TABLE example(id);')
            with patch.object(database.subprocess,'run',side_effect=run):
                database.migrate(['wrangler','d1','versions','--config','path with spaces'],Path(temporary))
            self.assertEqual([args[2] for args in calls],['export','execute','execute'])
            self.assertEqual([Path(args[-1]).name for args in calls[1:]],['002_audio_versions.sql','003_audio_processing_admin.sql'])
            self.assertEqual(Path(calls[0][-1]).stat().st_mode & 0o777,0o600)
