"""Screen catalog: groups, captions and UX notes for the Dial, the Pro and the Max draft (Vietnamese copy)."""
import re

SEQ = re.compile(r'^(listening-live|working-steady)-(\d\d)$')

DIAL_GROUPS = [
    ('design', 'Bảng thiết kế Focus', 'Các trạng thái chính vẽ cho cả hai pet (Claude, Codex) theo mockup newdesign.html. '
     'Nhóm này cho thấy rõ nhất ngôn ngữ hình ảnh hiện hành của Dial.'),
    ('focus', 'Mặt Focus', 'Mặt Focus (bật trong cài đặt): nền đen, pet theo engine, tên phiên cong theo mép trên, trạng thái cong ở mép dưới.'),
    ('state', 'Trạng thái nền và kết nối', 'Mặt mặc định: tên phiên cong mép trên, giữa là "Tap to talk" hoặc việc đang làm. '
     'Gồm cả mất kết nối, đang nối, đang cập nhật, ngủ, cần chú ý.'),
    ('voice', 'Giọng nói', 'Chạm để nói, chạm lần nữa để gửi. Sóng xanh khi nghe, ba ngôi sao khi gửi, bản nháp giọng nói để xem lại trước khi gửi.'),
    ('recap', 'Kết quả lượt (recap)', 'Lượt xong thì hiện tóm tắt trong khung tối, cắt theo câu trọn vẹn (tối đa 180 ký tự). Lượt mới che recap cũ.'),
    ('inbox', 'Inbox và thông báo', '[1] báo có tin chưa đọc. Inbox xếp từng tin một trang, mở tin thì focus pane đó trên máy tính và đánh dấu đã đọc.'),
    ('question', 'Câu hỏi của agent', 'Agent hỏi thì hiện câu hỏi, lựa chọn, trả lời bằng giọng nói, xem lại rồi gửi. Có cả lỗi và trường hợp host không hỗ trợ.'),
    ('nav', 'Tab, pane, app và máy', 'Giữ rồi kéo lên: panes, kéo trái: tabs. Vuốt ngang để đổi pane. Machine view và bộ chọn app (Ghostty, VS Code, Orca).'),
    ('controls', 'Controls', 'Giữ rồi kéo xuống: danh sách lệnh (Inbox, Machines, Model, Stop current turn, Nap, Find, New Harness).'),
    ('text', 'Chọn chữ, mang đoạn, tìm', 'Chọn đoạn trong pane, "mang" đoạn đó sang agent khác, tìm trong output bằng giọng nói.'),
    ('form', 'New Harness', 'Tạo agent mới từ Dial: form nhiều bước, nói tên dự án.'),
    ('caps', 'Khi host thiếu khả năng', 'Agent chạy trong app khác (Orca, terminal) nên Dial không nghe hộ được: hiện "See it in Orca" thay cho mic.'),
    ('other', 'Khác', ''),
]

DIAL_RULES = [
    ('design', r'design-.*'),
    ('focus', r'focus.*'),
    ('question', r'question.*|lit-question.*|lit-choices.*|lit-answer.*|caps-question-.*'),
    ('nav', r'tabs-.*|hold-tabs|shortcut-tabs|panes|apps.*|workspace-home|caps-machine-view.*|caps-waiting-orca|lit-workspace.*|lit-machines.*'),
    ('controls', r'controls.*|reading-controls|lit-controls.*|caps-controls-no-voice'),
    ('inbox', r'inbox-.*|notification-.*|bell-all-read|mail-.*|clear-notification|long-curved-notification|long-reading-inbox|lit-inbox-empty'),
    ('voice', r'listening.*|voice-.*|search-listening|summary-listening|completed-listening|carry-listening|lit-draft.*'),
    ('recap', r'completed.*|next-.*|complete-sentence|acknowledgment-explanation|continued-sentence|three-sentences|long-reading|'
              r'punctuation|growth-arrows|summary-.*|photo-summary-.*'),
    ('text', r'selection.*|lit-selection.*|carry-.*|reading-return|output-search.*|find-named'),
    ('form', r'new-harness.*|spoken-project|lit-form.*'),
    ('state', r'ready|working.*|done|asleep|booped|attention|needs-attention|unread-persistent|offline|connecting|updating|return|'
              r'straight-title|long-name|short-name-working|photo-long-status|mobile-.*'),
    ('caps', r'caps-.*'),
]

DIAL_CAPTIONS = {
    'ready': 'Sẵn sàng: tên phiên cong ở mép trên, "Tap to talk".',
    'working': 'Đang làm: việc hiện tại màu xanh ở giữa.',
    'done': 'Tư thế "xong" (mặt mặc định không vẽ pet).',
    'asleep': 'Nap (mặt mặc định không vẽ pet).',
    'booped': 'Pet bị chạm (mặt mặc định không vẽ pet).',
    'attention': 'Có agent chờ người: huy hiệu chuông 1 ở đáy.',
    'needs-attention': 'Cần chú ý sau khi có câu hỏi chờ.',
    'offline': 'Mất cáp: chỉ chữ "Harness".',
    'connecting': 'Đang nối với daemon.',
    'updating': 'Đang cập nhật firmware qua cáp.',
    'return': 'Có đoạn đọc dở để quay lại.',
    'listening': 'Đang nghe: sóng xanh.',
    'voice-transmitting': 'Đang gửi giọng nói: ba ngôi sao.',
    'voice-retry': 'Gửi giọng nói lỗi: "Try again".',
    'voice-review-hold': 'Giữ để xem trước bản ghi.',
    'voice-draft': 'Bản nháp giọng nói trước khi gửi.',
    'voice-draft-options': 'Tuỳ chọn bản nháp: thêm, hoàn tác, quay lại.',
    'completed': 'Recap: lượt xong, tóm tắt trong khung tối.',
    'next-turn': 'Lượt mới bắt đầu: recap cũ bị che.',
    'completed-attention': 'Recap trong lúc agent khác đang chờ.',
    'long-reading': 'Recap dài, đọc bằng cách kéo.',
    'controls': 'Controls: Inbox, Machines, Model, Stop current turn.',
    'controls-core': 'Controls khi host không có lệnh tuỳ chọn.',
    'hold-tabs': 'Giữ rồi kéo trái: chọn tab.',
    'tabs-names': 'Bộ chọn tab: tab giữa xanh, hai bên ló ra.',
    'tabs-empty': 'Chưa có tab.',
    'panes': 'Bộ chọn pane trong tab.',
    'apps': 'Bộ chọn app: Ghostty, 3 agent.',
    'apps-waiting': 'Bộ chọn app: VS Code có 1 agent đang chờ.',
    'inbox-unread': 'Inbox: một tin chưa đọc (máy, agent, nội dung).',
    'inbox-question': 'Inbox: tin là câu hỏi.',
    'inbox-offline': 'Inbox khi agent đã offline.',
    'notification-multiple': 'Nhiều tin: 1/2, mũi tên sang tin sau.',
    'selection': 'Chọn chữ: [find] [line] [carry].',
    'carry-home': 'Đang mang một đoạn: "Do anything", thả để đọc.',
    'new-harness': 'New Harness: form tạo agent mới.',
    'spoken-project': 'New Harness: nói tên dự án.',
    'question-choice': 'Câu hỏi có lựa chọn.',
    'question-review': 'Xem lại câu trả lời trước khi gửi.',
    'question-refused': 'Host từ chối câu trả lời.',
    'caps-no-voice-hint': 'Agent trong Orca: chạm thì hiện "See it in Orca".',
    'caps-machine-view': 'Machine view khi agent ở Orca.',
    'design-claude-rest': 'Pet Claude nghỉ: "Hold for tabs".',
    'design-claude-working': 'Claude đang làm: pet đầu bếp, việc + thời gian cong ở đáy.',
    'design-claude-recap': 'Recap với pet nhỏ phía trên.',
    'design-claude-question': 'Câu hỏi trong khung tối dưới pet.',
    'design-claude-voice-listening': 'Nghe: pet đeo tai nghe.',
    'design-claude-voice-sending': 'Gửi: pet bỏ thư vào hộp.',
    'design-claude-machine-view': 'Machine view: tên app nhỏ dưới tên phiên.',
    'design-claude-apps': 'Bộ chọn app.',
    'design-claude-waiting-orca': 'Đang chờ người, trong Orca.',
    'design-claude-notice-no-focus': 'Thông báo của agent khác khi không focus được pane.',
    'design-codex-rest': 'Pet Codex nghỉ: "Your move".',
    'design-codex-working': 'Codex đang làm.',
    'focus-connecting': 'Focus: đang nối.',
    'focus-working': 'Focus: pet đang làm, trạng thái cong ở đáy.',
    'focus-question': 'Focus: câu hỏi.',
    'focus-recap': 'Focus: recap.',
    'focus-inbox': 'Focus: inbox.',
    'focus-tabs': 'Focus: bộ chọn tab.',
    'focus-panes': 'Focus: bộ chọn pane.',
    'focus-panes-empty': 'Tab chưa có pane: "Choose a tab".',
    'focus-voice-bars': 'Focus: engine không có pet thì vẽ sóng.',
    'lit-question': 'Trang chữ: câu hỏi, [later] [say] [next].',
    'lit-choices': 'Trang chữ: chọn một trong ba.',
    'lit-answer-review': 'Trang chữ: xem lại câu trả lời.',
    'lit-machines': 'Danh sách máy: ready, offline.',
    'lit-form': 'New Harness: chọn engine và thư mục.',
}

PRO_GROUPS = [
    ('home', 'Home (thẻ tab)', 'Mỗi tab là một thẻ bìa 540×560: tên, số agent cỡ lớn, pill trạng thái (đang làm, đang hỏi, All done), hàng logo engine. '
     'Thẻ Notices đứng đầu khi có thông báo, thẻ Working (pet các agent đang chạy) đứng sau. Vuốt ngang đổi thẻ, chạm để vào.'),
    ('agent', 'Phòng agent', 'Một pet cỡ 2x trên nền, bong bóng nói việc đang làm hoặc câu hỏi, tên agent ở trên. Vuốt ngang sang agent kế.'),
    ('recap', 'Recap', 'Agent xong (hoặc lỗi) thì vào thẳng recap: bong bóng tóm tắt tối đa 8 dòng, pet "ký tên" bên dưới. Lỗi thì bong bóng hồng. '
     'Kéo dọc để cuộn pane trên máy tính.'),
    ('talk', 'Talk (giọng nói)', 'Đang nghe: pet đeo tai nghe. Đang gửi: pet bỏ thư. Engine không có pet thì vẽ sóng 7 thanh xanh và ba ngôi sao như Dial.'),
    ('inbox', 'Notices (inbox)', 'Danh sách: agent đang hỏi trước, rồi tin chưa đọc mới nhất. Mỗi hàng là avatar pet + bong bóng (tên, tuổi, 2 dòng). Chạm để mở.'),
    ('toast', 'Toast và banner', 'Thông báo của agent khác trượt xuống trên cùng khi đang ở phòng hoặc recap; ảnh @ms là thời điểm sau khi toast hiện.'),
    ('ota', 'Cập nhật firmware', 'Vòng tiến trình, "Updating to 0.1.2", nhắc giữ cáp. Màn này bỏ qua mọi chạm.'),
]


def pro_group(n):
    if 'toast' in n or 'banner' in n:
        return 'toast'
    if n.startswith('tabs') or n.startswith('notice-'):
        return 'home'
    for k in ('agent', 'recap', 'talk', 'inbox', 'ota'):
        if n.startswith(k):
            return k
    return 'home'


PRO_CAPTIONS = {
    'tabs': 'Home: thẻ tab Firmware, 2 agent đang làm; tab kế bên ló ra.',
    'tabs-bell': 'Home khi có tin chưa đọc (Home không vẽ chuông).',
    'tabs-mock': 'Home theo mockup gốc: Harness repo, 6 agent.',
    'tabs-0+2': 'Home ở tab 0, thêm 2 tab.',
    'tabs-2+2': 'Home ở tab 2, thêm 2 tab.',
    'tabs-long': 'Tên tab dài tối đa.',
    'tabs-9': 'Chín tab, nhiều hơn một trang.',
    'tabs-linkdown': 'Mất cáp.',
    'tabs-1': 'Home ở tab 1.', 'tabs-3': 'Home ở tab 3.', 'tabs-5': 'Home ở tab 5.',
    'tabs-seven': 'Thẻ 7 agent: 4 làm, 1 hỏi, 4 logo và +3.',
    'tabs-single': 'Một tab, một agent: "All done".',
    'tabs-notices': 'Thẻ Notices: số tin mới, ba hàng đầu.',
    'tabs-working': 'Thẻ Working: pet của agent đang chạy, tên và thời gian.',
    'tabs-working-codex': 'Thẻ Working với các agent Codex và Muse.',
    'tabs-none': 'Màn đầu: chưa có tab nào.',
    'tabs-banner': 'Home kèm toast.',
    'notice-updated': 'Pill "Updated to 0.1.3" sau khi cập nhật.',
    'notice-failed': 'Pill cập nhật lỗi, sẽ thử lại.',
    'agent-fw': 'Claude đang sửa code: pet đầu bếp, bong bóng việc đang làm, thời gian.',
    'agent-cli': 'Codex đang hỏi: bong bóng câu hỏi trắng, dấu "?".',
    'agent-be': 'Codex đang chạy test.',
    'agent-desk': 'Agent đã xong thì mở thẳng recap.',
    'agent-kilo': 'Kilo không có pet: logo đứng chỗ pet.',
    'agent-fw-long': 'Việc đang làm dài, cắt bằng dấu ba chấm.',
    'agent-cli-long': 'Câu hỏi dài.',
    'agent-be-offline': 'Máy của agent offline: "My machine is offline."',
    'agent-fw-unread': 'Phòng agent khi có tin chưa đọc.',
    'agent-fw-ask': 'Claude đang hỏi.',
    'agent-web-ask': 'Muse đang hỏi.',
    'agent-fw-scroll': 'Phòng agent sau khi cuộn.',
    'agent-fw-notice': 'Pill "Didn\'t catch that" khi giọng nói không nhận được.',
    'agent-fw-updated': 'Phòng agent kèm pill đã cập nhật.',
    'agent-fw-failed': 'Phòng agent kèm pill cập nhật lỗi.',
    'recap-desk': 'Recap: bong bóng tóm tắt, pet ký tên.',
    'recap-desk-unread': 'Recap chưa đọc.',
    'recap-desk-long': 'Recap dài: dòng cuối nhạt, ba chấm.',
    'recap-desk-viet': 'Recap tiếng Việt có đường dẫn dài.',
    'recap-desk-short': 'Recap ngắn: "All green."',
    'recap-desk-medium': 'Recap hai câu.',
    'recap-desk-testfail': 'Recap khi test lỗi.',
    'recap-desk-extreme': 'Recap cực dài.',
    'recap-docs': 'Recap của Codex.',
    'recap-docs-long': 'Recap Codex dài.',
    'recap-docs-unreadfail': 'Lượt lỗi chưa đọc: bong bóng hồng.',
    'recap-kilo': 'Recap của engine không có pet.',
    'talk-fw': 'Đang nghe: pet Claude đeo tai nghe.',
    'talk-fw-quiet': 'Đang nghe khi người chưa nói.',
    'talk-fw-send': 'Đang gửi: pet bỏ thư vào hộp.',
    'talk-cur': 'Cursor (không có pet): sóng 7 thanh xanh.',
    'talk-cur-send': 'Cursor đang gửi: ba ngôi sao.',
    'talk-be': 'Codex đang nghe.',
    'talk-be-send': 'Codex đang gửi.',
    'inbox': 'Notices: 5 tin, câu hỏi đứng đầu.',
    'inbox-viet': 'Notices có nội dung tiếng Việt.',
    'inbox-quiet': 'Notices chỉ còn agent đang hỏi.',
    'inbox-failed': 'Notices có lượt lỗi.',
    'ota-0': 'Bắt đầu cập nhật.', 'ota-62': 'Đang cập nhật 62%.', 'ota-100': 'Ghi xong 100%.',
    'ota-restart': 'Khởi động lại vào bản mới.',
}

MAX_CAPTIONS = {
    'working': 'Ba làn đang làm: tên, engine, máy, trạng thái, việc, bước gần nhất, thời gian.',
    'asking': 'Agent hỏi: làn vàng, đứng đầu (chỉ đọc ở mốc này).',
    'failed': 'Lượt lỗi: làn đỏ.',
    'listening': 'Đang nghe cho backend: ô Talk đỏ, làn được chọn có viền.',
    'sending': 'Đang gửi.',
    'notice': 'Toast "Sent to backend".',
    'five-p1': 'Năm agent, trang 1 (chấm trang ở đáy).',
    'five-p2': 'Năm agent, trang 2.',
    'long': 'Chữ dài trong làn.',
    'noagents': 'Có cáp, chưa có agent.',
    'update': 'Đang cập nhật firmware.',
    'linkdown': 'Mất cáp: "Not connected".',
}

DEVICES = {
    'dial': {
        'title': 'Harness Device (Dial)', 'short': 'Dial',
        'spec': 'ESP32-S3 · AMOLED tròn 1,75" 466×466 · cảm ứng · micro · loa · cáp USB',
        'shape': 'round',
        'ux': [
            'Chạm mặt kính để nói, chạm lần nữa để gửi. Agent nằm trong app khác (Orca, terminal) thì hiện "See it in Orca".',
            'Kéo dọc: cuộn pane đang chọn trên máy tính. Vuốt ngang: đổi pane. Kéo không bao giờ bật mic.',
            'Giữ để mở menu bốn hướng: lên là panes, trái là tabs, phải là inbox, xuống là controls. Trượt rồi thả, về giữa để huỷ.',
            'Màu: nền than #181818 (Focus nền đen), chữ #EFE7DE, phụ #ADA6AD, một accent tím #C6AAEF, xanh giọng nói #00FF2F, '
            'xong #0DBC79, hỏi #E5E510, lỗi #CD3131. Một cỡ chữ giao diện.',
        ],
    },
    'pro': {
        'title': 'Harness Pro', 'short': 'Pro',
        'spec': 'ESP32-P4 · màn vuông 720×720 · cảm ứng GT911 · nút cạnh · micro · chỉ qua cáp (không Wi-Fi)',
        'shape': 'square',
        'ux': [
            'Sáu view: Home (thẻ tab), phòng agent, recap, talk, Notices, cập nhật. Không có view danh sách agent trong tab: thẻ tab mở thẳng agent.',
            'Nút cạnh: bấm để huỷ ghi âm, lùi một cấp, hoặc về Home; giữ 0,8 s để tắt hoặc bật màn.',
            'Agent xong thì mở thẳng recap; agent bắt đầu làm lại thì recap tự lật về phòng agent.',
            'Chữ Inter và JetBrains Mono. Nền navy, bong bóng màu giấy ấm; thẻ tab theo màu engine (Claude cam, Codex xanh).',
        ],
    },
    'max': {
        'title': 'Harness Max (bản nháp hiện tại)', 'short': 'Max nháp',
        'spec': 'ESP32-P4 · màn 8,8" dùng nằm ngang 1920×480 · cảm ứng GT9271 · cáp USB · chưa lên bench',
        'shape': 'bar',
        'ux': [
            'Bản nháp chưa merge (nhánh feat/harness-max-all, commit b4e0e70828), mốc 0 và 1 của roadmap; chưa lên board thật.',
            'Rail bên trái (máy và số agent), ba làn agent, ô Talk bên phải. Agent cần người đứng trước, rồi agent đang làm.',
            'Chạm một làn để chọn và mở agent đó trên máy tính. Chạm Talk để nói với agent đang chọn.',
            'Chưa có ở mốc này: trả lời và duyệt từ thanh, tạo agent mới, Wi-Fi.',
        ],
    },
}

# What the Dial and the Pro do that the Max draft does not draw yet (for the Max UI/UX work).
GAPS = [
    ('Tổng quan theo tab / swarm', 'Bộ chọn tab, pane, app', 'Home thẻ tab, thẻ Working', 'Chỉ có rail máy + phân trang làn'),
    ('Recap khi xong lượt', 'Khung recap, cắt theo câu', 'Bong bóng recap, pet ký tên', 'Trạng thái "Done" + tóm tắt trong làn'),
    ('Inbox / Notices', 'Inbox từng tin một trang', 'Danh sách Notices', 'Chưa có (chỉ toast)'),
    ('Trả lời câu hỏi', 'Lựa chọn, giọng nói, xem lại, gửi', 'Chỉ hiện câu hỏi', 'Chỉ đọc (mốc sau)'),
    ('Pet và chuyển động', 'Pet Focus theo engine', 'Pet 2x, cảnh làm việc/nghe/gửi', 'Không có pet'),
    ('Giọng nói lỗi / thử lại', 'Try again, bản nháp', 'Huỷ bằng nút cạnh', 'Chưa vẽ'),
    ('Controls / lệnh', 'Stop turn, Model, Nap, New Harness', 'Không có', 'Không có'),
    ('Máy offline', 'Danh sách máy', '"My machine is offline."', 'Rail ghi "Offline"'),
    ('Cập nhật firmware', 'Màn Updating', 'Vòng tiến trình + pill kết quả', 'Có (update)'),
]


def dial_group(name):
    for key, rx in DIAL_RULES:
        if re.fullmatch(rx, name):
            return key
    return 'other'
