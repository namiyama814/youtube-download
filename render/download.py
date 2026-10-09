"""Isolated download process. stdout is a small JSON progress protocol."""
import json
import os
import sys
from pathlib import Path
import yt_dlp

MAX_BYTES = 1_000_000_000

def emit(**data):
    print(json.dumps(data), flush=True)

class QuietLogger:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass

def run(job, directory):
    quality = job['quality']
    cap = '' if quality == 'best' else f'[height<={quality}]'
    opts = {
        'quiet': True, 'logger': QuietLogger(), 'noplaylist': True,
        'socket_timeout': 20, 'retries': 3, 'fragment_retries': 3,
        'outtmpl': str(Path(directory) / 'output.%(ext)s'),
        'max_filesize': MAX_BYTES, 'js_runtimes': {'node': {}},
        'restrictfilenames': True,
        # Use yt-dlp's documented client + dynamically generated PO Tokens.
        'extractor_args': {
            'youtube': {'player_client': ['mweb'], 'fetch_pot': ['always']},
            'youtubepot-bgutilscript': {'server_home': [os.environ.get('BGUTIL_SERVER_HOME', '/opt/bgutil')]},
        },
        'sleep_interval_requests': 1,
        'sleep_interval': 5, 'max_sleep_interval': 10,

    }
    proxy = os.environ.get('YTDLP_PROXY', '').strip()
    if proxy:
        # Applies to YouTube and PO Token traffic; Worker/R2 traffic stays direct.
        opts['proxy'] = proxy
    if job['format'] == 'mp3':
        opts.update(format='bestaudio/best', postprocessors=[{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}])
    else:
        opts.update(format=f'bv*{cap}+ba/b{cap}', merge_output_format='mp4',
                    postprocessors=[{'key': 'FFmpegVideoConvertor', 'preferedformat': 'mp4'}])
    def progress(data):
        if data['status'] == 'downloading':
            total = data.get('total_bytes') or data.get('total_bytes_estimate') or 0
            downloaded = data.get('downloaded_bytes', 0)
            if downloaded > MAX_BYTES:
                raise RuntimeError('size_limit')
            emit(status='running', progress=min(99, downloaded / total * 100) if total else 0)
    def postprocess(data):
        emit(status='converting', progress=99)
    opts.update(progress_hooks=[progress], postprocessor_hooks=[postprocess])
    with yt_dlp.YoutubeDL(opts) as downloader:
        info = downloader.extract_info(job['url'], download=False)
        if not info or info.get('_type') in ('playlist', 'multi_video') or info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
            raise RuntimeError('unsupported_video')
        if info.get('availability') in ('private', 'premium_only', 'subscriber_only', 'needs_auth'):
            raise RuntimeError('authentication_required')
        emit(title=info.get('title', 'YouTube 動画')[:200], status='running', progress=0)
        downloader.process_ie_result(info, download=True)
    output = Path(directory) / f"output.{job['format']}"
    if not output.is_file() or not 0 < output.stat().st_size <= MAX_BYTES:
        raise RuntimeError('missing_or_oversized_output')

if __name__ == '__main__':
    try:
        run(json.loads(sys.argv[1]), sys.argv[2])
    except Exception as error:
        # Inspect locally, but never emit upstream URLs, cookies or messages.
        message = str(error).lower()
        code = 'download_failed'
        if 'not a bot' in message: code = 'bot_detected'
        elif 'sign in' in message or 'authentication_required' in message: code = 'authentication_required'
        elif 'unavailable' in message or 'removed' in message: code = 'unavailable'
        elif 'timed out' in message or 'network' in message: code = 'network_error'
        elif 'unsupported_video' in message: code = 'unsupported_video'
        elif 'size_limit' in message or 'oversized' in message: code = 'size_limit'
        emit(error=code)
        sys.exit(1)
