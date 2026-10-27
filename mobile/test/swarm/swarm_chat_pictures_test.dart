import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// In a chat, a picture on Harness's file storage shows in place, and every
/// other file keeps its chip.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const pathProvider = MethodChannel('plugins.flutter.io/path_provider');
  late Directory temporary;

  setUp(() {
    temporary = Directory.systemTemp.createTempSync('phone-temporary-');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          pathProvider,
          (call) async =>
              call.method == 'getTemporaryDirectory' ? temporary.path : null,
        );
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pathProvider, null);
    if (temporary.existsSync()) temporary.deleteSync(recursive: true);
  });

  Map<String, dynamic> file(String id, String name, String mime) => {
    'id': id,
    'name': name,
    'mime': mime,
    'size': 2048,
    'url': 'https://$swarmAttachmentHost/$id/$name',
  };

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            agentIds: ['agent-builder'],
            lastMessageSequence: 1,
          ),
        ],
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': [
        {
          'id': 'm1',
          'conversationId': 'g1',
          'text': 'The sign-in sheet, and the plan',
          'sequence': 1,
          'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
          'attachments': [
            file('f1', 'sheet.png', 'image/png'),
            file('f2', 'plan.pdf', 'application/pdf'),
          ],
          'createdAt': DateTime.utc(2026, 10, 27, 1).toIso8601String(),
        },
      ],
      'next': null,
    };
    return fake;
  }

  testWidgets('a picture shows in place; a PDF keeps its chip', (tester) async {
    // The app's store keeps this account's files, as the shell's keeper has
    // it do. Real folders: outside the test's fake clock.
    await tester.runAsync(() => swarmAttachments.keepOnly(me));
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: backend().request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);

    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      ),
    );
    final preview = find.byKey(const ValueKey('swarm-attachment-preview-f1'));
    // Frames until the message is read; not pumpAndSettle, as a skeleton
    // breathes for as long as it is up.
    for (var i = 0; i < 50 && preview.evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(preview, findsOneWidget);
    expect(
      find.descendant(of: preview, matching: find.byType(Skeleton)),
      findsOneWidget,
      reason: 'loading',
    );
    expect(find.textContaining('sheet.png'), findsNothing);
    expect(find.textContaining('plan.pdf'), findsOneWidget);

    // Signed out: emptying waits for the fetch under way, so real time and
    // frames until it is done.
    await tester.pumpWidget(const SizedBox());
    var emptied = false;
    unawaited(swarmAttachments.keepOnly(null).then((_) => emptied = true));
    for (var i = 0; i < 200 && !emptied; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }
    expect(emptied, isTrue);
    // The cache's own cleanup, which it runs every few seconds, let run.
    await tester.pump(const Duration(minutes: 1));
  });
}
