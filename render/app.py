"""Single consumer with fail-closed heartbeats and ephemeral working files."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

STOP = threading.Event()
MAX_BYTES = 1_000_000_000
ACTIVE = {'status': 'idle', 'last_poll': 0}

class Api:
    def __init__(self):
        self.base = os.environ['WORKER_URL'].rstrip('/')
        self.secret = os.environ['INTERNAL_SECRET']
    def post(self, path, data):
        res = requests.post(self.base + path, json=data,
                            headers={'Authorization': 'Bearer ' + self.secret}, timeout=20)
        res.raise_for_status()
        return res.json()

def terminate(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()

def execute(api, job):
    cancelled = threading.Event()
    finished = threading.Event()
    state = {'status': 'running', 'progress': 0}
    lock = threading.Lock()
    start = time.monotonic()
    def update(**data):
        with lock:
            state.update(data)
    def report(**data):
        with lock:
            payload = dict(state)
        payload.update(data, lease=job['lease'])
        response = api.post('/internal/jobs/' + job['id'], payload)
        if response.get('cancel'):
            cancelled.set()
            raise RuntimeError('cancelled')
    def heartbeat():
        while not finished.is_set():
            try:
                if STOP.is_set() or time.monotonic() - start > 3600:
                    cancelled.set()
                    return
                report()
            except Exception:
                cancelled.set()  # No lease confirmation: stop work.
                return
            finished.wait(10)
    heart = threading.Thread(target=heartbeat, daemon=True)
    heart.start()
    key = f"results/{job['id']}.{job['format']}"
    try:
        with tempfile.TemporaryDirectory(prefix='youtube-') as directory:
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('download.py')), json.dumps(job), directory],
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            def read_progress():
                for line in process.stdout:
                    try:
                        data = json.loads(line)
                        if 'error' not in data:
                            update(**data)
                    except (ValueError, TypeError):
                        pass
            reader = threading.Thread(target=read_progress, daemon=True)
            reader.start()
            try:
                while process.poll() is None:
                    size = sum(p.stat().st_size for p in Path(directory).glob('*') if p.is_file())
                    if cancelled.is_set() or STOP.is_set() or time.monotonic()-start > 3600 or size > 2 * MAX_BYTES:
                        raise RuntimeError('cancelled_or_limit')
                    time.sleep(1)
                reader.join(timeout=5)
                if process.returncode != 0 or cancelled.is_set():
                    raise RuntimeError('download_failed')
            finally:
                terminate(process)
                process.stdout.close()
            output = Path(directory) / f"output.{job['format']}"
            if not output.is_file() or not 0 < output.stat().st_size <= MAX_BYTES:
                raise RuntimeError('output_limit')
            update(status='uploading', progress=99)
            report()  # Record the object key before R2 receives data.
            upload_path = '/internal/jobs/' + job['id'] + '/upload/'
            headers = {'Authorization': 'Bearer ' + api.secret, 'X-Job-Lease': job['lease']}
            def upload_request(operation, method='POST', **kwargs):
                response = requests.request(method, api.base + upload_path + operation,
                                            headers=headers, timeout=45, **kwargs)
                response.raise_for_status()
                return response.json()
            upload_request('start')
            parts = []
            with output.open('rb') as file:
                while chunk := file.read(8 * 1024 * 1024):
                    if cancelled.is_set() or STOP.is_set() or time.monotonic()-start > 3600:
                        raise RuntimeError('cancelled')
                    number = len(parts) + 1
                    parts.append(upload_request('part?number=' + str(number), 'PUT', data=chunk))
            upload_request('complete', json={'parts': parts})
            # Stop intermediate reports before committing terminal state.
            finished.set()
            heart.join(timeout=25)
            if cancelled.is_set() or STOP.is_set():
                raise RuntimeError('cancelled')
            report(status='completed', progress=100)
    except Exception:
        finished.set()
        heart.join(timeout=25)
        try:
            report(status='failed', progress=0)
        except Exception:
            pass
        # Cleanup owns deletion: a completed report may have been committed
        # even when its HTTP response was lost. Never delete a committed result.
        print('job_failed', flush=True)
    finally:
        finished.set()
        heart.join(timeout=25)

def consume():
    api = Api()
    while not STOP.is_set():
        try:
            result = api.post('/internal/claim', {})
            ACTIVE['last_poll'] = time.time()
            if result.get('job'):
                ACTIVE['status'] = 'busy'
                execute(api, result['job'])
                ACTIVE['status'] = 'idle'
            else:
                STOP.wait(5)
        except Exception:
            print('poll_failed', flush=True)
            STOP.wait(10)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/health':
            self.send_response(404); self.end_headers(); return
        payload = json.dumps({'status': 'ok', 'consumer': ACTIVE['status']}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers(); self.wfile.write(payload)
    def log_message(self, *_args): pass

def main():
    for name in ('WORKER_URL','INTERNAL_SECRET'):
        if not os.environ.get(name):
            raise RuntimeError('Missing configuration: ' + name)
    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '10000'))), Handler)
    consumer = threading.Thread(target=consume, daemon=True)
    consumer.start()
    def shutdown(_signal, _frame):
        STOP.set()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    server.serve_forever()
    STOP.set()
    consumer.join(timeout=40)
    server.server_close()

if __name__ == '__main__':
    main()
