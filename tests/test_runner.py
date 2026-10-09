import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('download', 'render/download.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeDownloader:
    def __init__(self, opts): self.opts = opts
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def extract_info(self, *_args, **_kwargs): return self.info
    def process_ie_result(self, info, download):
        self.opts['progress_hooks'][0]({'status':'downloading','downloaded_bytes':10,'total_bytes':10})
        Path(self.opts['outtmpl'].replace('%(ext)s', self.extension)).write_bytes(b'media')
    info = {'title':'test','live_status':'not_live','availability':'public'}
    extension = 'mp4'

class RunnerTests(unittest.TestCase):
    def job(self, fmt='mp4'): return {'url':'https://www.youtube.com/watch?v=abcdefghijk','format':fmt,'quality':'720'}
    def test_video_and_audio(self):
        for fmt in ('mp4','mp3'):
            with tempfile.TemporaryDirectory() as directory, patch.object(module.yt_dlp,'YoutubeDL',FakeDownloader):
                FakeDownloader.extension = fmt
                module.run(self.job(fmt),directory)
                self.assertTrue((Path(directory)/('output.'+fmt)).exists())
    def test_live_and_private_rejected(self):
        original = FakeDownloader.info
        try:
            for info in ({'is_live':True},{'availability':'private'},{'_type':'playlist'}):
                FakeDownloader.info = info
                with tempfile.TemporaryDirectory() as directory, patch.object(module.yt_dlp,'YoutubeDL',FakeDownloader):
                    with self.assertRaises(RuntimeError): module.run(self.job(),directory)
        finally: FakeDownloader.info = original

if __name__ == '__main__': unittest.main()

# Integration around the consumer: use a real short-lived child but no network.
app_spec = importlib.util.spec_from_file_location('app', 'render/app.py')
app = importlib.util.module_from_spec(app_spec)
app_spec.loader.exec_module(app)

class ConsumerTests(unittest.TestCase):
    def test_upload_failure_cancellation_and_temporary_cleanup(self):
        import subprocess
        real_popen = subprocess.Popen
        for scenario in ('success', 'upload_failure', 'cancel'):
            calls = []
            directories = []
            class Api:
                base = 'https://example.test'
                secret = 'test'
                def post(self, path, payload):
                    calls.append(dict(payload))
                    return {'cancel': scenario == 'cancel'}
            class Response:
                def raise_for_status(self):
                    if scenario == 'upload_failure': raise RuntimeError('upload_failed')
                def json(self): return {'partNumber':1,'etag':'test'}
            def spawn(args, **kwargs):
                directories.append(args[-1])
                return real_popen([app.sys.executable, '-c',
                    "from pathlib import Path; import sys; (Path(sys.argv[1])/'output.mp4').write_bytes(b'media')", args[-1]], **kwargs)
            with patch.object(app.subprocess, 'Popen', side_effect=spawn), patch.object(app.requests, 'request', return_value=Response()):
                app.execute(Api(), {'id':'test','lease':'lease','format':'mp4'})
            self.assertTrue(directories)
            self.assertTrue(all(not Path(d).exists() for d in directories))
            if scenario == 'success': self.assertEqual(calls[-1]['status'], 'completed')
            elif scenario == 'upload_failure': self.assertEqual(calls[-1]['status'], 'failed')
            else: self.assertFalse(any(c['status']=='completed' for c in calls))
