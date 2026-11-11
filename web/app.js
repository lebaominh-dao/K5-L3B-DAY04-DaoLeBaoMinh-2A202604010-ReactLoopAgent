'use strict';
/* Status Agent Lab — UI dạng chat, vanilla JS, không cần build. */

// ================================================================ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pretty = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } };
const num = (n) => (typeof n === 'number' ? n.toLocaleString('vi-VN') : '—');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } },
};

async function api(path, body) {
  const opt = body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)};
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({error: `Phản hồi không phải JSON (HTTP ${res.status})`}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), {data});
  return data;
}

// Thuật ngữ — dùng cho tooltip và bảng chú giải.
const TERMS = {
  step: 'Một lần gọi model. Trong một step model có thể yêu cầu nhiều tool cùng lúc.',
  finish: 'Lý do model dừng: tool_calls = muốn gọi tool; stop = trả lời xong; length = bị cắt vì hết token.',
  tool_call: 'Model yêu cầu chạy một tool với arguments (JSON). Agent chạy tool rồi gửi kết quả lại cho model.',
  tool_call_id: 'Mã của từng tool call. Kết quả tool phải gửi kèm đúng id này để model ghép được câu hỏi ↔ kết quả.',
  max_steps: 'Số lần gọi model tối đa. Hết mà chưa có câu trả lời cuối thì dừng với trạng thái max_steps.',
  usage: 'Số token model dùng ở mỗi step: input (prompt) và output (completion).',
  snapshot: 'Đọc dữ liệu status đã chụp sẵn trong fixtures/, ổn định và không cần mạng. live = gọi API thật.',
};
const tip = (term, label) => `<span class="gloss" data-tip="${esc(TERMS[term])}" tabindex="0">${esc(label || term)}</span>`;

// ================================================================ markdown (đơn giản, an toàn)
function inlineMd(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
// ---- bảng GFM
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
// Tách một dòng bảng thành các ô: bỏ pipe đầu/cuối, không tách tại \| hay | nằm trong `code`.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')
  && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
function renderTable(header, sep, body) {
  const align = splitRow(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const n = header.length;
  const cell = (tag, text, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ''}>${inlineMd(text ?? '')}</${tag}>`;
  const row = (cells, tag) => `<tr>${Array.from({length: n}, (_, j) => cell(tag, cells[j], j)).join('')}</tr>`;
  return `<div class="md-table"><table><thead>${row(header, 'th')}</thead><tbody>${body.map((r) => row(r, 'td')).join('')}</tbody></table></div>`;
}

function markdown(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      flushPara(); flushList();
      const header = splitRow(line), sep = lines[i + 1], body = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) body.push(splitRow(lines[i]));
      i--;
      out.push(renderTable(header, sep, body));
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) { flushPara(); flushList(); const lv = Math.min(5, h[1].length + 2); out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`); }
    else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = {tag, items: []}; }
      list.items.push((ul || ol)[1]);
    } else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('');
}

// ================================================================ trace → các dòng "bước"
function shortVal(v) {
  if (typeof v === 'string') return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  if (isObj(v) || Array.isArray(v)) return Array.isArray(v) ? `[${v.length}]` : '{…}';
  return String(v);
}
function callText(name, args) {
  if (typeof args === 'string') return `${name}(${args.length > 50 ? args.slice(0, 47) + '…' : args})`;
  if (!isObj(args)) return `${name}(${args === undefined ? '' : shortVal(args)})`;
  return `${name}(${Object.values(args).map(shortVal).join(', ')})`;
}
// Tóm tắt result tool thành một cụm ngắn; trả {text, level}.
function resultText(r) {
  if (!isObj(r)) return {text: r === undefined ? '(không có result)' : shortVal(r), level: ''};
  if (r.ok === false) return {text: `${r.error || 'lỗi'}${r.message ? ': ' + r.message : ''}`, level: 'bad'};
  const parts = [];
  if (isObj(r.overall) && r.overall.indicator) parts.push(`overall ${r.overall.indicator}`);
  if (Array.isArray(r.incidents)) parts.push(`${r.incidents.length} incident`);
  if (r.status && r.name) parts.push(`${r.status} · “${String(r.name).slice(0, 50)}”`);
  if (Array.isArray(r.updates)) parts.push(`${r.updates.length}${r.updates_total ? '/' + r.updates_total : ''} update`);
  if (r.next_offset !== undefined && r.next_offset !== null) parts.push(`còn tiếp (next_offset ${r.next_offset})`);
  if (!parts.length) parts.push(`${Object.keys(r).length} trường`);
  return {text: parts.join(' · '), level: ''};
}
function jsonBlock(label, v) { return `<div class="lbl">${esc(label)}</div><pre>${esc(pretty(v))}</pre>`; }

function eventLine(ev) {
  if (!isObj(ev)) return line('bad', '?', `Event không hợp lệ: ${esc(shortVal(ev))}`, null, jsonBlock('raw', ev));
  const name = String(ev.event ?? '(không có event)');
  const step = ev.step;
  switch (name) {
    case 'model': {
      const n = ev.tool_calls;
      const what = ev.finish === 'tool_calls' || n ? `yêu cầu ${n ?? '?'} ${tip('tool_call', 'tool call')}` : 'trả lời';
      return line('', '◌', `Gọi model · ${what} · ${tip('finish')}=<code>${esc(ev.finish)}</code>`, step, jsonBlock('event', ev));
    }
    case 'tool': {
      const r = resultText(ev.result);
      const body = jsonBlock('arguments', ev.arguments) + jsonBlock('result', ev.result) + extraFields(ev, ['event', 'step', 'name', 'arguments', 'result']);
      return line(r.level, r.level === 'bad' ? '⚠' : '🔧',
        `<span class="call">${esc(callText(ev.name, ev.arguments))}</span> <span class="arrow">→</span> <span class="res">${esc(r.text)}</span>`, step, body);
    }
    case 'final':
      return line('good', '✓', `Model đưa câu trả lời cuối${ev.finish ? ` (finish=${esc(ev.finish)})` : ''}`, step, jsonBlock('event', ev));
    case 'error':
      return line('bad', '⛔', `Model dừng bất thường${ev.finish ? ` · finish=<code>${esc(ev.finish)}</code>` : ''}${ev.message ? ' · ' + esc(ev.message) : ''}`, step, jsonBlock('event', ev));
    case 'max_steps':
      return line('warn', '⏱', `Hết ${tip('max_steps')} (${esc(ev.step ?? '?')}) mà chưa có câu trả lời cuối`, step, jsonBlock('event', ev));
    default: {
      // Event lạ (vd. validation_missing_source): luôn hiện, màu cảnh báo, kèm các field ngắn.
      const level = /error|fail|invalid/i.test(name) ? 'bad' : 'warn';
      const inline = Object.entries(ev).filter(([k, v]) => !['event', 'step'].includes(k) && !isObj(v) && !Array.isArray(v) && String(v).length < 60)
        .map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' · ');
      return line(level, '⚠', `<code>${esc(name)}</code>${inline ? ' · ' + inline : ''}`, step, jsonBlock('event', ev));
    }
  }
}
function extraFields(ev, known) {
  const rest = Object.keys(ev).filter((k) => !known.includes(k));
  return rest.length ? jsonBlock('khác', Object.fromEntries(rest.map((k) => [k, ev[k]]))) : '';
}
function line(level, icon, html, step, body) {
  return `<details class="line ${level}"><summary><span class="ico">${icon}</span><span class="txt">${html}</span>${step !== undefined && step !== null ? `<span class="stepchip">step ${esc(step)}</span>` : ''}</summary><div class="line-body">${body || ''}</div></details>`;
}

function stepsBlock(trace) {
  if (!Array.isArray(trace)) return `<div class="errcard">trace không phải list<pre>${esc(pretty(trace))}</pre></div>`;
  if (!trace.length) return '';
  const tools = trace.filter((e) => isObj(e) && e.event === 'tool');
  const models = trace.filter((e) => isObj(e) && e.event === 'model');
  const problems = trace.filter((e) => !isObj(e) || !['model', 'tool', 'final'].includes(e.event) || (e.event === 'tool' && isObj(e.result) && e.result.ok === false));
  let lastStep = Symbol('none');
  const rows = trace.map((ev) => {
    const s = isObj(ev) ? ev.step : undefined;
    let sep = '';
    if (s !== lastStep && s !== undefined && isObj(ev) && ev.event === 'model') sep = `<div class="step-sep">${tip('step', 'Step')} ${esc(s)}</div>`;
    lastStep = s;
    return sep + eventLine(ev);
  }).join('');
  const toolNames = [...new Set(tools.map((t) => t.name))].slice(0, 3).join(', ');
  return `<details class="steps" open><summary>
      <span>Agent đã chạy <b>${models.length}</b> ${tip('step')} · <b>${tools.length}</b> tool call${toolNames ? ` <span class="small">(${esc(toolNames)})</span>` : ''}</span>
      ${problems.length ? `<span class="badge max_steps">${problems.length} cảnh báo</span>` : ''}
    </summary><div class="steps-list">${rows}</div></details>`;
}

// ================================================================ usage
function normUsage(u) {
  if (!isObj(u)) return {fmt: '—', input: null, output: null, total: null};
  const pick = (...ks) => { for (const k of ks) if (typeof u[k] === 'number') return u[k]; return null; };
  const input = pick('prompt_tokens', 'input_tokens');
  const output = pick('completion_tokens', 'output_tokens');
  let total = pick('total_tokens');
  if (total === null && (input !== null || output !== null)) total = (input || 0) + (output || 0);
  const fmt = ('prompt_tokens' in u || 'completion_tokens' in u) ? 'OpenAI' : (('input_tokens' in u || 'output_tokens' in u) ? 'Anthropic' : (Object.keys(u).length ? 'khác' : 'trống'));
  return {fmt, input, output, total};
}
function sumUsage(usage) {
  const s = {input: 0, output: 0, total: 0};
  (Array.isArray(usage) ? usage : []).forEach((u) => { const n = normUsage(u); s.input += n.input || 0; s.output += n.output || 0; s.total += n.total || 0; });
  return s;
}
function usageLine(usage, trace) {
  const list = Array.isArray(usage) ? usage : [];
  const t = Array.isArray(trace) ? trace : [];
  const calls = t.filter((e) => isObj(e) && e.event === 'model').length || list.length;
  const tools = t.filter((e) => isObj(e) && e.event === 'tool').length;
  const s = sumUsage(list);
  const rows = list.map((u, i) => { const n = normUsage(u); return `<tr><td>${i + 1}</td><td>${esc(n.fmt)}</td><td class="num">${num(n.input)}</td><td class="num">${num(n.output)}</td><td class="num">${num(n.total)}</td></tr>`; }).join('');
  return `<details class="usage"><summary>▦ ${num(s.total)} tokens · ${calls} lần gọi model · ${tools} tool call</summary>
    <div class="card" style="margin-top:8px">${list.length ? `<div class="tbl-wrap"><table><thead><tr><th>${tip('step', 'Step')}</th><th>Format</th><th class="num">Input</th><th class="num">Output</th><th class="num">Tổng</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><th>Tổng</th><th></th><th class="num">${num(s.input)}</th><th class="num">${num(s.output)}</th><th class="num">${num(s.total)}</th></tr></tfoot></table></div>
      <p class="small">${tip('usage')}: OpenAI-compatible dùng <code>prompt_tokens</code>/<code>completion_tokens</code>, Anthropic dùng <code>input_tokens</code>/<code>output_tokens</code>. Tổng = <code>total_tokens</code> hoặc input + output.</p>` : '<p class="small">Không có usage.</p>'}</div></details>`;
}

// ================================================================ conversation component
const STATUS_TEXT = {completed: 'completed — hoàn thành', max_steps: 'max_steps — hết số bước', error: 'error — lỗi', exception: 'exception — agent crash'};
function conversation({question, result, exception, traceback, meta, elapsed, pending}) {
  const user = `<div class="msg-user"><div class="bubble">${esc(question)}</div></div>`;
  if (pending) return user + `<div class="msg-agent"><div class="avatar">◇</div><div class="agent-body"><div class="typing"><span></span><span></span><span></span></div></div></div>`;
  let body = '';
  if (exception) {
    body = `<div class="statusrow"><span class="badge exception">● ${STATUS_TEXT.exception}</span></div>
      <div class="errcard"><b>${esc(exception)}</b>${traceback ? `<details><summary>Xem traceback</summary><pre>${esc(traceback)}</pre></details>` : ''}</div>`;
  } else if (isObj(result)) {
    const st = String(result.status ?? '—');
    const known = new Set(['status', 'answer', 'trace', 'usage', 'error']);
    const extra = Object.keys(result).filter((k) => !known.has(k));
    body = stepsBlock(result.trace ?? []) +
      (result.answer ? `<div class="answer">${markdown(result.answer)}</div>` : `<div class="empty-answer">(Agent không có câu trả lời)</div>`) +
      `<div class="statusrow"><span class="badge ${esc(st)}">● ${esc(STATUS_TEXT[st] || st)}</span>
        ${meta ? `<span class="small">${esc(metaText(meta))}${elapsed !== undefined ? ` · ${elapsed}s` : ''}</span>` : ''}</div>` +
      (result.error ? `<div class="errcard">${esc(pretty(result.error))}</div>` : '') +
      (extra.length ? `<details class="usage"><summary>＋ ${extra.length} trường khác trong kết quả</summary>${jsonBlock('', Object.fromEntries(extra.map((k) => [k, result[k]])))}</details>` : '') +
      usageLine(result.usage, result.trace);
  } else {
    body = `<div class="errcard">Kết quả không hợp lệ<pre>${esc(pretty(result))}</pre></div>`;
  }
  return user + `<div class="msg-agent"><div class="avatar">◇</div><div class="agent-body">${body}</div></div>`;
}
const metaText = (m) => [m.provider === 'fake' ? 'fake provider' : `${m.provider}/${m.model}`, m.mode, `max_steps ${m.max_steps}`, m.fail && 'fail', m.bonus && 'bonus'].filter(Boolean).join(' · ');

// ================================================================ app state
const state = {config: null, runs: [], opts: null, pending: null, jobs: [], evalFiles: [], local: {}};
const view = $('#view');
const setTitle = (t) => { $('#topbar-title').textContent = t; document.title = `${t} · Status Agent Lab`; };
const showComposer = (on) => $('#composer-wrap').classList.toggle('hidden', !on);

// ---------------------------------------------------------------- options popover
const U = (p, c) => ({prompt_tokens: p, completion_tokens: c, total_tokens: p + c});
const A = (i, o) => ({input_tokens: i, output_tokens: o});
const PRESETS = {
  'Một tool rồi trả lời': [
    {calls: [{name: 'get_status', arguments: {provider: 'github', component: 'Actions'}}], usage: U(512, 31)},
    {content: 'Tại thời điểm snapshot, **GitHub overall = none** (không có sự cố đang diễn ra).\n\n- Incident Actions gần đây đã *resolved*.\n- Không nên coi sự cố cũ là đang diễn ra.\n\nNguồn: https://www.githubstatus.com', usage: U(1630, 74)},
  ],
  'Nhiều tool + incident (usage Anthropic)': [
    {calls: [{name: 'get_status', arguments: {provider: 'cloudflare', component: 'Cache'}}, {name: 'get_status', arguments: {provider: 'github'}}], usage: A(640, 58)},
    {calls: [{name: 'get_incident_details', arguments: {provider: 'cloudflare', incident_id: 'wp49bp8bqo6c'}}], usage: A(2210, 40)},
    {content: 'Incident `wp49bp8bqo6c` đang ở trạng thái **identified**.\n\nUpdate ban đầu nói khách hàng **non-FedRAMP không bị ảnh hưởng**, nên chưa đủ bằng chứng để kết luận website CLB bị ảnh hưởng.\n\nNguồn: [Cloudflare Status](https://www.cloudflarestatus.com/incidents/wp49bp8bqo6c)', usage: A(3405, 120)},
  ],
  'Arguments JSON lỗi (Bài 2)': [
    {calls: [{name: 'get_status', arguments: '{'}], usage: U(500, 5)},
    {content: 'Tool báo INVALID_ARGUMENTS nên tôi chưa lấy được dữ liệu.', usage: U(620, 20)},
  ],
  'Tool không tồn tại + provider sai': [
    {calls: [{name: 'get_weather', arguments: {city: 'Hanoi'}}, {name: 'get_status', arguments: {provider: 'aws'}}], usage: U(480, 30)},
    {content: 'Không có tool phù hợp để trả lời.', usage: U(700, 12)},
  ],
  'Câu trả lời có bảng': [
    {calls: [{name: 'get_status', arguments: {provider: 'github'}}, {name: 'get_status', arguments: {provider: 'cloudflare'}}], usage: U(520, 40)},
    {content: 'Tóm tắt tại thời điểm snapshot:\n\n| Dịch vụ | Overall | Incident gần đây |\n|:--------|:-------:|-----------------:|\n| **GitHub** | `none` | 5 |\n| Cloudflare | `major` | 3 |\n| npm \\| registry | — | `a|b` |\n\nBảng không có pipe đầu/cuối dòng:\n\nNguồn | Link\n--- | ---\nGitHub | [githubstatus.com](https://www.githubstatus.com)\nCloudflare | https://www.cloudflarestatus.com\nThử XSS | <img src=x onerror=alert(1)> <script>alert(2)</script>\n\nBảng rộng:\n\n| id | name | status | impact | created_at | updated_at | components | shortlink | note |\n|---|---|---|---|---|---|---|---|---|\n| wp49bp8bqo6c | Fedramp Customers have Delayed Purges | identified | minor | 2026-11-08T21:10:00Z | 2026-11-09T02:41:00Z | Cache Purge, FedRAMP | https://stspg.io/wp49bp8bqo6c | Non-fedramp customers are not impacted |', usage: U(1900, 160)},
  ],
  'Output bị cắt (finish=length)': [{content: 'GitHub Actions hiện', finish: 'length', usage: U(400, 1024)}],
  'Lặp mãi (chạm max_steps)': Array.from({length: 8}, (_, i) => ({calls: [{name: 'get_status', arguments: {provider: i % 2 ? 'cloudflare' : 'github'}}], usage: U(400 + i * 300, 20)})),
};
function defaultOpts() {
  return {provider: '', model: '', mode: 'snapshot', max_steps: 6, fail: false, bonus: false, preset: Object.keys(PRESETS)[0], script: null};
}
function saveOpts() { store.set('sal.opts', state.opts); renderOptsSummary(); }
function renderOptsSummary() {
  const o = state.opts;
  const prov = o.provider === 'fake' ? `fake: ${o.script ? 'tự sửa' : o.preset}` : (o.provider || `env (${state.config?.provider || '?'})`);
  $('#opts-summary').textContent = [prov, o.mode, `max_steps ${o.max_steps}`, o.fail && 'fail', o.bonus && 'bonus'].filter(Boolean).join(' · ');
}
function syncOptsForm() {
  const o = state.opts;
  $('#o-provider').value = o.provider;
  $('#o-model').value = o.model;
  $('#o-steps').value = o.max_steps;
  $('#o-fail').checked = o.fail; $('#o-bonus').checked = o.bonus;
  $('#o-preset').value = o.script ? '__custom' : o.preset;
  $$('#o-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === o.mode));
  $('#o-fake-row').classList.toggle('hidden', o.provider !== 'fake');
  $('#o-model-row').classList.toggle('hidden', o.provider === 'fake');
}
function setupOptions() {
  const cfg = state.config;
  $('#o-provider').innerHTML = `<option value="fake">fake provider — không cần key</option><option value="">env (${esc(cfg.provider || 'openai')})</option>` +
    cfg.providers.map((p) => `<option value="${p}">${p}${cfg.keys_present[p.toUpperCase() + '_API_KEY'] ? '' : ' (thiếu key)'}</option>`).join('');
  $('#o-preset').innerHTML = Object.keys(PRESETS).map((k) => `<option>${esc(k)}</option>`).join('') + '<option value="__custom">(kịch bản tự sửa)</option>';
  state.opts = Object.assign(defaultOpts(), store.get('sal.opts', {}));
  const hasKey = Object.values(cfg.keys_present).some(Boolean);
  if (!store.get('sal.opts', null) && !hasKey) state.opts.provider = 'fake';
  syncOptsForm(); renderOptsSummary();

  $('#opts-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#opts-pop').classList.toggle('hidden'); });
  document.addEventListener('click', (e) => { if (!$('#opts-pop').contains(e.target) && e.target !== $('#opts-btn')) $('#opts-pop').classList.add('hidden'); });
  $('#o-provider').addEventListener('change', (e) => { state.opts.provider = e.target.value; syncOptsForm(); saveOpts(); });
  $('#o-model').addEventListener('input', (e) => { state.opts.model = e.target.value.trim(); saveOpts(); });
  $('#o-steps').addEventListener('input', (e) => { state.opts.max_steps = Math.max(1, Math.min(50, Number(e.target.value) || 6)); saveOpts(); });
  $('#o-fail').addEventListener('change', (e) => { state.opts.fail = e.target.checked; saveOpts(); });
  $('#o-bonus').addEventListener('change', (e) => { state.opts.bonus = e.target.checked; saveOpts(); });
  $$('#o-mode button').forEach((b) => b.addEventListener('click', () => { state.opts.mode = b.dataset.v; syncOptsForm(); saveOpts(); }));
  $('#o-preset').addEventListener('change', (e) => {
    if (e.target.value === '__custom') { openScriptDialog(); return; }
    state.opts.preset = e.target.value; state.opts.script = null; saveOpts();
  });
  $('#o-edit').addEventListener('click', openScriptDialog);
}
function currentScript() { return state.opts.script || PRESETS[state.opts.preset] || PRESETS[Object.keys(PRESETS)[0]]; }
function openScriptDialog() {
  $('#script-text').value = JSON.stringify(currentScript(), null, 2);
  $('#script-err').textContent = '';
  $('#script-dlg').showModal();
}
$('#script-save').addEventListener('click', (e) => {
  try {
    const v = JSON.parse($('#script-text').value);
    if (!Array.isArray(v) || !v.length) throw new Error('Kịch bản phải là list không rỗng.');
    state.opts.script = v; saveOpts(); syncOptsForm();
  } catch (err) { e.preventDefault(); $('#script-err').textContent = err.message; }
});
$('#script-dlg').addEventListener('close', syncOptsForm);

// ---------------------------------------------------------------- composer
const q = $('#q');
const autoGrow = () => { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 220) + 'px'; };
q.addEventListener('input', autoGrow);
q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); ask(q.value); });

async function ask(question) {
  question = String(question || '').trim();
  if (!question || (state.pending && !state.pending.error)) return;
  const o = state.opts;
  const body = {question, mode: o.mode, max_steps: o.max_steps, fail: o.fail, bonus: o.bonus, provider: o.provider, model: o.model};
  if (o.provider === 'fake') body.fake_script = currentScript();
  q.value = ''; autoGrow();
  $('#opts-pop').classList.add('hidden');
  state.pending = {question};
  $('#send-btn').disabled = true;
  if (location.hash !== '#/pending') location.hash = '#/pending'; else route();
  try {
    const rec = await api('/api/run', body);
    state.pending = null;
    await loadRuns();
    location.hash = `#/run/${rec.id}`;
  } catch (err) {
    state.pending = {question, error: err.message};
    route();
  } finally {
    $('#send-btn').disabled = false;
    if (state.pending && !state.pending.error) state.pending = null;
  }
}

// ---------------------------------------------------------------- sidebar
async function loadRuns() {
  try { state.runs = await api('/api/runs'); } catch (e) { state.runs = []; }
  renderSidebar();
}
function renderSidebar() {
  const cur = location.hash;
  $('#run-list').innerHTML = state.runs.length ? state.runs.map((r) =>
    `<a href="#/run/${esc(r.id)}" class="${cur === '#/run/' + r.id ? 'active' : ''}" title="${esc(r.question)}"><span class="dot ${esc(r.status)}"></span><span class="t">${esc(r.question)}</span></a>`).join('')
    : '<div class="small empty">Chưa có lần chạy nào.</div>';
  const section = cur.startsWith('#/eval/results') ? 'eval-results' : cur.startsWith('#/eval/compare') ? 'eval-compare' : cur.startsWith('#/eval') ? 'eval-run' : '';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  $('#job-dot').classList.toggle('hidden', !state.jobs.some((j) => j.status === 'running'));
}
$('#menu-btn').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('open'); });
$('#scrim').addEventListener('click', closeMenu);
function closeMenu() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); }

// theme: auto → light → dark
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = {auto: 'tự động', light: 'sáng', dark: 'tối'};
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  $('#theme-btn').textContent = `◐ Giao diện: ${THEME_LABEL[t]}`;
}
let theme = store.get('sal.theme', 'auto');
applyTheme(theme);
$('#theme-btn').addEventListener('click', () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set('sal.theme', theme); applyTheme(theme); });

// ================================================================ pages
function pageWelcome() {
  setTitle('Câu hỏi mới'); showComposer(true);
  const samples = [
    ['GitHub', 'GitHub Actions hiện có sự cố không? Hãy xem cả incident gần đây và dẫn nguồn.'],
    ['Cloudflare', 'Cloudflare cache purge có incident nào liên quan không? Website không thuộc FedRAMP có bị ảnh hưởng không?'],
    ['So sánh', 'So sánh tình trạng hiện tại của GitHub và Cloudflare, có gì cần lưu ý không?'],
    ['Phạm vi', 'Copilot Mission Control có sự cố gần đây không? Ảnh hưởng ở đâu?'],
  ];
  view.innerHTML = `<div class="narrow welcome">
    <h1>Hỏi agent về trạng thái dịch vụ</h1>
    <p class="small">Agent tự gọi tool <code>get_status</code> / <code>get_incident_details</code> để điều tra GitHub và Cloudflare Status, rồi trả lời kèm nguồn.</p>
    <div class="suggest">${samples.map(([k, s]) => `<button data-q="${esc(s)}"><span class="k">${esc(k)}</span>${esc(s)}</button>`).join('')}</div>
    <div class="gloss-card"><b>Chú giải nhanh</b>
      <dl>${Object.entries(TERMS).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
  </div>`;
  $$('.suggest button', view).forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  q.focus();
}

function pagePending() {
  showComposer(true);
  const p = state.pending;
  if (!p) { location.hash = '#/'; return; }
  setTitle(p.question.slice(0, 80));
  view.innerHTML = `<div class="narrow">${p.error
    ? conversation({question: p.question, exception: `Không gọi được server: ${p.error}`})
    : conversation({question: p.question, pending: true})}</div>`;
}

async function pageRun(id) {
  showComposer(true);
  const my = routeSeq;
  let rec;
  try { rec = await api(`/api/runs/${encodeURIComponent(id)}`); }
  catch (e) {
    if (my !== routeSeq) return; setTitle('Không tìm thấy'); view.innerHTML = `<div class="narrow"><div class="errcard">Không tìm thấy lần chạy này (server có thể đã khởi động lại).</div></div>`; return; }
  if (my !== routeSeq) return;  // người dùng đã chuyển trang trong lúc chờ
  setTitle(rec.question.slice(0, 80));
  view.innerHTML = `<div class="narrow">${conversation(rec.ok ? {question: rec.question, result: rec.result, meta: rec.meta, elapsed: rec.elapsed}
    : {question: rec.question, exception: rec.exception, traceback: rec.traceback || rec.raw, meta: rec.meta})}</div>`;
}

// ---------------------------------------------------------------- eval: run
let jobTimer = null;
async function loadJobs() {
  try { state.jobs = await api('/api/eval/jobs'); } catch (e) { /* giữ nguyên */ }
  renderSidebar();
  clearTimeout(jobTimer);
  if (state.jobs.some((j) => j.status === 'running')) jobTimer = setTimeout(async () => { await loadJobs(); if (location.hash === '#/eval') renderJobs(); }, 2000);
}
const JOB_TEXT = {running: 'đang chạy', done: 'xong', failed: 'lỗi', stopped: 'đã dừng'};
// Model agent / judge / max_steps của job, lấy từ lúc khởi chạy (server ghi lại), đối chiếu config trong file output.
function jobSettings(j) {
  const st = j.settings;
  if (!isObj(st)) return '';
  const m = (p, model) => `${esc(p || '?')} / ${model ? esc(model) : '<i>chưa đặt MODEL</i>'}`;
  const judgeNote = st.judge_provider_source === 'agent' && st.judge_model_source === 'agent'
    ? ' <span class="note" data-tip="Không truyền --judge-provider/--judge-model và không có JUDGE_* trong env nên run_evals.py dùng chính model agent để chấm.">(mặc định = agent)</span>'
    : st.judge_is_agent ? ' <span class="note">(cùng model với agent)</span>' : '';
  let check = '';
  if (isObj(j.output_config)) {
    check = Array.isArray(j.config_mismatch) && j.config_mismatch.length
      ? `<div class="warncard" style="margin:8px 0 0">⚠ Config trong file khác lúc khởi chạy: ${j.config_mismatch.map((k) => `${esc(k)} = <b>${esc(j.output_config[k])}</b> (job: ${esc(st[k])})`).join(' · ')}</div>`
      : '<span class="note ok">✓ khớp config trong file output</span>';
  }
  return `<div class="job-models">
    <span>Agent: <b>${m(st.provider, st.model)}</b></span>
    <span>Judge: <b>${m(st.judge_provider, st.judge_model)}</b>${judgeNote}</span>
    <span>max_steps: <b>${esc(st.max_steps)}</b>${st.max_steps_default ? ' <span class="note">(mặc định)</span>' : ''}</span>
    ${check}</div>`;
}
function renderJobs() {
  const box = $('#jobs');
  if (!box) return;
  const open = new Set($$('details[data-job][open]', box).map((d) => d.dataset.job));
  box.innerHTML = state.jobs.length ? state.jobs.map((j) => {
    const secs = Math.round((j.finished || Date.now() / 1000) - j.started);
    const done = j.log.filter((l) => /^[A-Z]+\d+: /.test(l)).length;
    const last = [...j.log].reverse().find((l) => /^Điểm|^Lỗi|error/i.test(l));
    return `<div class="job"><div class="row">
        <span class="badge ${esc(j.status)}">● ${esc(JOB_TEXT[j.status] || j.status)}</span>
        <b>${esc(j.output)}</b>
        <span class="small">${j.case ? 'case ' + esc(j.case) : 'toàn bộ'}${j.bonus ? ' · bonus' : ''} · ${secs}s · ${done} case đã chấm${j.returncode !== null ? ' · exit ' + j.returncode : ''}</span>
        <span style="flex:1"></span>
        ${j.status === 'running' ? `<button class="ghost" data-stop="${esc(j.id)}">Dừng</button>` : `<a class="ghost" style="text-decoration:none" href="#/eval/results/${encodeURIComponent(j.output)}">Xem kết quả →</a>`}
      </div>
      ${jobSettings(j)}
      ${last ? `<div class="small" style="margin-top:6px">${esc(last)}</div>` : ''}
      <details data-job="${esc(j.id)}" ${open.has(j.id) || j.status === 'running' ? 'open' : ''}><summary class="small" style="cursor:pointer;margin-top:6px">Log (${j.log.length} dòng)</summary><pre>${esc(j.log.slice(-200).join('\n') || '(chưa có output)')}</pre></details></div>`;
  }).join('') : '<p class="small">Chưa có job nào trong phiên này.</p>';
  $$('[data-stop]', box).forEach((b) => b.addEventListener('click', async () => { try { await api('/api/eval/stop', {id: b.dataset.stop}); } catch (e) { alert(e.message); } await loadJobs(); renderJobs(); }));
}
function pageEvalRun() {
  setTitle('Chạy eval'); showComposer(false);
  const cfg = state.config;
  const provOpts = (def) => `<option value="">${def}</option>` + cfg.providers.map((p) => `<option>${p}</option>`).join('');
  view.innerHTML = `<div class="wide">
    <h2 class="page">Chạy eval</h2>
    <p class="lead">Chạy <code>evals/run_evals.py</code> ở background rồi chấm bằng judge model. Eval gọi model thật nên cần API key (đọc từ env / <code>.env</code>).</p>
    <form class="card" id="eval-form">
      <div class="form-grid">
        <label class="field">Tên file kết quả <input id="e-output" value="eval_before.json"></label>
        <div class="field"><span>Phạm vi</span>
          <div class="seg" id="e-scope"><button type="button" data-v="full" class="on">Toàn bộ</button><button type="button" data-v="case">Một case</button></div></div>
        <label class="field hidden" id="e-case-row">Case ID <input id="e-case" placeholder="vd. E2, H1"></label>
        <label class="check" style="align-self:end"><input type="checkbox" id="e-bonus"> Bộ bonus (<code>--bonus</code>)</label>
      </div>
      <details style="margin-top:12px"><summary class="small" style="cursor:pointer">Tùy chọn nâng cao</summary>
        <div class="form-grid" style="margin-top:10px">
          <label class="field">Provider <select id="e-provider">${provOpts(`env (${esc(cfg.provider || 'openai')})`)}</select></label>
          <label class="field">Model <input id="e-model" placeholder="${esc(cfg.model || 'MODEL từ env')}"></label>
          <label class="field">Judge provider <select id="e-jprovider">${provOpts(cfg.judge_provider ? `env (${esc(cfg.judge_provider)})` : 'để trống = provider của agent')}</select></label>
          <label class="field">Judge model <input id="e-jmodel" placeholder="${esc(cfg.judge_model || 'để trống = model của agent')}"></label>
          <label class="field">max_steps <input id="e-steps" type="number" min="1" placeholder="8 (bonus: 16)"></label>
          <label class="field">workers <input id="e-workers" type="number" min="1" max="8" value="1"></label>
        </div>
      </details>
      <div class="row" style="margin-top:14px"><button class="primary" id="e-start">▶ Bắt đầu</button><span class="small" id="e-msg"></span></div>
    </form>
    <h3 style="margin:22px 0 10px">Các job trong phiên</h3><div id="jobs"></div></div>`;
  let scope = 'full';
  $$('#e-scope button').forEach((b) => b.addEventListener('click', () => {
    scope = b.dataset.v; $$('#e-scope button').forEach((x) => x.classList.toggle('on', x === b));
    $('#e-case-row').classList.toggle('hidden', scope !== 'case');
  }));
  $('#eval-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {output: $('#e-output').value.trim(), case: scope === 'case' ? $('#e-case').value.trim() : '', bonus: $('#e-bonus').checked,
      provider: $('#e-provider').value, model: $('#e-model').value.trim(), judge_provider: $('#e-jprovider').value, judge_model: $('#e-jmodel').value.trim(),
      max_steps: $('#e-steps').value, workers: $('#e-workers').value};
    if (scope === 'case' && !body.case) { $('#e-msg').textContent = 'Nhập case ID.'; return; }
    try { const j = await api('/api/eval/start', body); $('#e-msg').textContent = `Đã bắt đầu → ${j.output}`; await loadJobs(); renderJobs(); }
    catch (err) { $('#e-msg').innerHTML = `<span class="badge error">lỗi</span> ${esc(err.message)}`; }
  });
  renderJobs(); loadJobs().then(renderJobs);
}

// ---------------------------------------------------------------- eval: files
async function loadEvalFiles() { try { state.evalFiles = await api('/api/evals'); } catch (e) { state.evalFiles = []; } }
const allFileNames = () => [...state.evalFiles.map((f) => f.name), ...Object.keys(state.local)];
async function getEval(name) {
  if (state.local[name]) return state.local[name];
  return api('/api/evals/file?name=' + encodeURIComponent(name));
}
function fileOptions(selected, placeholder) {
  const label = (n) => { const f = state.evalFiles.find((x) => x.name === n); return f ? `${n} — ${f.cases} case · ${f.score === null || f.score === undefined ? `chưa có điểm (${f.scored ?? '?'}/${f.cases} đã chấm)` : 'điểm ' + f.score}` : n; };
  return `<option value="">${esc(placeholder)}</option>` + allFileNames().map((n) => `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${esc(label(n))}</option>`).join('');
}
async function readUploads(files) {
  const names = [];
  for (const f of files) {
    try { state.local['máy: ' + f.name] = JSON.parse(await f.text()); names.push('máy: ' + f.name); }
    catch (e) { alert(`${f.name}: không phải JSON hợp lệ`); }
  }
  return names;
}
const scoreClass = (s) => (typeof s !== 'number' ? '' : s >= 80 ? 'hi' : s >= 50 ? 'mid' : 'lo');
const scorePill = (s) => `<span class="score ${scoreClass(s)}">${s === null || s === undefined ? '—' : esc(s)}</span>`;
const modelCalls = (c) => { const t = c?.result?.trace; return Array.isArray(t) ? t.filter((e) => isObj(e) && e.event === 'model').length : 0; };
const violations = (c) => (Array.isArray(c?.grade?.mechanical?.violations) ? c.grade.mechanical.violations : []);
const enc = encodeURIComponent;
// Điểm tổng chỉ có khi MỌI case được chấm (score_0_100). partial_mean_0_100 KHÔNG phải điểm bài.
const fullScore = (s) => (isObj(s) && typeof s.score_0_100 === 'number' ? s.score_0_100 : null);
const isUnscored = (c) => typeof c?.grade?.score !== 'number';
// Gom nguyên nhân lỗi thành nhóm ngắn, ví dụ "HTTP 429".
function errorKey(c) {
  const err = String(c?.result?.error || '');
  const reason = String(c?.grade?.reason || '');
  const text = err || reason || c?.grade?.status || 'không rõ';
  const http = text.match(/HTTP (\d{3})/);
  if (http) return `${err ? '' : 'Judge: '}HTTP ${http[1]}`;
  const short = text.replace(/\s+/g, ' ').slice(0, 90);
  return err ? short : `Chưa chấm: ${short}`;
}
function scoreCell(c) {
  if (!c) return '<span class="small">—</span>';
  if (!isUnscored(c)) return scorePill(c.grade.score);
  const label = c.result?.status === 'error' ? 'lỗi' : 'chưa chấm';
  return `<span class="badge error" title="${esc(c.result?.error || c.grade?.reason || '')}">${label}</span>`;
}
function incompleteBanner(s, cases) {
  if (fullScore(s) !== null) return '';
  const bad = cases.filter(isUnscored);
  const total = s.total_cases ?? cases.length;
  const groups = {};
  bad.forEach((c) => { const k = errorKey(c); (groups[k] = groups[k] || []).push(c.id); });
  const partial = typeof s.partial_mean_0_100 === 'number'
    ? ` Trung bình tạm của ${esc(s.scored_cases ?? total - bad.length)} case đã chấm: <b>${esc(s.partial_mean_0_100)}</b> — <b>không phải điểm bài</b>.` : '';
  return `<div class="warncard"><b>⚠ ${esc(bad.length)}/${esc(total)} case chưa chấm được → không có điểm tổng.</b>${partial}
    <ul>${Object.entries(groups).sort((x, y) => y[1].length - x[1].length).map(([k, ids]) =>
      `<li><b>${ids.length} case</b>: ${esc(k)} <span class="small">(${esc(ids.slice(0, 8).join(', '))}${ids.length > 8 ? ', …' : ''})</span></li>`).join('')}</ul>
    <div class="small">Sửa nguyên nhân (key, quota, rate limit…) rồi chạy lại eval để có điểm tổng.</div></div>`;
}

// ---------------------------------------------------------------- sắp xếp bảng case
// Mặc định: điểm tăng dần, case lỗi / chưa chấm luôn lên đầu (chỗ có vấn đề nhất). Sort ổn định theo thứ tự gốc.
const SORT_DEFAULT = {results: {col: 'score', dir: 'asc'}, compare: {col: 'after', dir: 'asc'}};
const SORT_HINT = {
  case: 'Thứ tự gốc trong file', score: 'Điểm; case lỗi / chưa chấm luôn ở đầu', status: 'Lỗi → chưa chấm → max_steps → completed',
  before: 'Điểm before; case lỗi / chưa chấm ở đầu', after: 'Điểm after; case lỗi / chưa chấm ở đầu',
  delta: 'Δ = after − before; tăng dần = giảm điểm nhiều nhất lên trước; Δ không tính được ở đầu',
};
function getSort(kind) {
  const v = store.get('sal.sort.' + kind, null);
  const cols = (kind === 'results' ? RESULT_COLS : COMPARE_COLS).map((c) => c[0]).filter(Boolean);
  return isObj(v) && cols.includes(v.col) && (v.dir === 'asc' || v.dir === 'desc') ? v : SORT_DEFAULT[kind];
}
// keyFn(row) -> [nhóm, giá trị]: nhóm nhỏ luôn đứng trước (không đảo theo chiều), giá trị đảo theo dir.
function sortRows(rows, keyFn, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return rows.slice().sort((p, q) => {
    const [gp, vp] = keyFn(p), [gq, vq] = keyFn(q);
    if (gp !== gq) return gp - gq;
    if (vp !== vq) return sign * (vp < vq ? -1 : 1);
    return p.idx - q.idx;
  });
}
function statusRank(c) {
  if (!c) return 5;
  const rs = c.result?.status;
  if (rs === 'error' || rs === 'exception') return 0;
  if (isUnscored(c)) return 1;
  if (rs === 'max_steps') return 2;
  return rs === 'completed' ? 4 : 3;
}
// Case lỗi / chưa chấm nằm ở nhóm riêng (lỗi trước, chưa chấm sau), không bị đảo khi đổi chiều sort.
const scoreKey = (c) => (c && !isUnscored(c) ? [10, c.grade.score] : [statusRank(c), 0]);
function resultSortKey(col) {
  if (col === 'score') return ({c}) => scoreKey(c);
  if (col === 'status') return ({c}) => [0, statusRank(c) * 1000 + (isUnscored(c) ? 0 : c.grade.score)];
  return ({idx}) => [0, idx];
}
function compareSortKey(col) {
  if (col === 'before') return ({x}) => scoreKey(x);
  if (col === 'after') return ({y}) => scoreKey(y);
  if (col === 'delta') return ({x, y}) => (x && y && !isUnscored(x) && !isUnscored(y) ? [10, y.grade.score - x.grade.score] : [0, 0]);
  if (col === 'status') return ({x, y}) => [0, statusRank(y) * 10 + statusRank(x)];
  return ({idx}) => [0, idx];
}
function sortHeaders(cols, sort) {
  return cols.map(([col, label, cls]) => {
    if (!col) return `<th class="${cls || ''}">${esc(label)}</th>`;
    const on = sort.col === col;
    const arrow = on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
    return `<th class="sortable ${cls || ''} ${on ? 'on' : ''}" data-col="${col}" tabindex="0" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"
      title="${esc(SORT_HINT[col] || '')}">${esc(label)} <span class="arr">${arrow}</span></th>`;
  }).join('');
}
function bindSortHeaders(box, kind, rerender) {
  $$('th.sortable', box).forEach((th) => {
    const go = () => {
      const cur = getSort(kind), col = th.dataset.col;
      store.set('sal.sort.' + kind, {col, dir: cur.col === col && cur.dir === 'asc' ? 'desc' : 'asc'});
      rerender();
    };
    th.addEventListener('click', go);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

async function pageEvalResults(file, caseId) {
  showComposer(false);
  const my = routeSeq;
  await loadEvalFiles();
  if (my !== routeSeq) return;
  if (!file) {
    const latest = state.evalFiles.slice().sort((a, b) => b.mtime - a.mtime)[0];
    setTitle('Kết quả eval');
    view.innerHTML = `<div class="wide"><h2 class="page">Kết quả eval</h2><p class="lead">Chọn file JSON do <code>run_evals.py</code> tạo ra (ở thư mục gốc repo) hoặc mở file từ máy.</p>
      ${filePicker('')}${latest ? '' : '<div class="card small">Chưa có file eval nào ở thư mục gốc. Hãy chạy eval hoặc mở file từ máy.</div>'}</div>`;
    bindFilePicker();
    return;
  }
  let data;
  try { data = await getEval(file); } catch (e) {
    if (my !== routeSeq) return; view.innerHTML = `<div class="wide">${filePicker(file)}<div class="errcard">${esc(e.message)}</div></div>`; bindFilePicker(); return; }
  if (my !== routeSeq) return;
  if (!isObj(data) || !Array.isArray(data.cases)) { view.innerHTML = `<div class="wide">${filePicker(file)}<div class="errcard">File không phải eval report (thiếu <code>cases</code>).</div></div>`; bindFilePicker(); return; }
  if (caseId) return pageEvalCase(file, data, caseId);
  setTitle(`Kết quả · ${file}`);
  const s = data.summary || {}, cfg = data.config || {};
  const tokens = data.cases.reduce((a, c) => a + sumUsage(c?.result?.usage).total, 0);
  const calls = data.cases.reduce((a, c) => a + modelCalls(c), 0);
  const score = fullScore(s);
  const stats = [[score === null ? '<span class="score" style="font-size:15px">Chưa có điểm</span>' : scorePill(score), 'Điểm 0–100'],
    [`${esc(s.scored_cases ?? '—')}/${esc(s.total_cases ?? data.cases.length)}`, 'Case đã chấm'],
    ...(s.bonus_points_0_15 !== undefined ? [[esc(s.bonus_points_0_15 ?? '—'), 'Bonus /15']] : []),
    [num(calls), 'Lần gọi model'], [num(tokens), 'Token agent']];
  view.innerHTML = `<div class="wide">${filePicker(file)}
    <div class="stats">${stats.map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>
    ${incompleteBanner(s, data.cases)}
    <p class="small">${Object.entries(cfg).map(([k, v]) => `${esc(k)}: <b>${esc(v)}</b>`).join(' · ')}</p>
    <div class="card"><h3>Từng case <span class="small">— bấm để mở như một hội thoại · bấm tiêu đề cột để sắp xếp</span></h3><div class="tbl-wrap" id="case-table"></div></div></div>`;
  bindFilePicker();
  renderResultsTable(data, file);
}
const RESULT_COLS = [['case', 'Case'], ['score', 'Điểm', 'num'], ['status', 'Trạng thái'], [null, 'Nhận xét (reason)'], [null, 'Gợi ý (improvement)'], [null, 'Kiểm tra máy']];
function renderResultsTable(data, file) {
  const box = $('#case-table');
  if (!box) return;
  const sort = getSort('results');
  const rows = sortRows(data.cases.map((c, idx) => ({c, idx})), resultSortKey(sort.col), sort.dir);
  box.innerHTML = `<table><thead><tr>${sortHeaders(RESULT_COLS, sort)}</tr></thead>
      <tbody>${rows.map(({c}) => {
        const g = c.grade || {}, v = violations(c), m = g.mechanical || {};
        return `<tr class="click" data-case="${esc(c.id)}"><td><b>${esc(c.id)}</b><div class="sub">${esc(c.scenario || '')}</div></td>
          <td class="num">${scoreCell(c)}</td>
          <td><span class="badge ${esc(c.result?.status)}">${esc(c.result?.status ?? '—')}</span><div class="sub">${esc(g.status ?? '')}</div>
            ${c.result?.error ? `<div class="sub err">${esc(String(c.result.error).slice(0, 160))}</div>` : ''}</td>
          <td>${esc(g.reason || '')}</td><td>${esc(g.improvement || '')}</td>
          <td>${v.length ? v.map((x) => `<span class="viol">${esc(x)}</span>`).join('') : '<span class="sub">✓ không vi phạm</span>'}
            <div class="sub">${esc(m.tool_calls ?? '—')} tool call · ${modelCalls(c)} model call${m.score_cap !== undefined && m.score_cap < 100 ? ` · trần điểm ${esc(m.score_cap)}` : ''}</div></td></tr>`;
      }).join('')}</tbody></table>`;
  bindSortHeaders(box, 'results', () => renderResultsTable(data, file));
  $$('tr[data-case]', box).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/eval/results/${enc(file)}/${enc(tr.dataset.case)}`; }));
}
function filePicker(file) {
  return `<div class="card row"><label class="field" style="flex:1;min-width:240px">File eval <select id="f-sel">${fileOptions(file, '— chọn file —')}</select></label>
    <label class="ghost" style="cursor:pointer">📂 Mở file từ máy<input type="file" id="f-up" accept=".json" class="hidden"></label></div>`;
}
function bindFilePicker() {
  $('#f-sel').addEventListener('change', (e) => { location.hash = e.target.value ? `#/eval/results/${enc(e.target.value)}` : '#/eval/results'; });
  $('#f-up').addEventListener('change', async (e) => { const n = await readUploads(e.target.files); if (n[0]) location.hash = `#/eval/results/${enc(n[0])}`; });
}
function gradeCard(c, title) {
  const g = c.grade || {}, v = violations(c), dims = isObj(g.dimensions) ? g.dimensions : null;
  const MAX = {factuality: 40, completeness: 25, evidence: 20, boundaries: 15};
  return `<div class="card grade-card"><div class="row"><b>${esc(title || 'Điểm judge')}</b>${scoreCell(c)}
      <span class="badge ${esc(g.status)}">${esc(g.status ?? '—')}</span>${g.raw_judge_score !== undefined && g.raw_judge_score !== g.score ? `<span class="small">judge cho ${esc(g.raw_judge_score)}, bị giới hạn bởi kiểm tra máy</span>` : ''}</div>
    ${g.reason ? `<div class="reason"><b>Nhận xét:</b> ${esc(g.reason)}</div>` : ''}
    ${g.improvement ? `<div class="reason"><b>Gợi ý:</b> ${esc(g.improvement)}</div>` : ''}
    ${dims ? `<div class="dims">${Object.entries(dims).map(([k, val]) => `<div class="dim small">${esc(k)} <b>${esc(val)}</b>${MAX[k] ? '/' + MAX[k] : ''}<div class="bar"><i style="width:${MAX[k] ? Math.max(0, Math.min(100, val / MAX[k] * 100)) : 0}%"></i></div></div>`).join('')}</div>` : ''}
    ${v.length ? `<div>${v.map((x) => `<span class="viol">${esc(x)}</span>`).join('')}</div>` : ''}
    ${c.expected ? `<details><summary class="small" style="cursor:pointer">Đáp án kỳ vọng (chỉ judge thấy)</summary><p class="small">${esc(c.expected)}</p></details>` : ''}</div>`;
}
const caseConv = (c) => conversation({question: c.question, result: c.result});
function pageEvalCase(file, data, caseId) {
  const c = data.cases.find((x) => String(x.id) === caseId);
  setTitle(`${caseId} · ${file}`);
  if (!c) { view.innerHTML = `<div class="narrow"><a class="back" href="#/eval/results/${enc(file)}">← ${esc(file)}</a><div class="errcard">Không có case ${esc(caseId)}.</div></div>`; return; }
  view.innerHTML = `<div class="narrow"><a class="back" href="#/eval/results/${enc(file)}">← Quay lại bảng ${esc(file)}</a>
    <h2 class="page">Case ${esc(c.id)}</h2><p class="lead">${esc(c.scenario || 'normal')}${c.provider ? ' · ' + esc(c.provider) + '/' + esc(c.model) : ''}</p>
    ${gradeCard(c)}${caseConv(c)}</div>`;
}

// ---------------------------------------------------------------- eval: compare
async function pageCompare(a, b, caseId) {
  showComposer(false); setTitle('So sánh before / after');
  const my = routeSeq;
  await loadEvalFiles();
  if (my !== routeSeq) return;
  const names = allFileNames();
  a = a || (names.includes('eval_before.json') ? 'eval_before.json' : '');
  b = b || (names.includes('eval_after.json') ? 'eval_after.json' : '');
  const picker = `<div class="card row">
      <label class="field" style="flex:1;min-width:200px">Before <select id="c-a">${fileOptions(a, '— chọn —')}</select></label>
      <label class="field" style="flex:1;min-width:200px">After <select id="c-b">${fileOptions(b, '— chọn —')}</select></label>
      <label class="ghost" style="cursor:pointer;align-self:end">📂 Mở từ máy<input type="file" id="c-up" accept=".json" multiple class="hidden"></label></div>`;
  const bind = () => {
    const go = () => { const x = $('#c-a').value, y = $('#c-b').value; location.hash = `#/eval/compare/${enc(x)}/${enc(y)}`; };
    $('#c-a').addEventListener('change', go); $('#c-b').addEventListener('change', go);
    $('#c-up').addEventListener('change', async (e) => { const n = await readUploads(e.target.files); location.hash = `#/eval/compare/${enc(n[0] || a)}/${enc(n[1] || b)}`; });
  };
  if (!a || !b) {
    view.innerHTML = `<div class="wide"><h2 class="page">So sánh before / after</h2><p class="lead">Chọn hai file eval, ví dụ <code>eval_before.json</code> và <code>eval_after.json</code>.</p>${picker}</div>`;
    bind(); return;
  }
  let A1, B1;
  try { [A1, B1] = await Promise.all([getEval(a), getEval(b)]); }
  catch (e) {
    if (my !== routeSeq) return; view.innerHTML = `<div class="wide">${picker}<div class="errcard">${esc(e.message)}</div></div>`; bind(); return; }
  if (my !== routeSeq) return;
  const ca = Array.isArray(A1?.cases) ? A1.cases : [], cb = Array.isArray(B1?.cases) ? B1.cases : [];
  const find = (arr, id) => arr.find((c) => String(c.id) === String(id));
  if (caseId) {
    const x = find(ca, caseId), y = find(cb, caseId);
    const col = (c, n, label) => `<div><div class="col-title">${label} · ${esc(n)}</div>${c ? gradeCard(c) + caseConv(c) : '<div class="card small">Không có case này.</div>'}</div>`;
    setTitle(`So sánh ${caseId}`);
    view.innerHTML = `<div class="wide"><a class="back" href="#/eval/compare/${enc(a)}/${enc(b)}">← Quay lại bảng so sánh</a>
      <h2 class="page">Case ${esc(caseId)} ${deltaHtml(x?.grade?.score, y?.grade?.score)}</h2><p class="lead">${esc((x || y)?.question || '')}</p>
      <div class="two-col">${col(x, a, 'Before')}${col(y, b, 'After')}</div></div>`;
    return;
  }
  const ids = [...new Set([...ca.map((c) => String(c.id)), ...cb.map((c) => String(c.id))])];
  const sa = A1.summary || {}, sb = B1.summary || {};
  const tot = (cs) => cs.reduce((s, c) => s + sumUsage(c?.result?.usage).total, 0);
  const calls = (cs) => cs.reduce((s, c) => s + modelCalls(c), 0);
  const summaryRows = [
    ['Điểm tổng', fullScore(sa), fullScore(sb), true],
    ['Case đã chấm', `${sa.scored_cases ?? '—'}/${sa.total_cases ?? ca.length}`, `${sb.scored_cases ?? '—'}/${sb.total_cases ?? cb.length}`, false, true],
    ['Lần gọi model', calls(ca), calls(cb)], ['Token agent', tot(ca), tot(cb)]];
  view.innerHTML = `<div class="wide"><h2 class="page">So sánh before / after</h2><p class="lead">Δ dương (xanh) là tốt hơn về điểm. Token và số lần gọi model chỉ để tham khảo chi phí.</p>${picker}
    <div class="card"><h3>Tổng quan</h3><div class="tbl-wrap"><table><thead><tr><th>Chỉ số</th><th class="num">Before</th><th class="num">After</th><th class="num">Δ</th></tr></thead>
      <tbody>${summaryRows.map(([l, x, y, isScore, isText]) => {
        const cell = (v) => (isScore ? (v === null ? '<span class="small">chưa có</span>' : scorePill(v)) : isText ? esc(v) : num(v));
        return `<tr><td>${l}</td><td class="num">${cell(x)}</td><td class="num">${cell(y)}</td><td class="num">${isText ? '' : deltaHtml(x, y, !isScore)}</td></tr>`;
      }).join('')}</tbody></table></div>
      ${incompleteNote(an(a, sa, ca), an(b, sb, cb))}</div>
    <div class="card"><h3>Từng case <span class="small">— bấm để xem hai hội thoại cạnh nhau · bấm tiêu đề cột để sắp xếp</span></h3><div class="tbl-wrap" id="cmp-table"></div></div></div>`;
  bind();
  renderCompareTable(ids.map((id, idx) => ({id, idx, x: find(ca, id), y: find(cb, id)})), a, b);
}
const COMPARE_COLS = [['case', 'Case'], ['before', 'Before', 'num'], ['after', 'After', 'num'], ['delta', 'Δ', 'num'], ['status', 'Trạng thái'], [null, 'Vi phạm', 'num']];
function renderCompareTable(rows0, a, b) {
  const box = $('#cmp-table');
  if (!box) return;
  const sort = getSort('compare');
  const rows = sortRows(rows0, compareSortKey(sort.col), sort.dir);
  box.innerHTML = `<table><thead><tr>${sortHeaders(COMPARE_COLS, sort)}</tr></thead>
      <tbody>${rows.map(({id, x, y}) => {
        return `<tr class="click" data-case="${esc(id)}"><td><b>${esc(id)}</b></td><td class="num">${scoreCell(x)}</td><td class="num">${scoreCell(y)}</td>
          <td class="num">${deltaHtml(x?.grade?.score, y?.grade?.score)}</td>
          <td><span class="badge ${esc(x?.result?.status)}">${esc(x?.result?.status ?? '—')}</span> → <span class="badge ${esc(y?.result?.status)}">${esc(y?.result?.status ?? '—')}</span></td>
          <td class="num">${x ? violations(x).length : '—'} → ${y ? violations(y).length : '—'}</td></tr>`;
      }).join('')}</tbody></table>`;
  bindSortHeaders(box, 'compare', () => renderCompareTable(rows0, a, b));
  $$('tr[data-case]', box).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/eval/compare/${enc(a)}/${enc(b)}/${enc(tr.dataset.case)}`; }));
}
const an = (name, s, cases) => ({name, s, cases});
function incompleteNote(...files) {
  const bad = files.filter((f) => fullScore(f.s) === null);
  if (!bad.length) return '';
  return `<div class="warncard" style="margin-top:12px"><b>⚠ Không so sánh được điểm tổng.</b> ${bad.map((f) => {
    const n = f.cases.filter(isUnscored).length;
    return `<div><code>${esc(f.name)}</code>: ${n}/${esc(f.s.total_cases ?? f.cases.length)} case chưa chấm → không có điểm tổng${typeof f.s.partial_mean_0_100 === 'number' ? ` (trung bình tạm ${esc(f.s.partial_mean_0_100)} không phải điểm bài)` : ''}.</div>`;
  }).join('')}<div class="small">Δ theo từng case bên dưới chỉ tính khi cả hai phía đều đã chấm case đó.</div></div>`;
}
function deltaHtml(a, b, neutral) {
  if (typeof a !== 'number' || typeof b !== 'number') return '<span class="small">—</span>';
  const d = Math.round((b - a) * 100) / 100;
  if (neutral) return `<span class="small">${d > 0 ? '+' : ''}${num(d)}</span>`;
  return d > 0 ? `<span class="delta up">▲ +${d}</span>` : d < 0 ? `<span class="delta down">▼ ${d}</span>` : '<span class="small">0</span>';
}

// ================================================================ router
let routeSeq = 0;
async function route() {
  routeSeq++;
  closeMenu();
  const parts = location.hash.replace(/^#\/?/, '').split('/').map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
  renderSidebar();
  view.scrollTop = 0;
  try {
    if (!parts[0]) pageWelcome();
    else if (parts[0] === 'pending') pagePending();
    else if (parts[0] === 'run') await pageRun(parts[1]);
    else if (parts[0] === 'eval' && parts[1] === 'results') await pageEvalResults(parts[2], parts[3]);
    else if (parts[0] === 'eval' && parts[1] === 'compare') await pageCompare(parts[2], parts[3], parts[4]);
    else if (parts[0] === 'eval') pageEvalRun();
    else location.hash = '#/';
  } catch (e) {
    view.innerHTML = `<div class="narrow"><div class="errcard">Lỗi giao diện: ${esc(e.message)}<pre>${esc(e.stack || '')}</pre></div></div>`;
  }
}
window.addEventListener('hashchange', route);

(async function init() {
  try { state.config = await api('/api/config'); }
  catch (e) { state.config = {provider: '', model: '', providers: [], keys_present: {}}; }
  const keys = Object.entries(state.config.keys_present).filter(([, v]) => v).map(([k]) => k.replace('_API_KEY', '').toLowerCase());
  $('#envinfo').innerHTML = `env: <b>${esc(state.config.provider || '—')}</b> / ${esc(state.config.model || '—')}<br>key: ${esc(keys.join(', ') || 'không có — dùng fake provider')}`;
  setupOptions();
  await Promise.all([loadRuns(), loadJobs()]);
  route();
})();
