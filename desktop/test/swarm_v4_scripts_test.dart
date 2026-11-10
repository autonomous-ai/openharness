import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/capture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// Every script a person writes in: right to left, Chinese, Japanese and Korean, Thai (no spaces), emoji sequences, combining
/// marks, in an agent's chat and the project's channel, at the sizes a window has.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  final lines = [
    'مرحبا! أنا بيب. سأبدأ بقراءة المهمة #12 الآن، ثم أصلح مشكلة الصوت في الغرفة المزدحمة.',
    'שלום! אני פיפ. אני קורא את משימה 12 עכשיו ואז מתקן את בעיית הקול בחדר הצפוף.',
    'Read #12 (המשימה) and tell عبد الله about lamp-4ace "ללא שינוי" before 18:00.',
    '你好!我是 Pip。我正在阅读任务 #12,然后修复嘈杂房间里的语音问题。この文章は日本語です。한국어 문장입니다.',
    '👩‍💻 reading #12 🧑🏽‍🚀 ✅ 🇻🇳 👨‍👩‍👧‍👦 done',
    'สวัสดีครับ ผมคือพิป กำลังอ่านงานที่สิบสองแล้วจะแก้ปัญหาเสียงในห้องที่มีคนพลุกพล่าน',
    'Z̷a̷l̷g̷o̷ ̸t̸e̸x̸t̸ with ḿ̷a̷n̷y̷ marks and a lone combining mark ̈ at the start',
    'ملاحظة طويلة جدا ' * 12,
  ];

  for (final size in const [Size(1440, 860), Size(700, 800)]) {
    final at = size.width.toInt();

    testWidgets('an agent\'s chat in every script at $at wide', (tester) async {
      final server = swarmV4Channel();
      for (final line in lines) {
        swarmV4Post(server, 'Pip', line, chat: 'agent-chat-pip');
      }
      await openSwarmV4(tester, server, saved: 'agent-chat-pip', size: size);
      expect(tester.takeException(), isNull);
      // A person writes in them too.
      await tester.enterText(
        key('super-message-composer'),
        'مرحبا بيب، ابدأ الآن 🙏',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.textContaining('مرحبا بيب'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pump(const Duration(milliseconds: 300));
      await captureWindow(tester, shots, 'scripts-chat-$at');
    });

    testWidgets('the channel in every script at $at wide', (tester) async {
      final server = swarmV4Channel();
      for (final line in lines) {
        swarmV4Post(server, 'Pip', line);
      }
      await openSwarmV4(tester, server, size: size);
      expect(tester.takeException(), isNull);
      await captureWindow(tester, shots, 'scripts-channel-$at');
    });
  }
}
