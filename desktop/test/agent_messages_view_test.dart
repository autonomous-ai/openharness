import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/agent_messages.dart';
import 'package:harness/agent_messages/agent_messages_view.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/terminal_prompt.dart';

/// Show Agent Messages: a tab's log, newest last, with its On/Off switch. Enter
/// opens the recipient's pane; Esc closes; nothing is composed here.
AgentMessage _message(
  String id,
  DateTime at, {
  String from = 'lead',
  List<String> to = const ['api'],
  String text = 'Review of 3f2a9c1\nmore detail',
  Map<String, (String, String?)> states = const {},
}) => AgentMessage(
  id: id,
  tabId: 'tab',
  from: AgentMessageParty(machineId: 'studio', agentId: from, name: from),
  to: [
    for (final r in to)
      AgentMessageParty(machineId: 'laptop', agentId: r, name: r),
  ],
  text: text,
  at: at,
  statuses: [
    for (final MapEntry(:key, :value) in states.entries)
      AgentMessageStatus(
        machineId: 'laptop',
        agentId: key,
        state: AgentMessageState.parse(value.$1)!,
        reason: value.$2,
        at: at.millisecondsSinceEpoch,
      ),
  ],
);

void main() {
  late AgentMessagesController controller;
  late Map<String, bool> saved;
  late Object? writeError;

  setUp(() {
    saved = {};
    writeError = null;
    controller = AgentMessagesController(
      read: () async => {
        'tabs': [
          for (final MapEntry(:key, :value) in saved.entries)
            {'id': key, 'enabled': value},
        ],
      },
      write: (tabId, enabled) async {
        if (writeError case final error?) throw error;
        saved[tabId] = enabled;
        return {'tabId': tabId, 'enabled': enabled};
      },
      request: (_, _) async => {},
      nameOf: (_, agentId) => agentId,
    );
  });
  tearDown(() => controller.dispose());

  Future<List<AgentMessageParty>> open(
    WidgetTester tester,
    Future<AgentMessageLog> Function() load, {
    Brightness brightness = Brightness.dark,
  }) async {
    final opened = <AgentMessageParty>[];
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Builder(
          builder: (context) => TextButton(
            key: const ValueKey('open'),
            onPressed: () => showTerminalPrompt<void>(
              context,
              builder: (context) => AgentMessagesView(
                controller: controller,
                tabId: 'tab',
                tabName: 'app',
                load: load,
                onClose: () => Navigator.pop(context),
                onOpen: (recipient) {
                  opened.add(recipient);
                  Navigator.pop(context);
                },
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('open')));
    await tester.pumpAndSettle();
    return opened;
  }

  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day, 14, 2);

  for (final brightness in Brightness.values) {
    testWidgets('rows read time, sender → recipients, first line and state, '
        'newest last (${brightness.name})', (tester) async {
      await open(
        tester,
        () async => (
          reached: true,
          complete: true,
          messages: [
            _message(
              'm0000001',
              DateTime(2026, 10, 9, 9, 5),
              states: {'api': ('delivered', null)},
            ),
            _message(
              'm0000002',
              today,
              from: 'api',
              to: ['lead', 'web'],
              text: '\nShipped the fix\nsecond line',
              states: {
                'lead': ('delivered', null),
                'web': ('failed', 'web left the tab'),
              },
            ),
          ],
        ),
        brightness: brightness,
      );
      expect(find.text('app · Agent Messages'), findsOneWidget);
      expect(find.text('lead → api'), findsOneWidget);
      expect(find.text('Oct 9 09:05'), findsOneWidget);
      expect(find.text('Review of 3f2a9c1'), findsOneWidget);
      expect(find.text('more detail'), findsNothing);
      expect(find.text('delivered'), findsOneWidget);
      expect(find.text('api → lead, web'), findsOneWidget);
      expect(find.text('14:02'), findsOneWidget);
      expect(find.text('Shipped the fix'), findsOneWidget);
      expect(find.text('lead delivered · web failed'), findsOneWidget);
      expect(find.text('web: web left the tab'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('lead → api')).dy,
        lessThan(tester.getTopLeft(find.text('api → lead, web')).dy),
        reason: 'newest last',
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Enter opens the recipient of the focused row; arrows move', (
    tester,
  ) async {
    final opened = await open(
      tester,
      () async => (
        reached: true,
        complete: true,
        messages: [
          _message('m0000001', today, to: ['api']),
          _message('m0000002', today, from: 'api', to: ['lead']),
        ],
      ),
    );
    // The newest row has the keyboard when the log opens.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(opened.map((r) => r.agentId), ['lead']);
    expect(find.text('app · Agent Messages'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('open')));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(opened.map((r) => r.agentId), ['lead', 'api']);
  });

  testWidgets('Esc closes', (tester) async {
    final opened = await open(
      tester,
      () async => (reached: true, complete: true, messages: <AgentMessage>[]),
    );
    expect(find.text('app · Agent Messages'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('app · Agent Messages'), findsNothing);
    expect(opened, isEmpty);
  });

  testWidgets('an empty log says how to start; an unreachable one says so', (
    tester,
  ) async {
    await open(
      tester,
      () async => (reached: true, complete: true, messages: <AgentMessage>[]),
    );
    expect(
      find.text(
        'No messages yet. Turn on Agent Messages, then agents use '
        '`harness send`.',
      ),
      findsOneWidget,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await open(
      tester,
      () async => (reached: false, complete: false, messages: <AgentMessage>[]),
    );
    expect(
      find.textContaining('Could not read this tab’s messages'),
      findsOneWidget,
    );
  });

  testWidgets('a machine that did not answer is said, once', (tester) async {
    await open(
      tester,
      () async => (
        reached: true,
        complete: false,
        messages: [_message('m0000001', today)],
      ),
    );
    expect(
      find.text('Some machines didn’t answer; their messages may be missing.'),
      findsOneWidget,
    );
    expect(find.text('lead → api'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await open(
      tester,
      () async => (
        reached: true,
        complete: true,
        messages: [_message('m0000001', today)],
      ),
    );
    expect(
      find.byKey(const ValueKey('agent-messages-incomplete')),
      findsNothing,
    );
  });

  testWidgets('many recipients each with a state never overflow a row', (
    tester,
  ) async {
    final recipients = [for (var i = 0; i < 8; i++) 'worker-$i'];
    await open(
      tester,
      () async => (
        reached: true,
        complete: true,
        messages: [
          _message(
            'm0000001',
            today,
            to: recipients,
            states: {
              for (final (i, r) in recipients.indexed)
                r: (i.isEven ? 'delivered' : 'queued', null),
            },
          ),
        ],
      ),
    );
    expect(tester.takeException(), isNull);
    final state = tester.widget<Text>(
      find.byKey(const ValueKey('agent-message-state')),
    );
    expect(state.overflow, TextOverflow.ellipsis);
    expect(state.data, contains('worker-0 delivered · worker-1 queued'));
  });

  testWidgets('the switch turns Agent Messages on, and back when refused', (
    tester,
  ) async {
    await open(
      tester,
      () async => (reached: true, complete: true, messages: <AgentMessage>[]),
    );
    final toggle = find.byKey(const ValueKey('agent-messages-switch'));
    expect(tester.widget<Switch>(toggle).value, isFalse);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(toggle).value, isTrue);
    expect(saved, {'tab': true});
    writeError = StateError('offline');
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(toggle).value, isTrue, reason: 'reverted');
    expect(find.textContaining('could not be turned off'), findsOneWidget);
  });

  testWidgets('traffic in this tab reads the log again', (tester) async {
    var reads = 0;
    await open(tester, () async {
      reads++;
      return (
        reached: true,
        complete: true,
        messages: [
          for (var i = 0; i < reads; i++)
            _message('m000000$i', today.add(Duration(minutes: i))),
        ],
      );
    });
    expect(reads, 1);
    controller.handleEvent({'tabId': 'another', 'messageId': 'm1000000'});
    await tester.pumpAndSettle();
    expect(reads, 1);
    controller.handleEvent({'tabId': 'tab', 'messageId': 'm1000001'});
    await tester.pumpAndSettle();
    expect(reads, 2);
    expect(find.text('lead → api'), findsNWidgets(2));
    // Let the tab's messaging run out before the test ends.
    await tester.pump(const Duration(seconds: 11));
    expect(controller.isFlowing('tab'), isFalse);
  });

  test('times read as a clock today and with the day before', () {
    final now = DateTime(2026, 10, 10, 18);
    expect(agentMessageTime(DateTime(2026, 10, 10, 9, 7), now: now), '09:07');
    expect(
      agentMessageTime(DateTime(2026, 9, 30, 23, 59), now: now),
      'Sep 30 23:59',
    );
  });
}
