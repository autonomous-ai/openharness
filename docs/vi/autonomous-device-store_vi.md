# Contract Autonomous robot → Harness Store, v1

Đây là tài liệu tích hợp chung cho phía Autonomous OS và OpenHarness. Luồng giữ nguyên:
`harness-use → OS loopback API → direct encrypted device connection → Harness CLI`.
[Bản English](../autonomous-device-store.md) mô tả cùng contract; nguồn máy đọc được là
[JSON schemas và fixture Blender](../contracts/autonomous-device-store-v1/).

**Trạng thái:** đã triển khai trong checkout này, chưa cài vào daemon đang chạy, chưa release hay
triển khai lên robot. OS phải kiểm tra capabilities khi hello, không suy đoán từ số phiên bản.
Sau bàn giao, mọi thay đổi contract phải được thông báo cho phía OS và cập nhật đồng bộ schemas,
fixtures, tests và hai bản tài liệu. Không âm thầm đổi nghĩa field/operation v1.

## Kết nối, capability và quyền

Giữ `proto:1`, pairing, PAKE, identity pin và E2EE của integration hiện có. JSON dưới đây là
**payload sau giải mã**, không gửi plaintext trên LAN. Mỗi RPC có `requestId` UUIDv4 mới; response
là `<type>_result`, echo đúng requestId.

OS chỉ bật tự động chuẩn bị khi `hello_result.capabilities` có đủ:

```json
["store.list", "store.inspect", "agent.prepare", "operation.get"]
```

CLI cũ/chưa nối service trả `UNSUPPORTED_CAPABILITY`; báo cần cập nhật CLI trên máy đã pair.
Không dùng `dsh_install`, `agent_create` hoặc generic dispatcher để lách capability. OS cũ vẫn hoạt
động như trước. Chỉ xử lý máy đã pair; vẫn cần role-device đã xác thực, ciphertext và application
hello. Rate limit/concurrency limit của interface cũ giữ nguyên.

Device có thể yêu cầu cài package chính thức và dependency chính thức đã được nhận diện trong Store.
Setup thực thi thật dưới quyền tài khoản trên máy, không phải sandbox. Package/dependency cộng đồng
chưa cài yêu cầu chủ máy review/cài qua Desktop. Package đã được chủ máy cài có thể dùng.
Không nhận URL/ref tùy ý, lệnh shell, engine override, bypass quyền, update/remove hay admin RPC.
Agent mới dùng permission bypass **tắt**, không có first prompt.

## 1. Khám phá và kiểm tra thông tin

```json
{"type":"store.list","requestId":"11111111-1111-4111-8111-111111111111","query":"Blender","offset":0,"limit":5}
```

Response: `{type,requestId,machineId,packages:[Package],nextOffset:number|null}`.
`query` tùy chọn, tối đa 200 ký tự; tìm tất cả từ trong ID/name/description/category. `offset` mặc định
0 (0–25000), `limit` mặc định 10 (1–10). Lặp với nextOffset đến null; catalog có thể đổi giữa các trang.
Viewer là dependency, không phải agent để chọn. Package đã cài nhưng bị unlist vẫn xuất hiện.

```json
{"type":"store.inspect","requestId":"22222222-2222-4222-8222-222222222222","packageId":"autonomous/blender"}
```

Response: `{type,requestId,machineId,package:Package,candidates:[Agent],candidatesTruncated:boolean}`.
Tối đa 5 candidate; dùng `agents.list` nếu cần xem thêm. Chỉ ghép candidate theo package identity được
lưu trong registry, không đoán theo tên hoặc recap. OS/người dùng quyết định session có đúng project
hay không; inspect/prepare không tự chiếm session.

| Field của Package | Ý nghĩa |
|---|---|
| `packageId,name,description,category,engine` | Dữ kiện từ catalog/manifest đã cài |
| `catalog,installed` | Hai boolean độc lập: có trên Store không đồng nghĩa đã cài |
| `verified,installAllowed` | Nhận diện nguồn chính thức và quyền cài tự động; không chứng minh tool chạy được |
| `viewerPackageId` | Shared viewer đã biết hoặc null |
| `version,broken` | Tree/commit đã cài nếu biết; lỗi package hoặc null |
| `capabilities` | `{source:"package_metadata",description,category}`: mô tả công bố, không phải capability đã test |
| `requirements` | `{engine,viewerPackageId,applications:null,note}`: manifest hiện chưa có danh sách dependency ứng dụng chuẩn hóa |
| `installation` | `not_installed / installed / installing / broken`; installing phản ánh install đang chạy trong service này |
| `readiness` | `{state,scope:"package_doctor",engineAuthentication:"unknown",taskSuccess:"unknown",checkedAt?,version?,lines?}` |
| `lastPreparation` | `{state,phase,error,updatedAt}` mới nhất trong bộ nhớ, hoặc null; lịch sử bền vững xem operation.get |

Readiness: `not_installed / unknown / passed / failed`. List/inspect không chạy scripts. Prepare chạy
doctor của package và viewer, lưu tối đa 10 dòng, mỗi dòng 400 ký tự, timestamp và version. Đổi version
hoặc restart daemon làm cache check mất hiệu lực. Không có doctor thì phạm vi kiểm tra là unknown.
Doctor pass là bằng chứng tại thời điểm kiểm tra, không chứng minh login/license/GPU, mọi tính năng
hay task cụ thể đều sẵn sàng. Install từ luồng khác được phản ánh khi installed index thay đổi.

Agent candidate có `{agentId,machineId,packageId,engine,workspace,state,runtime,error?}`.
`runtime` là `starting / ready / unavailable`; workspace là đường dẫn tuyệt đối canonical nếu biết.
`agents.list` cũng thêm các field tùy chọn `packageId,workspace,runtime`. Package null/absent nghĩa là
không biết, không được suy từ recap. Runtime ready cần terminal sống, engine process và native
conversation đã bind (terminal thường là ngoại lệ). Xác thực engine chưa được kiểm chứng độc lập.

## 2. Chuẩn bị agent, không giao task

```json
{
  "type":"agent.prepare",
  "requestId":"33333333-3333-4333-8333-333333333333",
  "machineId":"mac-example",
  "packageId":"autonomous/blender",
  "idempotencyKey":"prepare-airplane-001",
  "workspace":{"kind":"new","name":"airplane"}
}
```

Workspace bắt buộc, chọn đúng một dạng:

- `{"kind":"new","name":"airplane"}`: tạo trong `~/harnesses/` theo convention hiện có. Name tùy
  chọn, 1–100 ký tự ASCII chữ/số/`_`/`-`, bắt đầu bằng chữ/số. Bỏ name thì dùng tên package/thời gian.
  Nếu tên đã tồn tại, báo lỗi; không tự dùng lại folder.
- `{"kind":"existing","path":"/Users/example/harnesses/airplane"}`: thư mục tuyệt đối đã tồn tại,
  tối đa 4096 ký tự, không control characters. Resolve symlink trước khi kiểm tra. Chủ máy chọn rõ
  project này; materialize áp dụng template/instructions theo package. Nếu agent khác đang dùng
  workspace thì từ chối, không đổi project của session đó. Các request device cùng workspace được
  chặn tranh chấp trước bước tạo agent.

Không nhận `text`/`prompt`; không tự update package đã cài. Dùng lại Store install/setup/doctor,
`prepareProjectFolder`, `onCreateAgent`, `AgentCreationReceipts`. Package đã cài bỏ qua install/setup
nhưng chạy lại doctor. Dependency thiếu/doctor fail trả hướng dẫn. Package hỏng không tự ghi đè.

Response ngay sau khi ghi reservation bền vững:
`{type:"agent.prepare_result",requestId,status:"accepted",operation:Operation}`.
Retry cùng key/tham số, requestId mới → `status:"duplicate"`, cùng operation. Đổi tham số dưới cùng
key → `IDEMPOTENCY_CONFLICT`. Xem JSON đầy đủ khớp implementation trong
[blender.fixture.json](../contracts/autonomous-device-store-v1/blender.fixture.json).

Operation có:
`operationId` (64 ký tự hex thường), `machineId`, `packageId`, `state`, `phase`, `createdAt`,
`updatedAt` (Unix milliseconds), `agentId`, `workspace`, `error:{code,message}|null`, `guidance|null`,
`doctor:[]`, `taskDispatched:false`, `engineAuthentication:"unknown"`.
Các field chưa có giá trị như agentId/workspace dùng null. Lưu operationId được trả về, không tự tính.

## 3. Lifecycle, polling và phục hồi

```json
{"type":"operation.get","requestId":"44444444-4444-4444-8444-444444444444","operationId":"<64 ký tự hex nhận từ prepare>"}
```

Response `{type:"operation.get_result",requestId,operation:Operation}`. Chỉ identity đã tạo operation
được đọc nó; ID không tồn tại/thuộc device khác đều trả `OPERATION_NOT_FOUND`.
Poll khoảng 2 giây/lần, backoff khi rate limited. **V1 không thêm progress event**; polling là nguồn
trạng thái chuẩn. Sau reconnect hoặc resync, poll lại operation IDs đã lưu. Event replay/cursor và
serverInstanceId hiện có vẫn áp dụng cho task/turn.

| State | OS cần làm |
|---|---|
| `accepted` | Đã lưu ý định, chưa kết luận install/create xảy ra |
| `running` | Tiếp tục poll operation hiện tại |
| `ready` | Đã chuẩn bị package và agent runtime/conversation; **chưa giao task** |
| `failed` | Lỗi xác định như không có package; kiểm tra trước khi tạo ý định mới |
| `needs_user_action` | Hiển thị error.message + guidance; có thể cần dependency/login/workspace hoặc kết quả thực thi chưa rõ |

Phases: `accepted → install / clone / setup → doctor → workspace → create → launch → complete`.
Có thể bỏ qua hoặc lặp các phase khi package đã cài/shared dependencies. AgentId có thể đã có dù chưa
ready hoặc đang cần thao tác: mở agent đó để xử lý, không tạo thêm.

Ready chỉ xác nhận bước chuẩn bị. Không chứng minh đã dựng máy bay, đã đăng nhập hay model thành công.
Nếu engine/conversation chưa bind sau 10 phút, polling trả `ENGINE_ACTION_REQUIRED`; lỗi launch đã
biết báo sớm hơn. Hoàn tất prompt engine rồi poll lại có thể đưa cùng operation về ready. Agent biến
mất/đổi workspace khiến operation previously-ready trở thành cần thao tác.

Quy tắc retry/recovery:

- Key theo `(paired identity,idempotencyKey)` trên máy; 1–64 chữ/số ASCII/`_`/`-`.
- Ghi private journal trước side effect; creation receipt bảo vệ riêng bước spawn. Không tự hết hạn
  journal/receipt; giữ dữ liệu trong ADAPTER_DATA_DIR.
- Tối đa 4 preparation jobs đang chạy. Request device cùng package chia sẻ install; lock Store hiện
  có bao phủ Desktop/CLI. `DSH_BUSY` không cho phép chạy setup song song.
- Timeout/disconnect không hủy công việc đã accepted. Retry cùng prepare key/tham số để lấy lại ID
  hoặc poll ID cũ. Timeout không nghĩa là chưa thực thi.
- Restart: nếu creation receipt xác nhận created thì lấy lại agentId, kiểm tra registry/package/
  workspace/runtime; không spawn lại.
- Nếu journal bị ngắt mà chưa có creation xác nhận, trả `RECOVERY_REQUIRED`. Không tự chạy lại
  install/setup/tạo folder/spawn. Chủ máy kiểm tra side effects trước khi chủ động dùng key mới.
- Revoke pairing chặn bước tiếp theo ở boundary; setup/doctor/spawn đang chạy có thể đã tạo side
  effects và không luôn hủy được. Không tự xóa file/agent của người dùng. Transport bị revoke không
  được tiếp tục gửi/đọc.
- `receipt.get` hiện có dành cho turn/stop/answer, không đọc preparation. Dedupe delivery của nó còn
  trong bộ nhớ; thay đổi này **không** làm `turn.send` bền vững qua restart. Nếu task mất xác nhận
  qua restart, kiểm tra serverInstanceId và kết quả agent; không tự gửi lại vì receipt cũ biến mất.

## Lỗi

Trước accepted: `{type,requestId,error:{code,message}}`, không có operation.
Sau accepted: đọc `operation.error` và `guidance`, kể cả response duplicate.

| Code | Xử lý |
|---|---|
| `UNSUPPORTED_CAPABILITY`, `PROTO_UNSUPPORTED` | Cập nhật CLI, không gọi generic dispatcher |
| `HELLO_REQUIRED`, `RATE_LIMITED`, `BACKPRESSURE` | Hello/backoff, giữ nguyên key |
| `INVALID_REQUEST`, `MACHINE_MISMATCH` | Sửa payload/target, field lạ bị từ chối |
| `PACKAGE_NOT_FOUND`, `PACKAGE_REVIEW_REQUIRED` | Chọn package hợp lệ hoặc chủ máy review/cài |
| `PACKAGE_BROKEN`, `DEPENDENCY_NOT_READY` | Đọc doctor/broken evidence, sửa trên máy |
| `INVALID_WORKSPACE`, `WORKSPACE_IN_USE` | Chọn project khác hoặc chọn rõ candidate hiện có |
| `IDEMPOTENCY_CONFLICT` | Đối chiếu state caller, không dùng cùng key cho ý định khác |
| `OPERATION_NOT_FOUND`, `STORAGE_FAILED` | Kiểm tra identity/ID/storage; không suy ra chưa chạy |
| `INSTALL_UNCONFIRMED`, `CREATION_UNCONFIRMED`, `PREPARATION_UNCONFIRMED`, `RECOVERY_REQUIRED` | Side effects có thể tồn tại, kiểm tra trước retry mới |
| `ENGINE_ACTION_REQUIRED`, `AGENT_UNAVAILABLE` | Mở agent được trả về, xử lý login/trust/launch/target |
| `REVOKED`, `INTERNAL` | Dừng/đối chiếu, không tự tạo intent mới |

Lỗi Store/creator gốc cũng được chuyển tiếp: `CLONE_FAILED`, `SETUP_FAILED`, `DOCTOR_FAILED`,
`DSH_BUSY`, `TMUX_UNAVAILABLE`, `CWD_NOT_FOUND`, `TMUX_TOO_OLD_FOR_DSH`, `PROJECT_EXISTS`,
`PROJECT_PREPARATION_FAILED`... OS phải hiển thị code/message/guidance chưa biết, không coi là success.

## Luồng Blender hoàn chỉnh và phần Autonomous OS cần làm

1. Lưu user intent “I want to use Blender to draw an airplane for me”; kiểm tra đủ capabilities.
2. `store.list(query:"Blender")` → `store.inspect(packageId:"autonomous/blender")`. Dựa trên package
   identity/readiness/candidate, không recap. Nếu người dùng chọn session phù hợp đã có thì dùng ID
   đó và bỏ qua prepare.
3. Nếu cần agent mới, lưu `prepare-airplane-001` + workspace rồi gọi prepare. Lưu operationId, poll,
   thông báo tiến độ hoặc hướng dẫn cần thao tác. Không yêu cầu OS biết cách setup riêng Blender.
4. Khi ready, lưu machineId/agentId, tạo key task riêng **`task-airplane-001`**, rồi gửi đúng một lần:

   ```json
   {"type":"turn.send","requestId":"55555555-5555-4555-8555-555555555555","machineId":"mac-example","agentId":"agent-example","idempotencyKey":"task-airplane-001","text":"Use Blender to draw an airplane for me."}
   ```

   Không đưa task vào prepare/name/setup/first prompt. Dùng target vừa nhận, không ràng buộc với
   app focus không liên quan.
5. Lưu delivery receipt/serverInstanceId; theo dõi receipt/status/events/questions/recap. Permission
   prompt phải xử lý trên Desktop; `question.answer` không duyệt tool permissions. Chỉ báo dựng xong
   khi có kết quả công việc, không khi prepare ready.
6. OS cần: capability fallback, journal intent/keys, polling/reconnect, chọn candidate và UI/voice cho
   needs_user_action. Không cần credential hay script Blender mới.

## Kiểm thử và giới hạn

Tests bao phủ metadata/installed/readiness, install dùng chung, dependency lỗi, setup/doctor/
materialize **thật với package fixture local**, arguments tạo agent không bypass quyền, dedupe/
timeout/reconnect, restart và khoảng trống spawn/journal, symlink/workspace collision, revoke,
capability/role/encryption boundaries và schema/fixture khớp implementation.

Engine/model creation trong tests là mock. Dòng doctor Blender trong fixture là ví dụ tổng hợp.
Lượt triển khai này chưa cài Blender, chạy robot thật, gọi model có phí hay render máy bay. Cần một
lượt acceptance phối hợp Lamp → CLI mới → Blender thật sau khi cả hai phía tích hợp.

```sh
cd cli
npx tsx scripts/device-store-contract.ts --check
npx vitest run src/lib/autonomous-device --maxWorkers=1
```
