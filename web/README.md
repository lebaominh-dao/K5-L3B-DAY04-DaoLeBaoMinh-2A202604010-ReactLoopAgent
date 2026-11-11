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
  - Dòng **"▦ … tokens · … lần gọi model · … tool call"**: bấm vào để xem bảng usage từng step. Bảng đọc được cả format OpenAI (`prompt_tokens` / `completion_tokens`) và Anthropic (`input_tokens` / `output_tokens`).
- Rê chuột lên các thuật ngữ có gạch chấm (step, finish, tool call, max_steps…) để xem giải thích. Màn hình chào có bảng chú giải.
- Sidebar trái là lịch sử các lần chạy trong phiên server. Lịch sử lưu trong bộ nhớ, mất khi tắt server.
- Nút cuối sidebar đổi giao diện: tự động / sáng / tối.

## Eval (sidebar → Eval)

- **Chạy eval:** chạy `evals/run_evals.py` ở background.
  - Phạm vi: toàn bộ hoặc một case (`--case`), có thể thêm `--bonus`.
  - Tên file output tự đặt, ví dụ `eval_before.json` / `eval_after.json`. File ghi ở thư mục gốc repo.
  - Trong "Tùy chọn nâng cao" chỉnh được provider/model của agent, judge provider / judge model (để trống = dùng model agent), `max_steps`, `workers`.
  - Có trạng thái đang chạy / xong / lỗi, log, và nút dừng.
  - Mỗi job hiện **model agent**, **model judge** và `max_steps` đúng như lúc khởi chạy (tính giống `run_evals.py`: tham số > biến môi trường > mặc định). Nếu không chọn judge, `run_evals.py` dùng chính model agent để chấm; UI ghi rõ "(mặc định = agent)". Khi job xong, cấu hình này được đối chiếu với `config` trong file output.
  - Eval gọi model thật nên cần key.
- **Kết quả eval:**
  - Chọn file eval ở thư mục gốc hoặc mở file từ máy.
  - Hiện điểm tổng và bảng case: điểm tô màu (≥ 80 xanh, ≥ 50 vàng, < 50 đỏ), trạng thái, `grade.reason`, `grade.improvement`, kiểm tra máy (`grade.mechanical`).
  - Bảng mặc định xếp theo **điểm tăng dần**; case lỗi / chưa chấm luôn nằm **trên cùng** (lỗi trước, chưa chấm sau), cùng điểm thì giữ thứ tự gốc. Bấm tiêu đề cột Case / Điểm / Trạng thái để đổi kiểu sắp xếp (bấm lại để đảo chiều). Lựa chọn được nhớ trong trình duyệt, nên mở một case rồi quay lại vẫn giữ nguyên.
  - Bấm một case để mở nó dưới dạng hội thoại (câu hỏi → các bước → câu trả lời), kèm thẻ điểm judge.
- **So sánh before / after:**
  - Hai cột điểm và Δ tô màu theo từng case, cùng tổng số lần gọi model và token.
  - Bảng theo case mặc định xếp theo điểm **after** tăng dần (case lỗi / chưa chấm ở đầu). Bấm tiêu đề Before / After / Δ / Trạng thái để đổi; Δ tăng dần = case giảm điểm nhiều nhất lên trước.
  - Bấm một case để xem hai hội thoại cạnh nhau.

## API (dùng nội bộ bởi UI)

| Method | Path | Ý nghĩa |
|---|---|---|
| GET | `/api/config` | provider/model từ env, key nào có (true/false) |
| POST | `/api/run` | chạy agent; body: `question, provider, model, mode, max_steps, fail, bonus, fake_script` |
| GET | `/api/runs`, `/api/runs/<id>` | lịch sử chạy trong phiên |
| POST | `/api/eval/start`, `/api/eval/stop` | chạy / dừng eval |
| GET | `/api/eval/jobs` | trạng thái và log các job eval |
| GET | `/api/evals`, `/api/evals/file?name=` | danh sách và nội dung file eval ở thư mục gốc |
