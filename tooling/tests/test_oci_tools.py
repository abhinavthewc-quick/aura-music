import importlib
import json
import sys
import tempfile
import unittest
from datetime import datetime,timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'cache'))
from oci_client import FIELDS,load_config,signed_request,cache_prefix
from configure_pages import activate,initialize


class CacheToolsTests(unittest.TestCase):
    def test_initialization_creates_private_files_and_preserves_existing_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'private settings/cache.json'
            initialize(path)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            config=json.loads(path.read_text())
            token=Path(config['admin_token_file'])
            self.assertEqual(token.stat().st_mode & 0o777,0o600)
            existing=token.read_text()
            config['OCI_ACCESS_KEY']='FAKE-SAVED-KEY'
            path.write_text(json.dumps(config))
            initialize(path)
            self.assertEqual(json.loads(path.read_text())['OCI_ACCESS_KEY'],'FAKE-SAVED-KEY')
            self.assertEqual(token.read_text(),existing)

    def config(self,root):
        token=root/'admin.token'
        token.write_text('fake-test-admin-token-at-least-thirty-two-characters')
        token.chmod(0o600)
        return {'site':'https://aura.example','project':'test-project','admin_token_file':str(token),
            'OCI_NAMESPACE':'testnamespace','OCI_BUCKET_NAME':'test-cache','OCI_REGION':'test-region-1',
            'OCI_ACCESS_KEY':'FAKE-ACCESS','OCI_SECRET_KEY':'FAKE-SECRET'}

    def test_private_configuration_is_required_and_missing_credentials_are_named(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            config=self.config(root)
            path=root/'cache.json'
            path.write_text(json.dumps(config))
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError,'0600'):
                load_config(path,credentials=True)
            path.chmod(0o600)
            self.assertEqual(load_config(path,credentials=True)['OCI_BUCKET_NAME'],'test-cache')
            config['OCI_SECRET_KEY']=''
            path.write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError,'OCI_SECRET_KEY'):
                load_config(path,credentials=True)

    def test_oci_failure_cannot_modify_pages_and_bulk_input_contains_only_cache_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            config=self.config(Path(folder))
            with patch('configure_pages.check_bucket',side_effect=RuntimeError('OCI unavailable')),patch('configure_pages.subprocess.run') as run:
                with self.assertRaises(RuntimeError):
                    activate(config)
                run.assert_not_called()
            with patch('configure_pages.check_bucket'),patch('configure_pages.subprocess.run') as run:
                activate(config)
            self.assertEqual(run.call_count,2)
            for call,environment in zip(run.call_args_list,('production','preview')):
                args=call.args[0]
                self.assertEqual(args[-2:],['--env',environment])
                content=json.loads(call.kwargs['input'])
                self.assertEqual(set(content),set(FIELDS)|{'AUDIO_ADMIN_TOKEN'})
                self.assertNotIn(config['OCI_SECRET_KEY'],' '.join(args))
                self.assertTrue(call.kwargs['capture_output'])

    def test_signing_preserves_unicode_and_reserved_filename_characters_without_leaking_into_query(self):
        with tempfile.TemporaryDirectory() as folder:
            config=self.config(Path(folder))
            request=signed_request(config,path='folder/பாட்டு + %?#.mp3',query={'prefix':'a+?#'},now=datetime(2026,1,1,tzinfo=timezone.utc))
            from urllib.parse import urlparse,unquote,parse_qs
            url=urlparse(request.full_url)
            self.assertEqual(unquote(url.path),'/test-cache/folder/பாட்டு + %?#.mp3')
            self.assertEqual(parse_qs(url.query),{'prefix':['a+?#']})
            self.assertEqual(url.fragment,'')
            self.assertIn('20260101/test-region-1/s3/aws4_request',request.headers['Authorization'])
            self.assertNotIn(config['OCI_SECRET_KEY'],request.full_url)
            with self.assertRaises(ValueError):
                signed_request(config,path='../other.mp3')
            with self.assertRaises(ValueError):
                signed_request(config,method='DELETE',path='track.mp3')

    def test_cache_prefix_scopes_each_hugging_face_archive(self):
        self.assertNotEqual(cache_prefix('a/one'),cache_prefix('a/two'))
        self.assertRegex(cache_prefix('a/one'),r'^aura-cache/v2/[a-f0-9]{20}/$')
