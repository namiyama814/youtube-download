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
