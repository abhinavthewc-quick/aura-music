#!/usr/bin/env python3
"""State and failure tests; no network, uploads or installed plugins required."""
import contextlib
import io
import json
import resource
import socket
import subprocess
import sys
import tempfile
import textwrap
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive_storage import plan_layout, prune_plan, verify_plan
from audio_version_worker import Ledger, Registry, STOP, drain, ensure_file_capacity, inventory, process_job, public_json, track_identity


class WorkerTests(unittest.TestCase):
    def tearDown(self):
        STOP.clear()

    def test_progress_updates_do_not_exhaust_files_with_delayed_garbage_collection(self):
        # The user shell can start at 256 descriptors. Exercise real SQLite
        # across four lanes at an even lower limit, without relying on GC.
        program = textwrap.dedent('''\
            import contextlib, gc, os, resource, tempfile
            from concurrent.futures import ThreadPoolExecutor
            from pathlib import Path
            from audio_version_worker import Ledger
            _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            resource.setrlimit(resource.RLIMIT_NOFILE, (128, hard))
            gc.disable()
            with tempfile.TemporaryDirectory() as directory:
                ledger = Ledger(Path(directory) / 'jobs.sqlite')
                before = len(os.listdir('/dev/fd'))
                def update(lane):
                    job = {'ref':str(lane),'original_hash':'source'}
                    for _ in range(100):
                        ledger.record(job,'recipe','processing')
                    ledger.record(job,'recipe','ready')
                with ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(update,range(4)))
                with contextlib.closing(ledger.connect()) as db:
                    assert db.execute("SELECT COUNT(*) FROM jobs WHERE stage='ready'").fetchone()[0] == 4
                assert len(os.listdir('/dev/fd')) <= before + 2
        ''')
        result = subprocess.run([sys.executable,'-c',program],cwd=Path(__file__).resolve().parents[1],
                                capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stdout + result.stderr)

    def test_dns_failure_is_retried_before_claim_without_replaying_uncertain_mutations(self):
        response = io.BytesIO(b'{"tracks":[]}')
        dns = urllib.error.URLError(socket.gaierror(8,'Name lookup failed'))
        registry = Registry('https://aura.test','test-token')
        with patch('audio_version_worker.urllib.request.urlopen',side_effect=[dns,dns,response]) as request, \
             patch.object(STOP,'wait',return_value=False) as wait:
            self.assertEqual(registry.call('claim',owner='owner',limit=1),{'tracks':[]})
            self.assertEqual(request.call_count,3)
            self.assertEqual([call.args[0] for call in wait.call_args_list],[2,4])
            self.assertTrue(response.closed)
        uncertain = urllib.error.URLError(ConnectionResetError('Connection lost'))
        with patch('audio_version_worker.urllib.request.urlopen',side_effect=uncertain) as request:
            with self.assertRaises(urllib.error.URLError):
                registry.call('claim',owner='owner',limit=1)
            self.assertEqual(request.call_count,1)

    def test_dns_retries_are_bounded_and_stop_is_respected(self):
        registry = Registry('https://aura.test','test-token')
        dns = urllib.error.URLError(socket.gaierror(8,'Name lookup failed'))
        with patch('audio_version_worker.urllib.request.urlopen',side_effect=dns) as request, \
             patch.object(STOP,'wait',return_value=False):
            with self.assertRaises(urllib.error.URLError):
                registry.call('status')
            self.assertEqual(request.call_count,4)
        STOP.set()
        with patch('audio_version_worker.urllib.request.urlopen',side_effect=dns) as request:
            with self.assertRaises(urllib.error.URLError):
                registry.call('status')
            self.assertEqual(request.call_count,1)

    def test_http_error_responses_are_closed_for_optional_files_and_registry_rejections(self):
        missing = io.BytesIO(b'not found')
        error = urllib.error.HTTPError('https://aura.test',404,'Not found',{},missing)
        with patch('audio_version_worker.urllib.request.urlopen',side_effect=error):
            self.assertIsNone(public_json('https://aura.test',optional=True))
        self.assertTrue(missing.closed)
        rejected = io.BytesIO(b'{"error":"Lease expired"}')
        error = urllib.error.HTTPError('https://aura.test',409,'Conflict',{},rejected)
        with patch('audio_version_worker.urllib.request.urlopen',side_effect=error):
            with self.assertRaisesRegex(RuntimeError,'HTTP 409: Lease expired'):
                Registry('https://aura.test','test-token').call('complete')
        self.assertTrue(rejected.closed)

    def test_file_limit_headroom_is_local_and_never_lowered(self):
        for limits, expected in [((256,8192),(4096,8192)),((256,1024),(1024,1024)),
                                 ((256,resource.RLIM_INFINITY),(4096,resource.RLIM_INFINITY))]:
            with patch('audio_version_worker.resource.getrlimit',return_value=limits), \
                 patch('audio_version_worker.resource.setrlimit') as setlimit:
                ensure_file_capacity()
                setlimit.assert_called_once_with(resource.RLIMIT_NOFILE,expected)
        with patch('audio_version_worker.resource.getrlimit',return_value=(8192,8192)), \
             patch('audio_version_worker.resource.setrlimit') as setlimit:
            ensure_file_capacity()
            setlimit.assert_not_called()

    def test_identities_survive_original_move_and_versions_never_become_sources(self):
        name = 'Artist - Song.mp3'
        self.assertEqual(track_identity(name), track_identity('originals/' + name))
        video = 'Artist - Song [abcdefghijk].opus'
        self.assertEqual(track_identity(video), track_identity('originals/' + video))
        tree = [{'type': 'file', 'path': video, 'size': 10, 'xetHash': 'a'},
                {'type': 'file', 'path': 'originals/' + video, 'size': 10, 'xetHash': 'a'},
                {'type': 'file', 'path': 'versions/abcdefghijk/bass.mp3', 'size': 20}]
        rows = inventory(tree)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['original_path'], 'originals/' + video)
        self.assertEqual(rows[0]['versions']['bass']['path'], 'versions/abcdefghijk/bass.mp3')

    def test_cleanup_refuses_collisions_changed_sources_and_unverified_copies(self):
        source = {'type': 'file', 'path': 'A.mp3', 'size': 10, 'xetHash': 'a', 'mtime': '2026-11-14T00:00:00Z'}
        plan = plan_layout([source])
        self.assertEqual(plan[0]['target'], 'originals/A.mp3')
        with self.assertRaises(ValueError):
            plan_layout([source, {**source, 'path': 'originals/A.mp3', 'xetHash': 'b'}])
        with patch('archive_storage.batch') as batch:
            with self.assertRaises(ValueError):
                prune_plan('test/bucket', [source], plan)
            batch.assert_not_called()
        with self.assertRaises(ValueError):
            verify_plan([{**source, 'xetHash': 'changed'}, {**source, 'path': 'originals/A.mp3'}], plan)
        self.assertEqual(len(verify_plan([source, {**source, 'path': 'originals/A.mp3'}], plan)), 2)

    def test_empty_encoding_does_not_hide_an_existing_healthy_original(self):
        tree = [
            {'type':'file','path':'originals/A [abcdefghijk].m4a','size':100,'xetHash':'healthy'},
            {'type':'file','path':'originals/A [abcdefghijk].opus','size':0,'xetHash':'0' * 64},
        ]
        rows = inventory(tree)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['original_path'], 'originals/A [abcdefghijk].m4a')

    def run_job(self, directory, fail_publish=False, fail_reports=False):
        work = Path(directory)
        job = {'ref': 'video:abcdefghijk', 'storage_key': 'abcdefghijk', 'original_hash': 'a' * 64,
               'original_path': 'originals/A [abcdefghijk].opus', 'missing': ['bass-reverb']}
        config = {'work': work, 'source_sizes': {job['original_path']: 4}, 'bucket': 'test/bucket', 'aubatch': '/test/aubatch', 'report_progress':fail_reports}
        recipe = 'test-recipe'
        folder = work / 'jobs' / job['storage_key'] / job['original_hash'] / recipe
        folder.mkdir(parents=True,exist_ok=True)
        (folder / 'abcdefghijk.opus').write_bytes(b'test')
        ledger = Ledger(work / 'jobs.sqlite')
        actions = []

        class Registry:
            def call(self, action, **fields):
                actions.append((action, fields))
                if action == 'complete' and fail_publish:
                    raise RuntimeError('Upload verification failed')
                if action == 'progress' and fail_reports:
                    raise RuntimeError('Reporting unavailable')
                return {'ok': True}

        commands = []
        def command(args, logfile, **_):
            commands.append(args)
            if args[0] == '/test/aubatch':
                rendered = Path(args[args.index('-o') + 1])
                for mode in ('BASS', 'BASS_REVERB'):
                    target = rendered / mode / f'abcdefghijk_{mode}.mp3'
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(b'processed MP3')
            else:
                self.assertEqual(args[:3], ['hf', 'buckets', 'sync'])
                self.assertTrue((Path(args[3]) / 'bass-reverb.mp3').is_file())

        with patch('audio_version_worker.run_command', side_effect=command), patch('audio_version_worker.subprocess.check_output', return_value=b'60'), \
             patch('audio_version_worker.probe_mp3', return_value=62):
            result = process_job(job, 'owner', Registry(), config, ledger, recipe, {})
        with contextlib.closing(ledger.connect()) as db:
            stage = db.execute('SELECT stage FROM jobs').fetchone()[0]
        return result, actions, stage, commands, folder

    def test_partial_job_uploads_only_missing_version_and_publishes_after_sync(self):
        with tempfile.TemporaryDirectory() as directory:
            result, actions, stage, commands, folder = self.run_job(directory)
            self.assertTrue(result)
            self.assertEqual(stage, 'ready')
            self.assertEqual([action for action, _ in actions], ['complete'])
            files = actions[0][1]['versions']
            self.assertEqual(set(files), {'bass-reverb'})
            self.assertEqual(files['bass-reverb']['bytes'], len(b'processed MP3'))
            self.assertEqual(len(files['bass-reverb']['sha256']), 64)
            self.assertEqual(len(commands), 2)
            self.assertFalse((folder / 'rendered').exists())

    def test_failed_publication_keeps_finished_files_and_records_retryable_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result, actions, stage, commands, folder = self.run_job(directory, True)
            self.assertFalse(result)
            self.assertEqual(stage, 'failed')
            self.assertEqual([action for action, _ in actions], ['complete', 'fail'])
            self.assertTrue((folder / 'rendered/BASS_REVERB/abcdefghijk_BASS_REVERB.mp3').is_file())
            self.assertTrue((folder / 'upload/bass-reverb/bass-reverb.mp3').is_file())

    def test_retry_reuses_verified_outputs_and_publishes_without_rendering_again(self):
        with tempfile.TemporaryDirectory() as directory:
            self.run_job(directory,True)
            result, actions, stage, commands, folder = self.run_job(directory)
            self.assertTrue(result)
            self.assertEqual(stage,'ready')
            self.assertEqual(len(commands),1)
            self.assertEqual(commands[0][:3],['hf','buckets','sync'])
            self.assertEqual([action for action,_ in actions],['complete'])
            self.assertFalse((folder/'rendered').exists())

    def test_optional_admin_reporting_failure_does_not_discard_a_valid_job(self):
        with tempfile.TemporaryDirectory() as directory:
            result, actions, stage, commands, folder = self.run_job(directory,fail_reports=True)
            self.assertTrue(result)
            self.assertEqual(stage,'ready')
            self.assertEqual([fields['stage'] for action,fields in actions if action=='progress'],
                             ['downloading','processing','uploading','publishing'])
            self.assertEqual(actions[-1][0],'complete')

    def test_stopped_worker_never_claims_another_song(self):
        STOP.set()
        class Registry:
            def call(self, *_args, **_fields):
                raise AssertionError('Claimed while stopping')
        self.assertEqual(drain({'jobs': 4}, Registry(), None, None, {}, None), (0, 0))

    def test_manual_run_reports_actual_completion_counts(self):
        calls=[]
        class Registry:
            def call(self,action,**fields):
                calls.append((action,fields))
                if action=='claim':
                    return {'tracks':[{'ref':'fixture'}] if sum(a=='claim' for a,_ in calls)==1 else []}
                return {'ok':True}
        with patch('audio_version_worker.process_job',return_value=True):
            self.assertEqual(drain({'jobs':4},Registry(),None,'recipe',{},None),(1,0))
        self.assertEqual(calls[0][0],'runStarted')
        self.assertEqual(calls[-1][0],'runFinished')
        self.assertEqual(calls[-1][1]['attempted'],1)
        self.assertEqual(calls[-1][1]['failed'],0)
        self.assertEqual(calls[-1][1]['status'],'complete')

    def test_claim_network_failure_reports_an_interrupted_run_without_hiding_the_error(self):
        calls=[]
        class Registry:
            def call(self,action,**fields):
                calls.append((action,fields))
                if action=='claim':
                    raise RuntimeError('Registry connection lost')
                return {'ok':True}
        with self.assertRaisesRegex(RuntimeError,'Registry connection lost'):
            drain({'jobs':4},Registry(),None,'recipe',{},None)
        self.assertEqual(calls[-1][0],'runFinished')
        self.assertEqual(calls[-1][1]['status'],'failed')
        self.assertIn('Registry connection lost',calls[-1][1]['error'])


if __name__ == '__main__':
    unittest.main()
