"""Web UI nhỏ để chạy và demo Status Investigation Agent. Chỉ dùng Python standard library.

Chạy:  python3 web/server.py [--port 8000]
Chỉ bind 127.0.0.1. Không bao giờ trả API key qua API hay ghi vào log.
"""
import argparse
import importlib
import importlib.util
import json
import linecache
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter']
KEY_NAMES = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']
OUTPUT_RE = re.compile(r'^[A-Za-z0-9_.-]{1,80}\.json$')
CASE_RE = re.compile(r'^[A-Za-z0-9_-]{1,20}$')
STATIC = {'/app.js': 'text/javascript; charset=utf-8', '/app.css': 'text/css; charset=utf-8'}
RUN_LOCK = threading.Lock()  # importlib.reload không thread-safe; chạy agent tuần tự.
WIP = 'wip'  # "Bản đang sửa (working copy)"
TAG_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')  # tag dùng được làm tên thư mục .versions/<tag>
VERSIONS_DIR = ROOT / '.versions'          # đã có trong .gitignore
VERSION_INDEX = VERSIONS_DIR / 'index.json'  # file output -> version đã tạo ra nó


class Conflict(Exception):
    """File output đã tồn tại; UI phải hỏi người dùng trước khi ghi đè."""


# ---------------------------------------------------------------- versions (git tag)

def git(*args, check=True):
    """Chạy git với list args (không qua shell)."""
    proc = subprocess.run(['git', *args], cwd=str(ROOT), capture_output=True, text=True, encoding='utf-8', errors='replace')
    if check and proc.returncode != 0:
        raise RuntimeError(f'git {args[0]} lỗi: {proc.stderr.strip()[:300]}')
    return proc.stdout


def list_versions():
    """Các git tag (sắp theo version) + bản đang sửa."""
    out = git('tag', '--list', '--sort=version:refname',
              '--format=%(refname:short)%09%(*objectname:short)%09%(objectname:short)%09%(creatordate:short)%09%(contents:subject)', check=False)
    tags = []
    for line in out.splitlines():
        parts = line.split('\t')
        if len(parts) < 5 or not parts[0]:
            continue
        name, peeled, obj, date, subject = parts[:5]
        tags.append({'name': name, 'commit': peeled or obj, 'date': date, 'message': subject,
                     'usable': bool(TAG_RE.match(name))})
    return [{'name': WIP, 'label': 'Bản đang sửa (working copy)', 'message': 'agent.py hiện tại trong thư mục làm việc'}] + tags


def resolve_version(version):
    """Trả (tên, commit sha) cho tag hợp lệ; (WIP, None) cho bản đang sửa. Chỉ nhận tag có trong `git tag --list`."""
    version = str(version or '').strip() or WIP
    if version == WIP:
        return WIP, None
    names = set(git('tag', '--list').split())
    if version not in names or not TAG_RE.match(version):
        raise ValueError(f'Version không hợp lệ: {version!r} (phải là một tag trong git tag --list).')
    sha = git('rev-parse', '--verify', '--quiet', f'refs/tags/{version}^{{commit}}').strip()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError(f'Không resolve được tag {version}.')
    return version, sha


AGENT_CACHE = {}


def load_agent(version):
    """Module agent cho một version. WIP: reload agent.py hiện tại. Tag: nạp `git show <sha>:agent.py`
    thành module riêng `agent_<tag>_<sha>`; không checkout, không ghi đè agent.py.
    Lưu ý: các import bên trong (status_tools, providers…) vẫn là bản hiện tại."""
    name, sha = resolve_version(version)
    if name == WIP:
        import agent
        return importlib.reload(agent), name, None
    if sha in AGENT_CACHE:
        return AGENT_CACHE[sha], name, sha
    source = git('show', f'{sha}:agent.py')
    mod_name = f'agent_{re.sub(r"[^A-Za-z0-9_]", "_", name)}_{sha[:8]}'
    filename = f'<git {name} {sha[:8]}>/agent.py'
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)  # traceback hiện được dòng code
    spec = importlib.util.spec_from_loader(mod_name, loader=None, origin=filename)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = filename
    sys.modules[mod_name] = module
    exec(compile(source, filename, 'exec'), module.__dict__)
    AGENT_CACHE[sha] = module
    return module, name, sha


def ensure_worktree(name, sha):
    """Tạo hoặc tái dùng worktree .versions/<tag> ở đúng commit của tag."""
    path = VERSIONS_DIR / name
    if path.exists():
        head = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        if not head:
            raise RuntimeError(f'{path} tồn tại nhưng không phải git worktree; hãy xoá thủ công.')
        if head != sha:  # tag đã bị dời sang commit khác
            subprocess.run(['git', '-C', str(path), 'checkout', '--detach', '--quiet', sha], check=True, capture_output=True)
        return path
    VERSIONS_DIR.mkdir(exist_ok=True)
    git('worktree', 'prune')
    git('worktree', 'add', '--detach', str(path), sha)
    return path


INDEX_LOCK = threading.Lock()


def read_version_index():
    try:
        data = json.loads(VERSION_INDEX.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def remember_output_version(output, version, sha):
    with INDEX_LOCK:
        data = read_version_index()
        data[output] = {'version': version, 'commit': sha, 'time': time.time()}
        VERSIONS_DIR.mkdir(exist_ok=True)
        VERSION_INDEX.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def file_version(name, index=None, tags=None):
    """Version đã tạo file eval: ưu tiên index; nếu không có thì đoán theo tên eval_<tag>…json / eval_wip…json."""
    index = read_version_index() if index is None else index
    if name in index:
        return index[name].get('version'), 'index'
    tags = tags if tags is not None else [v['name'] for v in list_versions()]
    for tag in sorted(tags, key=len, reverse=True):
        if name == f'eval_{tag}.json' or name.startswith(f'eval_{tag}_'):
            return tag, 'tên file'
    return None, None


def load_dotenv_file(path):
    """Đọc .env đơn giản (KEY=VALUE, cho phép 'export '). Không ghi đè biến đã có."""
    if not path.is_file():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        if line.startswith('export '):
            line = line[len('export '):]
        key, value = line.split('=', 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def redact(text):
    """Xoá mọi giá trị API key khỏi chuỗi trước khi trả ra ngoài (phòng hờ)."""
    if not isinstance(text, str):
        return text
    for name in KEY_NAMES:
        secret = os.environ.get(name)
        if secret and len(secret) >= 6:
            text = text.replace(secret, '***')
    return text


def redact_obj(obj):
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, list):
        return [redact_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {k: redact_obj(v) for k, v in obj.items()}
    return obj


# ---------------------------------------------------------------- fake provider

class ScriptedProvider:
    """Provider giả: trả lần lượt các response trong script, giống FakeProvider trong tests."""

    def __init__(self, script):
        if not isinstance(script, list) or not script:
            raise ValueError('Fake script phải là list không rỗng.')
        self.responses = [self._build(i, s) for i, s in enumerate(script)]
        self.index = 0

    @staticmethod
    def _build(i, step):
        if not isinstance(step, dict):
            raise ValueError(f'Fake script bước {i + 1} phải là object.')
        calls = []
        for j, c in enumerate(step.get('calls') or []):
            args = c.get('arguments', {})
            # arguments dạng string được giữ nguyên (để thử JSON lỗi), object thì dumps.
            args = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
            calls.append({'id': c.get('id') or f'call-{i + 1}-{j + 1}', 'name': c.get('name', ''), 'arguments': args})
        message = {'role': 'assistant', 'content': step.get('content')}
        if calls:
            message['tool_calls'] = [{'id': c['id'], 'type': 'function',
                                      'function': {'name': c['name'], 'arguments': c['arguments']}} for c in calls]
        finish = step.get('finish') or ('tool_calls' if calls else 'stop')
        return {'message': message, 'calls': calls, 'finish': finish, 'usage': step.get('usage') or {}}

    def complete(self, messages, schemas):
        if self.index >= len(self.responses):
            raise RuntimeError(f'Fake script đã hết response (đã dùng {len(self.responses)}).')
        response = self.responses[self.index]
        self.index += 1
        return json.loads(json.dumps(response))  # bản sao, tránh agent sửa script


# ---------------------------------------------------------------- run agent

RUNS = []  # lịch sử các lần chạy trong phiên server (chỉ trong bộ nhớ)
RUNS_LOCK = threading.Lock()


def run_agent_request(body):
    """Chạy agent và lưu bản ghi vào lịch sử để sidebar hiển thị."""
    record = _run_agent(body)
    record.update(id=uuid.uuid4().hex[:10], created=time.time(),
                  question=str(body.get('question') or '').strip())
    with RUNS_LOCK:
        RUNS.append(record)
        del RUNS[:-200]
    return record


def run_summaries():
    with RUNS_LOCK:
        items = list(RUNS)
    out = []
    for r in reversed(items):
        status = (r.get('result') or {}).get('status') if r.get('ok') else 'exception'
        out.append({'id': r['id'], 'created': r['created'], 'question': r['question'], 'status': status,
                    'provider': (r.get('meta') or {}).get('provider'), 'version': (r.get('meta') or {}).get('version')})
    return out


def _run_agent(body):
    question = str(body.get('question') or '').strip()
    mode = body.get('mode', 'snapshot')
    bonus = bool(body.get('bonus'))
    fail = bool(body.get('fail'))
    try:
        max_steps = int(body.get('max_steps', 6))
    except (TypeError, ValueError):
        max_steps = 0
    if not question:
        return {'ok': False, 'exception': 'ValueError: Cần nhập câu hỏi.'}
    if mode not in ('snapshot', 'live'):
        return {'ok': False, 'exception': 'ValueError: mode phải là snapshot hoặc live.'}
    if max_steps < 1 or max_steps > 50:
        return {'ok': False, 'exception': 'ValueError: max_steps phải từ 1 đến 50.'}

    started = time.time()
    meta = {'question': question, 'mode': mode, 'max_steps': max_steps, 'fail': fail, 'bonus': bonus,
            'version': None}  # chỉ ghi version sau khi đã validate (tag có trong git tag --list)
    with RUN_LOCK:
        try:
            agent, meta['version'], sha = load_agent(body.get('version'))  # WIP: luôn lấy agent.py mới nhất
            meta['commit'] = sha[:8] if sha else None
            from status_tools import StatusTools
            if bonus:
                from bonus.tools import BonusTools
                tools = BonusTools(mode)
            else:
                tools = StatusTools(mode, fail=fail)
            if body.get('provider') == 'fake':
                provider = ScriptedProvider(body.get('fake_script'))
                meta.update(provider='fake', model='scripted')
            else:
                from providers import Provider
                name = body.get('provider') or os.getenv('PROVIDER', 'openai')
                model = body.get('model') or os.getenv('MODEL')
                provider = Provider(name, model)
                meta.update(provider=name, model=model)
            result = agent.run_agent(question, provider, tools, max_steps)
        except BaseException as exc:  # noqa: BLE001 — mọi lỗi agent phải hiện lên UI
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            return redact_obj({'ok': False, 'meta': meta, 'elapsed': round(time.time() - started, 2),
                               'exception': f'{type(exc).__name__}: {exc}', 'traceback': traceback.format_exc()})
    if not isinstance(result, dict):
        return redact_obj({'ok': False, 'meta': meta, 'exception': f'run_agent trả {type(result).__name__}, không phải dict.',
                           'raw': repr(result)[:2000]})
    return redact_obj({'ok': True, 'meta': meta, 'elapsed': round(time.time() - started, 2), 'result': result})


# ---------------------------------------------------------------- eval jobs

JOBS = {}
JOBS_LOCK = threading.Lock()


def start_eval(body):
    output = str(body.get('output') or 'eval_results.json').strip()
    if not OUTPUT_RE.match(output):
        raise ValueError('Tên file output chỉ gồm chữ, số, _ . - và kết thúc bằng .json (không có thư mục).')
    version, sha = resolve_version(body.get('version'))
    workdir = ROOT if version == WIP else ensure_worktree(version, sha)
    target = ROOT / output  # luôn ghi về thư mục chính, kể cả khi chạy trong worktree
    if target.exists() and not body.get('overwrite'):
        raise Conflict(f'File {output} đã tồn tại. Xác nhận để ghi đè, hoặc đổi tên.')
    cmd = [sys.executable, '-u', str(workdir / 'evals' / 'run_evals.py'), '--output', str(target)]
    case = str(body.get('case') or '').strip()
    if case:
        if not CASE_RE.match(case):
            raise ValueError('Case ID không hợp lệ.')
        cmd += ['--case', case]
    if body.get('bonus'):
        cmd.append('--bonus')
    for key, flag in (('provider', '--provider'), ('model', '--model'),
                      ('judge_provider', '--judge-provider'), ('judge_model', '--judge-model')):
        value = str(body.get(key) or '').strip()
        if value:
            if key.endswith('provider') and value not in PROVIDERS:
                raise ValueError(f'{key} không hợp lệ.')
            cmd += [flag, value]
    for key, flag in (('max_steps', '--max-steps'), ('workers', '--workers')):
        if body.get(key) not in (None, ''):
            cmd += [flag, str(int(body[key]))]
    settings = effective_eval_settings(body)
    settings.update(version=version, commit=sha[:8] if sha else None)
    with JOBS_LOCK:
        if any(j['status'] == 'running' and j['output'] == output for j in JOBS.values()):
            raise ValueError(f'Đang có eval ghi vào {output}.')
    proc = subprocess.Popen(cmd, cwd=str(workdir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding='utf-8', errors='replace', env=os.environ.copy())
    job = {'id': uuid.uuid4().hex[:8], 'output': output, 'case': case, 'bonus': bool(body.get('bonus')),
           'args': [output if a == str(target) else a for a in cmd[3:]], 'status': 'running', 'returncode': None,
           'started': time.time(), 'finished': None, 'log': [], 'proc': proc,
           'settings': settings, 'output_config': None, 'config_mismatch': []}
    with JOBS_LOCK:
        JOBS[job['id']] = job
    remember_output_version(output, version, sha)

    def pump():
        for line in proc.stdout:
            job['log'].append(redact(line.rstrip('\n')))
            del job['log'][:-500]
        job['returncode'] = proc.wait()
        if job['status'] == 'running':
            job['status'] = 'done' if job['returncode'] == 0 else 'failed'
        job['finished'] = time.time()
        compare_output_config(job)

    threading.Thread(target=pump, daemon=True).start()
    return public_job(job)


def effective_eval_settings(body):
    """Cấu hình thực tế run_evals.py sẽ dùng, tính giống hệt run_evals.py (args > env > mặc định).
    Chỉ đọc PROVIDER/MODEL/JUDGE_PROVIDER/JUDGE_MODEL, không bao giờ đọc key."""
    def pick(key, env_name):
        value = str(body.get(key) or '').strip()
        if value:
            return value, 'tham số'
        env_value = os.getenv(env_name)
        return (env_value, 'env') if env_value else (None, None)
    provider, provider_src = pick('provider', 'PROVIDER')
    if not provider:
        provider, provider_src = 'openai', 'mặc định'
    model, model_src = pick('model', 'MODEL')
    judge_provider, jp_src = pick('judge_provider', 'JUDGE_PROVIDER')
    judge_model, jm_src = pick('judge_model', 'JUDGE_MODEL')
    if not judge_provider:
        judge_provider, jp_src = provider, 'agent'
    if not judge_model:
        judge_model, jm_src = model, 'agent'
    bonus = bool(body.get('bonus'))
    max_steps = int(body['max_steps']) if body.get('max_steps') not in (None, '') else (16 if bonus else 8)
    return {'provider': provider, 'model': model, 'judge_provider': judge_provider, 'judge_model': judge_model,
            'judge_provider_source': jp_src, 'judge_model_source': jm_src,
            'judge_is_agent': judge_provider == provider and judge_model == model,
            'max_steps': max_steps, 'max_steps_default': body.get('max_steps') in (None, ''),
            'dataset': 'bonus' if bonus else 'core'}


def compare_output_config(job):
    """Sau khi job xong, đối chiếu cấu hình đã ghi với config trong file output (nếu file vừa được ghi)."""
    path = ROOT / job['output']
    try:
        if not path.is_file() or path.stat().st_mtime < job['started']:
            return
        config = json.loads(path.read_text(encoding='utf-8')).get('config') or {}
    except (OSError, ValueError, AttributeError):
        return
    keys = ('provider', 'model', 'judge_provider', 'judge_model', 'max_steps', 'dataset')
    job['output_config'] = {k: config.get(k) for k in keys}
    job['config_mismatch'] = [k for k in keys if k in config and config.get(k) != job['settings'].get(k)]


def public_job(job):
    return {k: v for k, v in job.items() if k != 'proc'}


def stop_eval(job_id):
    job = JOBS.get(job_id)
    if not job:
        raise ValueError('Không tìm thấy job.')
    if job['status'] == 'running':
        job['status'] = 'stopped'
        job['proc'].terminate()
    return public_job(job)


# ---------------------------------------------------------------- eval files

def list_eval_files():
    files = []
    index, tags = read_version_index(), [v['name'] for v in list_versions()]
    for path in sorted(ROOT.glob('*.json')):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get('cases'), list) and 'summary' in data:
            files.append({'name': path.name, 'mtime': path.stat().st_mtime, 'cases': len(data['cases']),
                          'score': (data.get('summary') or {}).get('score_0_100'),
                          'scored': (data.get('summary') or {}).get('scored_cases'),
                          'dataset': (data.get('config') or {}).get('dataset'),
                          'config': {k: (data.get('config') or {}).get(k) for k in
                                     ('provider', 'model', 'judge_provider', 'judge_model', 'max_steps', 'dataset')},
                          'version': file_version(path.name, index, tags)[0]})
    return files


def read_eval_file(name):
    if not name or not OUTPUT_RE.match(name):
        raise ValueError('Tên file không hợp lệ.')
    path = ROOT / name
    if not path.is_file():
        raise ValueError(f'Không có file {name}.')
    return json.loads(path.read_text(encoding='utf-8'))


def config_info():
    return {'provider': os.getenv('PROVIDER', ''), 'model': os.getenv('MODEL', ''),
            'judge_provider': os.getenv('JUDGE_PROVIDER', ''), 'judge_model': os.getenv('JUDGE_MODEL', ''),
            'providers': PROVIDERS,
            # Chỉ cho biết key có hay không, không bao giờ trả giá trị.
            'keys_present': {name: bool(os.getenv(name)) for name in KEY_NAMES}}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = 'StatusAgentWeb/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('[web] ' + redact(fmt % args) + '\n')

    def _host_ok(self):
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]')
        return host in ('127.0.0.1', 'localhost', '::1')

    def _send(self, code, payload, ctype='application/json; charset=utf-8'):
        data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > 2_000_000:
            raise ValueError('Request quá lớn.')
        raw = self.rfile.read(length) if length else b'{}'
        data = json.loads(raw.decode('utf-8') or '{}')
        if not isinstance(data, dict):
            raise ValueError('Body phải là JSON object.')
        return data

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {'error': 'Host không hợp lệ'})
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        try:
            if url.path in ('/', '/index.html'):
                return self._send(200, (WEB / 'index.html').read_bytes(), 'text/html; charset=utf-8')
            if url.path in STATIC:
                return self._send(200, (WEB / url.path.lstrip('/')).read_bytes(), STATIC[url.path])
            if url.path == '/api/runs':
                return self._send(200, run_summaries())
            if url.path.startswith('/api/runs/'):
                rid = url.path.rsplit('/', 1)[-1]
                with RUNS_LOCK:
                    found = next((r for r in RUNS if r['id'] == rid), None)
                return self._send(200, found) if found else self._send(404, {'error': 'Không tìm thấy lần chạy'})
            if url.path == '/api/config':
                return self._send(200, config_info())
            if url.path == '/api/eval/jobs':
                with JOBS_LOCK:
                    jobs = [public_job(j) for j in JOBS.values()]
                return self._send(200, sorted(jobs, key=lambda j: -j['started']))
            if url.path == '/api/versions':
                return self._send(200, list_versions())
            if url.path == '/api/evals':
                return self._send(200, list_eval_files())
            if url.path == '/api/evals/file':
                return self._send(200, redact_obj(read_eval_file((qs.get('name') or [''])[0])))
            return self._send(404, {'error': 'Not found'})
        except Exception as exc:  # noqa: BLE001
            return self._send(400, {'error': redact(f'{type(exc).__name__}: {exc}')})

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, {'error': 'Host không hợp lệ'})
        path = urlparse(self.path).path
        try:
            body = self._body()
            if path == '/api/run':
                return self._send(200, run_agent_request(body))
            if path == '/api/eval/start':
                return self._send(200, start_eval(body))
            if path == '/api/eval/stop':
                return self._send(200, stop_eval(body.get('id')))
            return self._send(404, {'error': 'Not found'})
        except Conflict as exc:
            return self._send(409, {'error': str(exc), 'exists': True})
        except Exception as exc:  # noqa: BLE001
            return self._send(400, {'error': redact(f'{type(exc).__name__}: {exc}'),
                                    'traceback': redact(traceback.format_exc())})


def main():
    parser = argparse.ArgumentParser(description='Web UI cho Status Investigation Agent')
    parser.add_argument('--port', type=int, default=int(os.getenv('WEB_PORT', '8000')))
    args = parser.parse_args()
    load_dotenv_file(ROOT / '.env')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    print(f'Status Agent web UI: http://127.0.0.1:{args.port}  (Ctrl+C để dừng)', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for job in JOBS.values():
            if job['status'] == 'running':
                job['proc'].terminate()


if __name__ == '__main__':
    main()
