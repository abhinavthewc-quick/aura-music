import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prepare_audio_versions import prepare, upload_prepared
from audio_version_worker import track_identity


class PrepareVersionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.output = self.root / 'source', self.root / 'staged'
        for folder in ('BASS', 'BASS_REVERB'):
            (self.source / folder).mkdir(parents=True)

    def audio(self, stem):
        for folder in ('BASS', 'BASS_REVERB'):
            (self.source / folder / f'{stem}_{folder}.mp3').write_bytes(b'unchanged source bytes')

    def original(self, path):
        return {'type':'file','path':path,'size':100,'xetHash':'a' * 64}

    def prepared(self):
        self.audio('Artist_-_Song_[abcdefghijk]')
        report = prepare(self.source,self.output,[self.original('originals/Artist - Song [abcdefghijk].opus')])
        for entry in report['files_to_upload']:
            entry['duration'] = 60
        return report

    def publish(self, report, missing=('bass-reverb',), changed=False, fail=False):
        calls = []
        class Registry:
            def call(_, action, **fields):
                calls.append((action,fields))
                if action == 'claimOne':
                    return {'tracks':[] if not missing else [{'ref':'video:abcdefghijk','storage_key':'abcdefghijk',
                        'original_hash':('b' if changed else 'a') * 64,'missing':list(missing)}]}
                if action == 'complete' and fail:
                    raise RuntimeError('Publication unavailable')
                return {'ok':True}
        with patch('prepare_audio_versions.run_command') as command, patch('prepare_audio_versions.log'):
            outcome = upload_prepared(report,self.output,Registry(),{'bucket':'test/bucket','jobs':4})
        return outcome,calls,command

    def test_canonical_clean_paths_for_video_and_filename_songs_without_a_registry_file(self):
        self.audio('Artist_-_Song_[abcdefghijk]')
        self.audio('Other_Artist_-_No_ID_Song')
        name = 'Other Artist - No ID Song.mp3'
        report = prepare(self.source,self.output,[self.original('originals/Artist - Song [abcdefghijk].opus'),self.original('originals/' + name)])
        self.assertEqual((report['songs'],report['files']),(2,4))
        key = track_identity(name)[1]
        self.assertEqual({entry['path'] for entry in report['files_to_upload']},
            {f'versions/{k}/{mode}.mp3' for k in ('abcdefghijk',key) for mode in ('bass','bass-reverb')})
        for entry in report['files_to_upload']:
            self.assertEqual((self.output / entry['path']).read_bytes(),b'unchanged source bytes')
        self.assertEqual([path.name for path in self.output.glob('*.json')],['upload-report.json'])
        self.assertNotIn('tracks',json.loads((self.output / 'upload-report.json').read_text()))

    def test_ambiguous_originals_fail_before_staging(self):
        self.audio('Artist_-_Song')
        for items in ([],[self.original('Artist - Song.mp3'),self.original('Artist - Song.opus')]):
            with self.assertRaisesRegex(ValueError,'Unmatched files'):
                prepare(self.source,self.output,items)
            self.assertFalse(self.output.exists())

    def test_duplicate_video_renditions_fail_before_staging(self):
        self.audio('Artist_-_Song_[abcdefghijk]')
        self.audio('Renamed_-_Song_[abcdefghijk]')
        with self.assertRaisesRegex(ValueError,'Duplicate bass rendition'):
            prepare(self.source,self.output,[self.original('Artist - Song [abcdefghijk].opus')])
        self.assertFalse(self.output.exists())

    def test_targeted_import_uploads_only_missing_mode_and_publishes_to_database(self):
        outcome,calls,command = self.publish(self.prepared())
        self.assertEqual(outcome,{'ready':1,'skipped':0,'failed':0})
        self.assertEqual([action for action,_ in calls],['claimOne','complete'])
        self.assertEqual(calls[0][1]['ref'],'video:abcdefghijk')
        self.assertEqual(set(calls[1][1]['versions']),{'bass-reverb'})
        args = command.call_args.args[0]
        self.assertEqual(args[:3],['hf','buckets','sync'])
        self.assertEqual(args[-2:],['hf://buckets/test/bucket/versions/abcdefghijk','--no-delete'])
        self.assertEqual([p.name for p in Path(args[3]).iterdir()],['bass-reverb.mp3'])

    def test_ready_tracks_are_skipped_without_uploads(self):
        outcome,calls,command = self.publish(self.prepared(),missing=())
        self.assertEqual(outcome['skipped'],1)
        self.assertEqual([a for a,_ in calls],['claimOne'])
        command.assert_not_called()

    def test_changed_original_or_prepared_bytes_are_rejected_before_upload(self):
        report = self.prepared()
        outcome,calls,command = self.publish(report,changed=True)
        self.assertEqual(outcome['failed'],1)
        self.assertEqual(calls[-1][0],'fail')
        command.assert_not_called()
        (self.output / report['files_to_upload'][1]['path']).write_bytes(b'changed')
        outcome,_,command = self.publish(report)
        self.assertEqual(outcome['failed'],1)
        command.assert_not_called()

    def test_missing_partner_or_unprobed_audio_fails_before_any_upload(self):
        report = self.prepared()
        report['files_to_upload'] = report['files_to_upload'][:1]
        outcome,_,command = self.publish(report,missing=('bass','bass-reverb'))
        self.assertEqual(outcome['failed'],1)
        command.assert_not_called()
        report = self.prepared()
        report['files_to_upload'][1].pop('duration')
        outcome,_,command = self.publish(report,missing=('bass','bass-reverb'))
        self.assertEqual(outcome['failed'],1)
        command.assert_not_called()

    def test_failed_publication_retains_prepared_and_uploaded_files_for_retry(self):
        report = self.prepared()
        outcome,calls,command = self.publish(report,fail=True)
        self.assertEqual(outcome['failed'],1)
        self.assertEqual([action for action,_ in calls],['claimOne','complete','fail'])
        self.assertTrue((self.output / report['files_to_upload'][1]['path']).exists())
        self.assertTrue((Path(command.call_args.args[0][3]) / 'bass-reverb.mp3').exists())


if __name__ == '__main__':
    unittest.main()
