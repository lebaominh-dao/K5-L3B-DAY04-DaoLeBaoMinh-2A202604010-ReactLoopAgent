# Giao diện web — Status Agent Lab

Giao diện dạng chat để thử Status Investigation Agent, xem các bước agent đã làm, token đã dùng, và chạy / so sánh eval. Backend chỉ dùng Python standard library. Frontend là HTML/CSS/JS viết tay (`index.html`, `app.css`, `app.js`), không cần Node, không cần build, không cài package.

```bash
python3 web/server.py              # mở http://127.0.0.1:8000
python3 web/server.py --port 8765
```

- Server chỉ bind `127.0.0.1`.
- `PROVIDER`, `MODEL`, `JUDGE_PROVIDER`, `JUDGE_MODEL` và API key được đọc từ biến môi trường. Nếu có `.env` ở thư mục gốc, server tự đọc (không ghi đè biến đã đặt).
- UI chỉ biết key **có hay không**, không bao giờ nhận giá trị key. Log và traceback cũng được lọc key trước khi trả ra.
- Mỗi lần chạy, `agent.py` được `importlib.reload`, nên sửa code xong chỉ cần hỏi lại, không cần khởi động lại server.

## Hỏi agent (màn hình chính)

- Gõ câu hỏi ở ô dưới cùng rồi nhấn **Enter** (Shift+Enter để xuống dòng), hoặc bấm một câu hỏi mẫu.
- Nút **⚙** cạnh ô nhập mở tùy chọn:
  - provider: `fake provider`, env, hoặc openai / gemini / anthropic / openrouter
  - model
  - `snapshot` / `live`
  - `max_steps`
  - `fail` (giả lập tool timeout)
  - `bonus` (dùng `BonusTools`)
  - **version agent**: bản đang sửa (working copy) hoặc một git tag (`v0`, `v1`…), xem mục [Version agent](#version-agent-git-tag)
  - **scenario**: tình huống chèn lỗi giống eval, xem mục [Scenario và case eval](#scenario-và-case-eval)
  - **Dùng câu hỏi của case…**: nạp câu hỏi của một case eval
- **Fake provider** không cần key. Agent nhận các câu trả lời "model" lấy từ một kịch bản JSON, giống `FakeProvider` trong `tests/test_lab.py`. Chọn kịch bản mẫu hoặc bấm **Sửa…** để tự viết. Có sẵn:
  - một tool
  - nhiều tool + incident
  - arguments JSON lỗi (Bài 2)
  - tool không tồn tại
  - câu trả lời có bảng markdown
  - `finish=length`
  - chạm `max_steps`
- Câu trả lời hiện như một cuộc hội thoại:
  - Câu hỏi là bubble bên phải.
  - Khối **"Agent đã chạy N step · M tool call"** liệt kê từng lần gọi model và từng tool call trên một dòng, ví dụ `get_status("github", "Actions") → overall none · 5 incident`. Bấm vào một dòng để xem `arguments` / `result` JSON.
  - Tool lỗi (`ok: false`, `INVALID_ARGUMENTS`, timeout) có màu đỏ. `max_steps` và event lạ (ví dụ `validation_missing_source`) có màu vàng.
  - Câu trả lời render markdown đơn giản: in đậm, `code`, danh sách, link bấm được, bảng GFM (có căn lề; bảng rộng cuộn ngang trong khung riêng).
  - Badge trạng thái: `completed` xanh, `max_steps` vàng, `error` / `exception` đỏ. Exception hiện kèm traceback thu gọn.
  - Badge `⎇ v0` / `⎇ working copy` cho biết câu trả lời đến từ version agent nào (sidebar cũng ghi tag cạnh mỗi lần chạy). Badge `⚑ status_injection` cho biết scenario.
  - Tool result có trường do scenario chèn vào (`external_notice`, `context_note`, `distractors`, update `untrusted`) được tô vàng ngay trên dòng tool, ví dụ `overall none · 5 incident · ⚠ có external_notice`.
  - Dòng **"▦ … tokens · … lần gọi model · … tool call"**: bấm vào để xem bảng usage từng step. Bảng đọc được cả format OpenAI (`prompt_tokens` / `completion_tokens`) và Anthropic (`input_tokens` / `output_tokens`).
- Rê chuột lên các thuật ngữ có gạch chấm (step, finish, tool call, max_steps…) để xem giải thích.
- Sidebar trái là lịch sử các lần chạy trong phiên server. Lịch sử lưu trong bộ nhớ, mất khi tắt server.
- Nút cuối sidebar đổi giao diện: tự động / sáng / tối.

## Scenario và case eval

Chọn trong menu ⚙ của chat để tái hiện đúng tình huống eval khi demo.

| Bộ | Tools | Scenario |
|---|---|---|
| Chính (không bật bonus) | `ScenarioTools(scenario, fail)` từ `evals/scenarios.py` (chỉ import, không sửa) | `normal`, `cloudflare_timeout`, `injection`, `status_injection`, `noisy_status` |
| Bonus | `BonusTools(mode, scenario=...)` | `normal`, `rate_limit_once`, `rate_limit_always`, `format_once`, `noisy`, `injection` |

- Danh sách scenario đổi theo ô bonus; mỗi giá trị có mô tả ngắn ngay dưới ô chọn. Server chỉ nhận giá trị trong whitelist.
- `ScenarioTools` luôn chạy snapshot, nên với bộ chính, scenario khác `normal` sẽ khoá mode ở `snapshot` (có ghi chú trong menu). `normal` + `live` vẫn dùng `StatusTools` gọi API thật.
- Bonus không có `fail` (ô bị khoá); dùng `rate_limit_*` để giả lập lỗi.
- **Dùng câu hỏi của case…** đọc `evals/cases.json`, hoặc `bonus/cases.json` khi bật bonus. Chọn một case thì điền sẵn câu hỏi, scenario, `fail` và `max_steps` như eval (8, bonus 16). Một thẻ phía trên ô nhập hiện `expected` thu gọn để đối chiếu; `expected` **không** được gửi cho agent.
- Nếu gửi đúng câu hỏi của case, lịch sử run ghi lại `case_id`, nên mở lại hội thoại vẫn thấy thẻ `expected`.

## Eval (sidebar → Eval)

- **Chạy eval:** chạy `evals/run_evals.py` ở background.
  - Phạm vi: toàn bộ hoặc một case (`--case`), có thể thêm `--bonus`.
  - Chọn **version agent**. Tên file mặc định là `eval_<tag>.json`, hoặc `eval_wip.json` với bản đang sửa; có thể tự đặt tên khác. File luôn ghi ở thư mục gốc repo.
  - Nếu file output đã tồn tại, UI hỏi trước khi ghi đè; không bao giờ tự ghi đè.
  - Trong "Tùy chọn nâng cao" chỉnh được provider/model của agent, judge provider / judge model (để trống = dùng model agent), `max_steps`, `workers`.
  - Có trạng thái đang chạy / xong / lỗi, log, và nút dừng.
  - Danh sách job (kèm cấu hình và 120 dòng log cuối) được **lưu trong trình duyệt** (`localStorage`), nên khởi động lại server vẫn còn. Job đang chạy mà server khởi động lại sẽ hiện "mất theo dõi", kèm cho biết file output đã được ghi sau lúc bắt đầu hay chưa. Nút × xoá một job khỏi danh sách; "Xoá các job đã xong" dọn cả danh sách. Cả hai không xoá file kết quả. Lưu theo từng trình duyệt, tối đa 60 job.
  - Mỗi job hiện **version** (tag + commit), **model agent**, **model judge** và `max_steps` đúng như lúc khởi chạy (tính giống `run_evals.py`: tham số > biến môi trường > mặc định). Nếu không chọn judge, `run_evals.py` dùng chính model agent để chấm; UI ghi rõ "(mặc định = agent)". Khi job xong, cấu hình này được đối chiếu với `config` trong file output.
  - Eval gọi model thật nên cần key.
- **Kết quả eval:**
  - Chọn file eval ở thư mục gốc hoặc mở file từ máy.
  - Hiện điểm tổng và bảng case: điểm tô màu (≥ 80 xanh, ≥ 50 vàng, < 50 đỏ), trạng thái, `grade.reason`, `grade.improvement`, kiểm tra máy (`grade.mechanical`).
  - Bảng mặc định xếp theo **điểm tăng dần**; case lỗi / chưa chấm luôn nằm **trên cùng** (lỗi trước, chưa chấm sau), cùng điểm thì giữ thứ tự gốc. Bấm tiêu đề cột Case / Điểm / Trạng thái để đổi kiểu sắp xếp (bấm lại để đảo chiều). Lựa chọn được nhớ trong trình duyệt, nên mở một case rồi quay lại vẫn giữ nguyên.
  - Bấm một case để mở nó dưới dạng hội thoại (câu hỏi → các bước → câu trả lời), kèm thẻ điểm judge.
- **So sánh before / after:**
  - Hai cột điểm và Δ tô màu theo từng case, cùng tổng số lần gọi model và token.
  - Bảng theo case mặc định xếp theo điểm **after** tăng dần (case lỗi / chưa chấm ở đầu). Bấm tiêu đề Before / After / Δ / Trạng thái để đổi; Δ tăng dần = case giảm điểm nhiều nhất lên trước.
  - Bấm một case để xem hai hội thoại cạnh nhau (trái = before, phải = after; trên điện thoại xếp chồng). Mỗi cột có điểm, `grade.reason`, kiểm tra máy và hội thoại đầy đủ. Dòng đầu tóm tắt, ví dụ `v0: — (lỗi) → v1: 85`.
  - Nút **"Chạy lại case này trên cả hai version"**: chạy `--case X` cho version A và B (mặc định là version đã tạo hai file), mỗi bên ghi file riêng `eval_<tag>_<case>_<thời gian>.json`, dùng cùng config với file đang xem. Xong thì có link mở kết quả.
  - Nếu hai file có config khác nhau (`provider`, `model`, `judge_provider`, `judge_model`, `max_steps`, `dataset`), trang hiện cảnh báo kèm bảng khác biệt.
  - LLM không deterministic: một lần chạy chưa đủ chứng minh cải tiến. Nên chạy lại vài lần trước khi kết luận.

## Version agent (git tag)

Mỗi version là một git tag, ví dụ `v0` (đã có), rồi `v1`, `v2`… do bạn tạo sau khi sửa `agent.py`:

```bash
git tag -a v1 -m "v1: thêm validation nguồn (Bài 4)"
```

- Danh sách version gồm "Bản đang sửa (working copy)" và các tag trong `git tag --list` (sắp theo version, kèm message của tag). Tải lại trang để thấy tag mới.
- **Hỏi agent với một tag:** server đọc `git show <tag>:agent.py` và nạp thành module riêng (`agent_<tag>_<commit>`). Không checkout, không ghi đè `agent.py`. Lưu ý: các import bên trong (`status_tools`, `providers`, `bonus`…) vẫn là **bản hiện tại** trong thư mục làm việc, không phải bản ở tag.
- **Chạy eval với một tag:** server tạo (hoặc tái dùng) worktree `.versions/<tag>` bằng `git worktree add --detach`, rồi chạy `evals/run_evals.py` với `cwd` là worktree đó. Vì vậy eval dùng toàn bộ code ở tag (agent, tools, evals). File kết quả vẫn ghi về thư mục chính. `.versions/` đã nằm trong `.gitignore`. Nếu tag bị dời sang commit khác, worktree tự chuyển theo.
- Server ghi lại file eval nào được tạo bởi version nào trong `.versions/index.json`. File không có trong đó thì đoán theo tên (`eval_<tag>…json`).
- Chỉ chấp nhận tên có trong `git tag --list` (chữ, số, `.`, `_`, `-`). Mọi lệnh git chạy bằng list args, không qua shell.
- Dọn worktree khi không cần nữa:

```bash
git worktree remove .versions/v0
```

## API (dùng nội bộ bởi UI)

| Method | Path | Ý nghĩa |
|---|---|---|
| GET | `/api/config` | provider/model từ env, key nào có (true/false) |
| GET | `/api/versions` | `wip` + các git tag (tên, commit, ngày, message) |
| GET | `/api/scenarios` | scenario hợp lệ + mô tả cho bộ chính và bonus |
| GET | `/api/cases?dataset=core\|bonus` | id, câu hỏi, scenario, fail, expected của các case eval |
| POST | `/api/run` | chạy agent; body: `question, version, scenario, case_id, provider, model, mode, max_steps, fail, bonus, fake_script` |
| GET | `/api/runs`, `/api/runs/<id>` | lịch sử chạy trong phiên |
| POST | `/api/eval/start`, `/api/eval/stop` | chạy / dừng eval; `version` chọn tag. File output đã tồn tại → 409, gửi lại với `overwrite: true` sau khi người dùng xác nhận |
| GET | `/api/eval/jobs` | trạng thái và log các job eval |
| GET | `/api/evals`, `/api/evals/file?name=` | danh sách và nội dung file eval ở thư mục gốc |
