import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A Swarm chat on the phone, as Tony's prototype has it: who wrote each
/// message and in what role, follow-ups grouped, a reply's quote that brings
/// its original into view, Reply, the @ picker, no way to attach a file, and
/// a post that shows at once and says when it is not confirmed.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String text = 'hello',
    String author = 'agent-builder',
    String? replyTo,
    int minute = 0,
    DateTime? at,
    List<Map<String, dynamic>> attachments = const [],
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'replyTo': ?replyTo,
    'author': author == me
        ? {'kind': 'person', 'id': me, 'name': 'tony'}
        : {
            'kind': 'agent',
            'id': author,
            'name': author == 'agent-lead' ? 'River' : 'Nova',
          },
    'attachments': attachments,
    'createdAt': (at ?? DateTime.utc(2026, 10, 27, 1, minute))
        .toUtc()
        .toIso8601String(),
  };

  /// A decision River asked in chat g1, at [minute] past one.
  Map<String, dynamic> decision(String id, {int minute = 0}) => {
    'id': id,
    'projectId': project,
    'projectName': 'Mobile',
    'conversationId': 'g1',
    'conversationTitle': 'Fix login',
    'askerName': 'River',
    'question': 'Ship it behind a flag?',
    'options': ['Flag 1 week', 'Everyone'],
    'recommended': 0,
    'createdAt': DateTime.utc(2026, 10, 27, 1, minute).toIso8601String(),
  };

  /// One Swarm whose chat g1 has River (its project's Product Manager) and
  /// Nova (an engineer), reading [page] as its latest messages, with
  /// [decisions] open in it. With [audience], g1 is that person's own chat.
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    Object? next,
    List<Map<String, dynamic>> decisions = const [],
    List<String>? audience,
  }) {
    // The Swarm's counts say a decision waits: what has its list read.
    final derived = {'decisionsWaiting': decisions.length};
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
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            audience: audience,
            lastMessageSequence: page.isEmpty
                ? 0
                : page
                      .map((m) => m['sequence'] as int)
                      .reduce((a, b) => a > b ? a : b),
          ),
        ],
        derived: derived,
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': decisions,
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': page.reversed.toList(),
      'next': next,
    };
    fake.routes[commands] = (_) => {'result': <String, dynamic>{}};
    return fake;
  }

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      // The app's own theme, as the shell sets it: its field defaults are
      // what the composer has to hold back.
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// The message rows built while [act] runs, by message id: a row drawn as
  /// it was is not built at all.
  Future<List<String>> rowsBuilt(Future<void> Function() act) async {
    const prefix = 'swarm-message-';
    final built = <String>[];
    final before = debugOnRebuildDirtyWidget;
    debugOnRebuildDirtyWidget = (element, _) {
      final key = element.widget.key;
      if (key is ValueKey<String> && key.value.startsWith(prefix)) {
        built.add(key.value.substring(prefix.length));
      }
    };
    try {
      await act();
    } finally {
      debugOnRebuildDirtyWidget = before;
    }
    return built;
  }

  String time(int minute) {
    final at = DateTime.utc(2026, 10, 27, 1, minute).toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(at.hour)}:${two(at.minute)}';
  }

  /// [finder] is drawn inside the message list's view.
  bool inView(WidgetTester tester, Finder finder) {
    final list = tester.getRect(key('swarm-messages'));
    final rect = tester.getRect(finder);
    return rect.top >= list.top - 1 && rect.bottom <= list.bottom + 1;
  }

  testWidgets('each message says who wrote it, in what role and when; '
      'follow-ups are grouped under one name', (tester) async {
    await pump(
      tester,
      backend([
        message('m1', 1, author: 'agent-lead', text: 'Plan for today'),
        message(
          'm2',
          2,
          author: 'agent-lead',
          text: 'Then the build',
          minute: 1,
        ),
        message('m3', 3, text: 'On it', minute: 2),
        message('m4', 4, author: me, text: 'Thanks', minute: 3),
      ]),
    );

    expect(find.text('River'), findsOneWidget, reason: 'grouped once');
    expect(find.text('PM'), findsOneWidget);
    expect(find.text('Nova'), findsOneWidget);
    expect(find.text('Dev'), findsOneWidget);
    expect(find.text('tony'), findsOneWidget);
    expect(find.text(time(0)), findsOneWidget);
    expect(find.text(time(1)), findsNothing, reason: 'a follow-up has none');
    expect(find.text(time(2)), findsOneWidget);
    expect(find.text('Then the build'), findsOneWidget);
  });

  testWidgets('no button attaches a file; a file in a message opens', (
    tester,
  ) async {
    // Review of #1802 at bd73842: this test once passed with opening off.
    final opened = <Object?>[];
    const launcher = MethodChannel('plugins.flutter.io/url_launcher');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(launcher, (call) async {
      opened.add((call.arguments as Map)['url']);
      return true;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(launcher, null));
    await pump(
      tester,
      backend([
        message(
          'm1',
          1,
          text: 'Here is the plan',
          attachments: [
            {
              'id': 'f1',
              'name': 'plan.md',
              'mime': 'text/markdown',
              'size': 2048,
              'url': 'https://cdn.harness.autonomous.ai/f1/plan.md',
            },
          ],
        ),
      ]),
    );

    expect(find.textContaining('plan.md'), findsOneWidget);
    expect(find.textContaining('Attach'), findsNothing);
    expect(
      find.byWidgetPredicate(
        (w) =>
            w is Icon &&
            (w.icon == LucideIcons.paperclip ||
                w.icon == LucideIcons.paperclip300 ||
                w.icon == LucideIcons.plus300),
      ),
      findsNothing,
    );

    await tester.tap(find.textContaining('plan.md'));
    await tester.pump();

    expect(opened, ['https://cdn.harness.autonomous.ai/f1/plan.md']);
  });

  testWidgets('a reply quotes its original; tapping the quote brings the '
      'original into view and lights it for a moment', (tester) async {
    await pump(
      tester,
      backend([
        message('m1', 1, author: 'agent-lead', text: 'The very first plan'),
        for (var i = 2; i < 40; i++)
          message('m$i', i, text: 'Line $i\nof the log', minute: i),
        message('m40', 40, author: me, text: 'Yes', replyTo: 'm1', minute: 50),
      ]),
    );
    final original = find.text('The very first plan');
    // Its quote is on screen; the message itself is far up.
    expect(original, findsOneWidget);
    expect(key('swarm-quote-m40'), findsOneWidget);

    await tester.tap(key('swarm-quote-m40'));
    await tester.pumpAndSettle();

    final row = find.descendant(
      of: key('swarm-message-m1'),
      matching: find.text('The very first plan'),
    );
    expect(inView(tester, row), isTrue);
    expect(key('swarm-lit-m1'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(key('swarm-lit-m1'), findsNothing);
  });

  testWidgets('an original further back is read in from earlier pages, then '
      'shown', (tester) async {
    // A first page taller than the screen: nothing earlier is read until
    // the quote asks for it.
    final fake = backend(
      [
        for (var i = 10; i < 40; i++)
          message('m$i', i, text: 'Line $i\nof the log', minute: i),
        message('m40', 40, author: me, text: 'Yes', replyTo: 'm1', minute: 50),
      ],
      next: {'sequence': 10, 'id': 'm10'},
    );
    fake.routes['$messages?before=10&beforeId=m10'] = (_) => {
      'messages': [
        for (var i = 9; i > 1; i--) message('m$i', i, minute: i),
        message('m1', 1, author: 'agent-lead', text: 'The very first plan'),
      ],
      'next': null,
    };
    await pump(tester, fake);
    expect(find.text("The original message isn't loaded."), findsOneWidget);

    await tester.tap(key('swarm-quote-m40'));
    await tester.pumpAndSettle();

    expect(fake.paths, contains('$messages?before=10&beforeId=m10'));
    final row = find.descendant(
      of: key('swarm-message-m1'),
      matching: find.text('The very first plan'),
    );
    expect(inView(tester, row), isTrue);
    expect(key('swarm-lit-m1'), findsOneWidget);
  });

  testWidgets('an original no longer in the chat says so', (tester) async {
    await pump(
      tester,
      backend([message('m2', 2, author: me, text: 'Yes', replyTo: 'm-gone')]),
    );

    await tester.tap(key('swarm-quote-m2'));
    await tester.pumpAndSettle();

    expect(
      find.text('The original message is no longer in this chat.'),
      findsOneWidget,
    );
  });

  testWidgets('Reply: a tap on a message, Reply, a bar over the composer, and '
      'the post answers that message', (tester) async {
    final fake = backend([message('m1', 1, text: 'Which name for the flag?')]);
    await pump(tester, fake);

    await tester.tap(find.text('Which name for the flag?'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-reply-m1'));
    await tester.pumpAndSettle();

    expect(key('swarm-reply-bar'), findsOneWidget);
    expect(find.textContaining('Reply to Nova'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'beta');
    await tester.pump();
    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();

    expect(fake.commands.single['replyTo'], 'm1');
    expect(key('swarm-reply-bar'), findsNothing);
  });

  testWidgets('a reply can be taken back before it is sent', (tester) async {
    final fake = backend([message('m1', 1, text: 'Which name for the flag?')]);
    await pump(tester, fake);
    await tester.tap(find.text('Which name for the flag?'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-reply-m1'));
    await tester.pumpAndSettle();

    await tester.tap(key('swarm-reply-cancel'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'beta');
    await tester.pump();
    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();

    expect(key('swarm-reply-bar'), findsNothing);
    expect(fake.commands.single['replyTo'], isNull);
  });

  testWidgets('the @ picker lists the chat\'s agents with role and state, '
      'narrowed by what is typed', (tester) async {
    await pump(tester, backend([message('m1', 1)]));

    await tester.tap(key('swarm-mention'));
    await tester.pump();
    expect(key('swarm-mention-picker'), findsOneWidget);
    expect(key('swarm-pick-agent-lead'), findsOneWidget);
    expect(key('swarm-pick-agent-builder'), findsOneWidget);
    expect(
      find.descendant(
        of: key('swarm-pick-agent-builder'),
        matching: find.text('Working'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: key('swarm-pick-agent-lead'),
        matching: find.text('PM'),
      ),
      findsOneWidget,
    );

    await tester.enterText(find.byType(TextField), 'ask @no');
    await tester.pump();
    expect(key('swarm-pick-agent-lead'), findsNothing);
    expect(key('swarm-pick-agent-builder'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'ask @zed');
    await tester.pump();
    expect(find.text('No agent by that name.'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'ask @N');
    await tester.pump();
    await tester.tap(key('swarm-pick-agent-builder'));
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'ask @Nova ',
    );
    expect(key('swarm-mention-picker'), findsNothing);
  });

  testWidgets('a post shows at once as Sending…, out of the field, and as '
      'sent once read back', (tester) async {
    final fake = backend([message('m1', 1)]);
    final taken = Completer<Object?>();
    fake.routes[commands] = (_) => taken.future;
    await pump(tester, fake);

    await tester.enterText(find.byType(TextField), 'On it');
    await tester.pump();
    await tester.tap(key('swarm-send'));
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
    );
    expect(key('swarm-pending'), findsOneWidget);
    expect(find.text('Sending…'), findsOneWidget);
    expect(find.text('On it'), findsOneWidget);

    fake.routes['$messages?after=1'] = (_) => {
      'messages': [message('m2', 2, author: me, text: 'On it', minute: 5)],
      'next': null,
    };
    taken.complete({'result': <String, dynamic>{}});
    await tester.pumpAndSettle();

    expect(key('swarm-pending'), findsNothing);
    expect(key('swarm-message-m2'), findsOneWidget);
    expect(find.text('On it'), findsOneWidget);
  });

  testWidgets('a post whose answer was lost says it is not confirmed, and '
      'Send again sends the same post', (tester) async {
    final fake = backend([message('m1', 1)]);
    var lost = true;
    fake.routes[commands] = (_) => lost
        ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
        : {'result': <String, dynamic>{}};
    await pump(tester, fake);

    await tester.enterText(find.byType(TextField), 'On it');
    await tester.pump();
    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();

    expect(find.text('Not confirmed'), findsOneWidget);
    expect(key('swarm-resend-post'), findsOneWidget);

    lost = false;
    await tester.tap(key('swarm-resend-post'));
    await tester.pumpAndSettle();

    final receipts = {
      for (final call in fake.calls)
        if (call.method == 'POST') call.body!['operationId'],
    };
    expect(receipts, hasLength(1));
    expect(find.text('Not confirmed'), findsNothing);
  });

  testWidgets('a refused post says why and puts its text back in the field', (
    tester,
  ) async {
    final fake = backend([message('m1', 1)]);
    fake.routes[commands] = (_) => throw const SuperTabFailure(
      'TOO_LONG',
      'This message is too long.',
      statusCode: 400,
    );
    await pump(tester, fake);

    await tester.enterText(find.byType(TextField), 'On it');
    await tester.pump();
    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();

    expect(find.text('This message is too long.'), findsOneWidget);
    expect(key('swarm-pending'), findsNothing);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'On it',
    );
  });

  testWidgets('the header names the chat, Chat with PM for the person\'s own, '
      'with its project under it', (tester) async {
    await pump(tester, backend([message('m1', 1)]));
    expect(find.text('Fix login'), findsOneWidget);
    expect(find.text('Mobile'), findsOneWidget);

    await pump(tester, backend([message('m1', 1)], audience: [me]));
    expect(find.text('Chat with PM'), findsOneWidget);
    expect(find.text('Fix login'), findsNothing);
  });

  testWidgets('a divider heads each day, Yesterday above Today', (
    tester,
  ) async {
    final now = DateTime.now();
    await pump(
      tester,
      backend([
        message(
          'm1',
          1,
          text: 'From yesterday',
          at: DateTime(now.year, now.month, now.day - 1, 12),
        ),
        message(
          'm2',
          2,
          text: 'From today',
          at: DateTime(now.year, now.month, now.day, 0, 30),
        ),
      ]),
    );

    final yesterday = tester.getTopLeft(find.text('Yesterday')).dy;
    final today = tester.getTopLeft(find.text('Today')).dy;
    expect(
      yesterday,
      lessThan(tester.getTopLeft(find.text('From yesterday')).dy),
    );
    expect(
      today,
      greaterThan(tester.getTopLeft(find.text('From yesterday')).dy),
    );
    expect(today, lessThan(tester.getTopLeft(find.text('From today')).dy));
  });

  testWidgets('a decision sits among the messages where it was asked: a card '
      'with its question, the options side by side', (tester) async {
    await pump(
      tester,
      backend(
        [
          message('m1', 1, text: 'The build is green'),
          message('m2', 2, author: me, text: 'Flag it', minute: 2),
        ],
        decisions: [decision('d1', minute: 1)],
      ),
    );

    final card = tester.getRect(key('swarm-ask-d1'));
    expect(card.top, greaterThan(tester.getRect(key('swarm-message-m1')).top));
    expect(
      card.bottom,
      lessThanOrEqualTo(tester.getRect(key('swarm-message-m2')).top + 1),
    );
    expect(
      find.descendant(of: key('swarm-ask-d1'), matching: find.text('River')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: key('swarm-ask-d1'), matching: find.text('PM')),
      findsOneWidget,
    );
    final first = tester.getRect(key('swarm-option-d1-0'));
    final second = tester.getRect(key('swarm-option-d1-1'));
    expect(first.top, second.top, reason: 'side by side');
    expect(first.right, lessThan(second.left));

    await tester.tap(key('swarm-option-d1-1'));
    await tester.pump();
    expect(find.text('Sending “Everyone”'), findsOneWidget);
    await tester.pump(const Duration(seconds: 10));
    await tester.pumpAndSettle();
  });

  testWidgets('an open decision from before the messages read so far waits at '
      'the foot, not behind Earlier messages', (tester) async {
    await pump(
      tester,
      backend(
        [
          for (var i = 10; i < 34; i++)
            message('m$i', i, text: 'Line $i\nof the log', minute: i),
        ],
        next: {'sequence': 10, 'id': 'm10'},
        decisions: [decision('d1')],
      ),
    );

    expect(
      tester.getRect(key('swarm-ask-d1')).top,
      greaterThan(tester.getRect(key('swarm-message-m33')).top),
    );
  });

  testWidgets('an @mention of one of the Swarm\'s agents is marked', (
    tester,
  ) async {
    await pump(
      tester,
      backend([message('m1', 1, author: me, text: '@Nova and @nobody, a@b.c')]),
    );

    final text = tester.widget<Text>(
      find.descendant(
        of: key('swarm-message-m1'),
        matching: find.text('@Nova and @nobody, a@b.c'),
      ),
    );
    final marked = <String>[];
    text.textSpan!.visitChildren((span) {
      if (span is TextSpan && span.style?.backgroundColor != null) {
        marked.add(span.text!);
      }
      return true;
    });
    expect(marked, ['@Nova']);
  });

  testWidgets('the field is one rounded line until more is typed; Send is a '
      'round arrow that waits for text', (tester) async {
    final fake = backend([message('m1', 1)]);
    await pump(tester, fake);

    expect(find.text('Send'), findsNothing);
    expect(
      find.descendant(
        of: key('swarm-send'),
        matching: find.byIcon(LucideIcons.arrowUp),
      ),
      findsOneWidget,
    );
    final field = find.byType(TextField);
    final oneLine = tester.getSize(field).height;
    expect(oneLine, lessThan(30), reason: 'one line, not a box');

    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();
    expect(fake.commands, isEmpty, reason: 'nothing to send yet');

    await tester.enterText(field, 'one\ntwo\nthree');
    await tester.pump();
    expect(tester.getSize(field).height, greaterThan(oneLine * 2));
  });

  testWidgets('a decision asked just after its asker\'s own message is drawn '
      'as part of it, under one name and time', (tester) async {
    await pump(
      tester,
      backend(
        [
          message(
            'm1',
            1,
            author: 'agent-lead',
            text: 'One question before the release:',
          ),
        ],
        decisions: [decision('d1', minute: 1)],
      ),
    );

    expect(find.text('River'), findsOneWidget);
    expect(find.text(time(1)), findsNothing);
    expect(
      tester.getRect(key('swarm-ask-d1')).top,
      greaterThanOrEqualTo(tester.getRect(key('swarm-message-m1')).bottom - 1),
    );
  });

  testWidgets(
    'on an iPhone the field rests at the 44 of the buttons beside it',
    (tester) async {
      await pump(tester, backend([message('m1', 1)]));

      expect(tester.getSize(key('swarm-field')).height, 44);
      expect(tester.getSize(key('swarm-send')).height, 44);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );

  testWidgets('a post sent from far up the chat brings the chat back to its '
      'foot, where the post shows', (tester) async {
    final fake = backend([
      message('m1', 1, author: 'agent-lead', text: 'The very first plan'),
      for (var i = 2; i < 40; i++)
        message('m$i', i, text: 'Line $i\nof the log', minute: i),
      message('m40', 40, author: me, text: 'Yes', replyTo: 'm1', minute: 50),
    ]);
    fake.routes[commands] = (_) => Completer<Object?>().future;
    await pump(tester, fake);
    await tester.tap(key('swarm-quote-m40'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'On it');
    await tester.pump();
    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();

    expect(inView(tester, key('swarm-pending')), isTrue);
  });

  group('earlier messages', () {
    /// A first page of [count] two-line messages, m[first] onwards, with more
    /// before it.
    FakeSwarm long({int first = 10, int count = 30}) => backend(
      [
        for (var i = first; i < first + count; i++)
          message('m$i', i, text: 'Line $i\nof the log', minute: i % 60),
      ],
      next: {'sequence': first, 'id': 'm$first'},
    );
    final older = '$messages?before=10&beforeId=m10';
    List<Map<String, dynamic>> earlier() => [
      for (var i = 9; i > 0; i--)
        message('m$i', i, text: 'Earlier $i', minute: i),
    ];

    Future<void> nearTop(WidgetTester tester) async {
      // The list runs from the foot: a drag down goes up the chat, here to
      // its top.
      await tester.drag(key('swarm-messages'), const Offset(0, 4000));
      // Past the bounce at the edge.
      await tester.pumpAndSettle();
    }

    testWidgets('are read on their own near the top, with no tap, and what '
        'is read stays where it is', (tester) async {
      final fake = long();
      final page = Completer<Object?>();
      fake.routes[older] = (_) => page.future;
      await pump(tester, fake);
      expect(fake.paths, isNot(contains(older)), reason: 'not at the top yet');

      await nearTop(tester);
      expect(fake.paths, contains(older));
      expect(key('swarm-older-loading'), findsOneWidget);
      expect(key('swarm-older-messages'), findsNothing);
      final reading = find.text('Line 12\nof the log');
      final before = tester.getRect(reading).top;

      page.complete({'messages': earlier(), 'next': null});
      await tester.pumpAndSettle();

      expect(tester.getRect(reading).top, moreOrLessEquals(before, epsilon: 1));
      expect(key('swarm-message-m9'), findsOneWidget);
      expect(key('swarm-older-loading'), findsNothing);
    });

    testWidgets('that fail to load offer Earlier messages, which reads them '
        'again', (tester) async {
      final fake = long();
      var down = true;
      fake.routes[older] = (_) => down
          ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
          : {'messages': earlier(), 'next': null};
      await pump(tester, fake);

      await nearTop(tester);
      await tester.pumpAndSettle();
      expect(key('swarm-older-messages'), findsOneWidget);
      final reads = fake.paths.where((p) => p == older).length;

      // Not read over and over on its own while it fails.
      await tester.drag(key('swarm-messages'), const Offset(0, -100));
      await nearTop(tester);
      await tester.pumpAndSettle();
      expect(fake.paths.where((p) => p == older), hasLength(reads));

      down = false;
      await tester.tap(key('swarm-older-messages'));
      await tester.pumpAndSettle();
      expect(key('swarm-message-m9'), findsOneWidget);
      expect(key('swarm-older-messages'), findsNothing);
    });

    testWidgets('a first page shorter than the screen reads the one before '
        'it at once', (tester) async {
      final fake = long(count: 2);
      fake.routes[older] = (_) => {'messages': earlier(), 'next': null};
      await pump(tester, fake);

      expect(fake.paths, contains(older));
      expect(find.text('Earlier 9'), findsOneWidget);
    });

    testWidgets('a read that brings nothing new is not read again on its own', (
      tester,
    ) async {
      final fake = long(count: 2);
      fake.routes[older] = (_) => {
        'messages': <Object>[],
        'next': {'sequence': 10, 'id': 'm10'},
      };
      await pump(tester, fake);

      expect(fake.paths.where((p) => p == older), hasLength(1));
      expect(key('swarm-older-messages'), findsOneWidget);
    });
  });

  testWidgets('a Product Manager\'s avatar is the prototype\'s blue; another '
      'agent\'s is not', (tester) async {
    await pump(
      tester,
      backend([
        message('m1', 1, author: 'agent-lead', text: 'Plan'),
        message('m2', 2, text: 'On it?', minute: 1),
      ]),
    );

    Color fill(String id) {
      final avatar = find.descendant(
        of: key('swarm-message-$id'),
        matching: find.byWidgetPredicate(
          (w) =>
              w is Container &&
              w.decoration is BoxDecoration &&
              (w.decoration! as BoxDecoration).shape == BoxShape.circle,
        ),
      );
      return ((tester.widget<Container>(avatar.first).decoration!
              as BoxDecoration)
          .color)!;
    }

    expect(fill('m1'), const Color(0xFF1D5BD6));
    expect(fill('m2'), isNot(const Color(0xFF1D5BD6)));
  });

  // Tony's iPhone 14, Profile, 44d284f65: the whole chat was built again on
  // each keystroke, and in 25 ms mid-scroll when the 5 s read answered.
  group('drawn again', () {
    List<Map<String, dynamic>> page() => [
      message('m1', 1, author: 'agent-lead', text: 'The plan'),
      message('m2', 2, text: 'On it @River', minute: 1),
      message('m3', 3, author: me, text: 'Thanks', replyTo: 'm1', minute: 2),
    ];

    testWidgets('a keystroke: the composer, and no message', (tester) async {
      final fake = backend(page());
      fake.routes[commands] = (_) => Completer<Object?>().future;
      await pump(tester, fake);

      final built = await rowsBuilt(() async {
        await tester.enterText(find.byType(TextField), 'S');
        await tester.pump();
        await tester.enterText(find.byType(TextField), 'Sh');
        await tester.pump();
      });

      expect(built, isEmpty);
      // The composer did follow the typing: Send posts what was typed.
      await tester.tap(key('swarm-send'));
      await tester.pump();
      expect(
        find.descendant(of: key('swarm-pending'), matching: find.text('Sh')),
        findsOneWidget,
      );
    });

    testWidgets('a read of the Swarm that changes nothing in this chat: no '
        'message', (tester) async {
      final fake = backend(page());
      final host = await pump(tester, fake);
      // The Lead's chat moved on: the Swarm, its asks and the inbox all
      // say so, and nothing this chat draws changed.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        lastChangedAt: 200,
        derived: {'decisionsWaiting': 0},
        groups: [
          part(
            leadChat,
            9,
            groupData(
              leadChat,
              title: 'Mobile',
              agentIds: ['agent-lead'],
              leadId: 'agent-lead',
              status: 'working',
            ),
          ),
        ],
      );

      final built = await rowsBuilt(() async {
        await host.session!.inbox.reader(tab)!.refresh();
        await tester.pumpAndSettle();
      });

      expect(built, isEmpty);
      expect(find.text('On it @River'), findsOneWidget);
    });
  });

  group('a day divider says', () {
    final now = DateTime(2026, 10, 27, 9, 30);

    test('Today and Yesterday, whatever the hour', () {
      expect(swarmDayLabel(DateTime(2026, 10, 27, 0, 1), now), 'Today');
      expect(swarmDayLabel(DateTime(2026, 10, 27, 23, 59), now), 'Today');
      expect(swarmDayLabel(DateTime(2026, 10, 26, 23, 59), now), 'Yesterday');
    });

    test('the weekday within the week, then the date', () {
      expect(swarmDayLabel(DateTime(2026, 10, 25), now), 'Sunday');
      expect(swarmDayLabel(DateTime(2026, 10, 21), now), 'Wednesday');
      expect(swarmDayLabel(DateTime(2026, 10, 20), now), '20 Oct');
      expect(swarmDayLabel(DateTime(2025, 12, 31), now), '31 Dec 2025');
    });

    test('a day across a clock change is still one day', () {
      // 25 March 2029 is 23 hours long where the clocks go forward then.
      expect(
        swarmDayLabel(DateTime(2029, 3, 25, 12), DateTime(2029, 3, 26, 1)),
        'Yesterday',
      );
    });

    test('a date ahead of the phone\'s clock is a date', () {
      expect(swarmDayLabel(DateTime(2026, 10, 28), now), '28 Oct');
    });
  });
}
