import 'dart:async';
import 'dart:math' as math;

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart' show XFile;
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_chat_cache.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../theme/sheet_shape.dart';
import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A Swarm chat on the phone, as Tony's prototype has it: who wrote each
/// message and in what role, follow-ups grouped, a reply's quote that brings
/// its original into view, Reply, the @ picker, files attached from the photo
/// library, the camera or Files, and a post that shows at once and says when it
/// is not confirmed.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String text = 'hello',
    String author = 'agent-builder',
    String? replyTo,
    String? thread,
    bool alsoInChat = false,
    int minute = 0,
    DateTime? at,
    List<Map<String, dynamic>> attachments = const [],
    Map<String, List<(String, String)>> reactions = const {},
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'replyTo': ?replyTo,
    'thread': ?thread,
    if (alsoInChat) 'alsoInChat': true,
    'author': author == me
        ? {'kind': 'person', 'id': me, 'name': 'tony'}
        : {
            'kind': 'agent',
            'id': author,
            'name': author == 'agent-lead' ? 'River' : 'Nova',
          },
    'attachments': attachments,
    'reactions': [
      for (final MapEntry(key: emoji, value: by) in reactions.entries)
        {
          'emoji': emoji,
          'count': by.length,
          'by': [
            for (final (kind, who) in by) {'kind': kind, 'id': who},
          ],
        },
    ],
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
  /// Nova (an engineer), reading [page] as its latest messages with the lines
  /// of [threads], with [decisions] open in it. With [audience], g1 is that
  /// person's own chat.
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    Object? next,
    List<Map<String, dynamic>> threads = const [],
    List<Map<String, dynamic>> decisions = const [],
    List<String>? audience,
    List<Map<String, dynamic>>? members,
    List<Map<String, dynamic>>? projects,
    Map<String, dynamic> g1 = const {},
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
        head: projects == null ? null : headData(projects: projects),
        groups: [
          {
            ...groupData(
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
            ...g1,
          },
        ],
        derived: derived,
      ),
      'members': [
        for (final member in members ?? [person(me)])
          part(member['id'] as String, 1, member),
      ],
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
      'threads': threads,
    };
    fake.routes[commands] = (_) => {'result': <String, dynamic>{}};
    return fake;
  }

  /// Who is signed in, and Settings ▸ Experimental, of the last [pump].
  late ValueNotifier<String?> account;
  late ExperimentalFeaturesStore features;

  /// A few frames, for reads answered at once to land, never settling: a
  /// skeleton breathes for as long as it shows.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump();
    }
  }

  /// Chat [conversation] of [host]'s Swarm on screen.
  Future<void> show(
    WidgetTester tester,
    SwarmHost host, {
    String swarmId = tab,
    String conversation = 'g1',
    String? messageId,
    String? decisionId,
    bool settle = true,
    bool homeC = false,
  }) async {
    await tester.pumpWidget(
      // The app's own theme, as the shell sets it: its field defaults are
      // what the composer has to hold back.
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmConversationPage(
          swarmId: swarmId,
          conversationId: conversation,
          messageId: messageId,
          decisionId: decisionId,
          homeC: homeC,
        ),
      ),
    );
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      await frames(tester);
    }
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    String swarmId = tab,
    String conversation = 'g1',
    String? messageId,
    String? decisionId,
    bool settle = true,
    bool homeC = false,
    SwarmUpload upload = refuseSwarmUpload,
  }) async {
    features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: upload,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await show(
      tester,
      host,
      swarmId: swarmId,
      conversation: conversation,
      settle: settle,
      messageId: messageId,
      decisionId: decisionId,
      homeC: homeC,
    );
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// The message rows built while [act] runs, by message id: a row drawn as
  /// it was is not built at all.
  Future<List<String>> rowsBuilt(Future<void> Function() act) async {
    final built = <String>[];
    final before = debugOnRebuildDirtyWidget;
    debugOnRebuildDirtyWidget = (element, _) {
      if (element.widget case SwarmMessageRow(:final message)) {
        built.add(message.id);
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

  /// Whether the composer holds the keyboard: its field focused, and the
  /// keyboard shown.
  ({bool focused, bool keyboard}) composer(WidgetTester tester) => (
    focused: tester
        .widget<TextField>(find.byType(TextField))
        .focusNode!
        .hasFocus,
    keyboard: tester.testTextInput.isVisible,
  );
  const up = (focused: true, keyboard: true);
  const down = (focused: false, keyboard: false);

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

  // Scholes, 10-29: his Buddy's "waiting at a prompt" line stayed after the
  // prompt was answered, and a new one came under every message after it.
  testWidgets('a prompt warning shows once, while its agent still waits, '
      'and goes once it is answered', (tester) async {
    Map<String, dynamic> alert(String id, int sequence, String kind) => {
      ...message(
        id,
        sequence,
        text: kind == 'prompt'
            ? 'Nova is waiting at a prompt in its terminal.'
            : 'Nova hit a usage limit. Routing skips it until 15:00 UTC.',
        minute: sequence,
      ),
      'source': {
        'kind': 'terminal-alert',
        'agentId': 'agent-builder',
        'alert': kind,
      },
    };
    Map<String, dynamic> nova(List<String> alerting) => {
      ...agent('agent-builder', displayName: 'Nova'),
      'alerting': alerting,
    };
    final fake = backend([
      alert('a1', 1, 'prompt'),
      message('m2', 2, text: 'Here is what I found', minute: 2),
      alert('a3', 3, 'limit'),
      alert('a4', 4, 'prompt'),
    ]);
    final parts = fake.routes['/api/super-tabs/$tab/parts']!;
    fake.routes['/api/super-tabs/$tab/parts'] = (body) async => {
      ...(await parts(body))! as Map<String, dynamic>,
      'agents': [
        part(
          'agent-lead',
          1,
          agent('agent-lead', name: 'Lead', displayName: 'River'),
        ),
        part('agent-builder', 1, nova(['prompt'])),
      ],
    };
    final host = await pump(tester, fake);

    // Still waiting: only the newest warning, and the usage limit's own note.
    expect(key('swarm-message-a1'), findsNothing);
    expect(key('swarm-message-a4'), findsOneWidget);
    expect(key('swarm-message-a3'), findsOneWidget);

    // Answered: the backend clears the agent's alert, and its warning goes.
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
      ...changes(cursor: 'c3', lastChangedAt: 200),
      'agents': [part('agent-builder', 2, nova([]))],
    };
    await host.session!.inbox.reader(tab)!.refresh();
    await tester.pumpAndSettle();
    expect(key('swarm-message-a4'), findsNothing);
    expect(key('swarm-message-a1'), findsNothing);
    expect(key('swarm-message-a3'), findsOneWidget);
    expect(find.text('Here is what I found'), findsOneWidget);
  });

  testWidgets('a file in a message opens', (tester) async {
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

    await tester.tap(find.textContaining('plan.md'));
    await tester.pump();

    expect(opened, ['https://cdn.harness.autonomous.ai/f1/plan.md']);
  });

  testWidgets('a notification opens an earlier message and highlights it', (
    tester,
  ) async {
    await pump(
      tester,
      backend([
        for (var i = 1; i <= 40; i++)
          message('m$i', i, text: 'Message $i\nMore text', minute: i),
      ]),
      messageId: 'm1',
    );
    expect(key('swarm-lit-m1'), findsOneWidget);
    expect(inView(tester, find.text('Message 1\nMore text')), isTrue);
  });

  testWidgets('opened at an earlier message, the chat is read only once the '
      'person goes down to its newest', (tester) async {
    final fake = backend([
      for (var i = 1; i <= 40; i++)
        message('m$i', i, text: 'Message $i\nMore text', minute: i),
    ]);
    List<Object?> marksSent() => [
      for (final call in fake.calls)
        if (call.method == 'POST' &&
            call.path == '/api/super-tabs/$tab/conversations/g1/read')
          call.body?['sequence'],
    ];
    await pump(tester, fake, messageId: 'm1');
    expect(inView(tester, find.text('Message 1\nMore text')), isTrue);

    expect(marksSent(), everyElement(lessThanOrEqualTo(1)));

    for (var i = 0; i < 10; i++) {
      await tester.drag(key('swarm-messages'), const Offset(0, -2000));
      await tester.pumpAndSettle();
    }

    expect(inView(tester, find.text('Message 40\nMore text')), isTrue);
    expect(marksSent().last, 40);
  });

  testWidgets(
    'following a quote after a decision notification changes the target',
    (tester) async {
      await pump(
        tester,
        backend(
          [
            message('m1', 1, text: 'Original plan'),
            message('m2', 2, text: 'Follow up', replyTo: 'm1', minute: 1),
          ],
          decisions: [decision('d1')],
        ),
        decisionId: 'd1',
      );
      await tester.tap(key('swarm-quote-m2'));
      await tester.pumpAndSettle();
      expect(key('swarm-lit-m1'), findsOneWidget);
    },
  );

  testWidgets('a notification brings its decision card into view', (
    tester,
  ) async {
    await pump(
      tester,
      backend(
        [
          for (var i = 1; i <= 40; i++)
            message('m$i', i, text: 'Message $i\nMore text', minute: i),
        ],
        decisions: [decision('d1')],
      ),
      decisionId: 'd1',
    );
    expect(inView(tester, find.text('Ship it behind a flag?')), isTrue);
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

  testWidgets('the composer has no @ button: an @ typed in the field opens '
      'the picker', (tester) async {
    await pump(tester, backend([message('m1', 1)]));

    expect(key('swarm-attach'), findsOneWidget);
    expect(key('swarm-field'), findsOneWidget);
    expect(key('swarm-send'), findsOneWidget);
    expect(key('swarm-mention'), findsNothing);
    expect(find.byIcon(LucideIcons.atSign), findsNothing);

    await tester.enterText(find.byType(TextField), '@');
    await tester.pump();
    expect(key('swarm-mention-picker'), findsOneWidget);
    expect(key('swarm-pick-agent-lead'), findsOneWidget);
    expect(key('swarm-pick-agent-builder'), findsOneWidget);
  });

  testWidgets('the @ picker lists the chat\'s agents with role and state, '
      'narrowed by what is typed', (tester) async {
    await pump(tester, backend([message('m1', 1)]));

    await tester.enterText(find.byType(TextField), '@');
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
    expect(find.text('No one by that name.'), findsOneWidget);

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

  group('@ people, by username, as Desktop tags them', () {
    // Ken chose a username; Dee keeps the default her email makes.
    final ken = {...person('ken', role: 'collaborator'), 'username': 'kenji'};
    final dee = person('dee', role: 'collaborator');
    final everyone = [person(me), ken, dee];
    String field(WidgetTester tester) =>
        tester.widget<TextField>(find.byType(TextField)).controller!.text;
    Future<void> type(WidgetTester tester, String text) async {
      await tester.enterText(find.byType(TextField), text);
      await tester.pump();
    }

    testWidgets('@ lists the people who read the chat by username, before '
        'its agents, never the reader; what follows narrows it', (
      tester,
    ) async {
      await pump(tester, backend([message('m1', 1)], members: everyone));

      await type(tester, '@');
      expect(key('swarm-pick-person-ken'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-pick-person-ken'),
          matching: find.text('kenji'),
        ),
        findsOneWidget,
      );
      expect(key('swarm-pick-person-dee'), findsOneWidget);
      expect(key('swarm-pick-person-$me'), findsNothing);
      expect(
        tester.getTopLeft(key('swarm-pick-person-dee')).dy,
        lessThan(tester.getTopLeft(key('swarm-pick-agent-lead')).dy),
      );

      // Any part of the username, as on Desktop.
      await type(tester, 'ask @enj');
      expect(key('swarm-pick-person-ken'), findsOneWidget);
      expect(key('swarm-pick-person-dee'), findsNothing);
      expect(key('swarm-pick-agent-builder'), findsNothing);

      await type(tester, 'ask @zed');
      expect(find.text('No one by that name.'), findsOneWidget);
    });

    testWidgets('a picked person goes in as @username, and the post tags '
        'them beside the agents it goes to, as Desktop sends it', (
      tester,
    ) async {
      final fake = backend([message('m1', 1)], members: everyone);
      await pump(tester, fake);

      await type(tester, 'ask @ke');
      await tester.tap(key('swarm-pick-person-ken'));
      await tester.pump();
      expect(field(tester), 'ask @kenji ');
      expect(key('swarm-mention-picker'), findsNothing);

      await type(tester, 'ask @kenji and @N');
      await tester.tap(key('swarm-pick-agent-builder'));
      await tester.pump();
      expect(field(tester), 'ask @kenji and @Nova ');

      await type(tester, 'ask @kenji and @Nova to look');
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'message.send',
        'conversationId': 'g1',
        'text': 'ask @kenji and @Nova to look',
        'replyTo': null,
        'recipientIds': ['agent-builder'],
        'mentions': ['ken'],
      });
    });

    testWidgets('a username taken out of the draft tags nobody', (
      tester,
    ) async {
      final fake = backend([message('m1', 1)], members: everyone);
      await pump(tester, fake);

      await type(tester, '@ke');
      await tester.tap(key('swarm-pick-person-ken'));
      await tester.pump();
      await type(tester, 'ask him later');
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();

      expect(fake.commands.single.containsKey('mentions'), isFalse);
      expect(fake.commands.single['recipientIds'], <String>[]);
    });

    testWidgets('a refused tag puts the post back in the draft with the '
        'backend\'s words, and the tag stays with it', (tester) async {
      final fake = backend([message('m1', 1)], members: everyone);
      var refuse = true;
      fake.routes[commands] = (_) => refuse
          ? throw const SuperTabFailure(
              'INVALID_MENTION',
              'kenji cannot read this conversation.',
              statusCode: 400,
            )
          : {'result': <String, dynamic>{}};
      await pump(tester, fake);

      await type(tester, '@ke');
      await tester.tap(key('swarm-pick-person-ken'));
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();

      expect(field(tester), '@kenji ');
      expect(find.text('kenji cannot read this conversation.'), findsOneWidget);

      refuse = false;
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      expect(fake.commands.last['mentions'], ['ken']);
    });

    testWidgets('a private chat offers only its own people', (tester) async {
      await pump(
        tester,
        backend([message('m1', 1)], members: everyone, audience: [me, 'dee']),
      );

      await type(tester, '@');
      expect(key('swarm-pick-person-dee'), findsOneWidget);
      expect(key('swarm-pick-person-ken'), findsNothing);
      expect(find.text('kenji'), findsNothing);
    });

    testWidgets('a private project offers its owner and members alone', (
      tester,
    ) async {
      await pump(
        tester,
        backend(
          [message('m1', 1)],
          members: everyone,
          projects: [
            {
              'id': project,
              'name': 'Mobile',
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'private',
              'members': [
                {'id': 'dee', 'generation': 'gen-dee'},
              ],
              'updateMinutes': 5,
            },
          ],
        ),
      );

      await type(tester, '@');
      expect(key('swarm-pick-person-dee'), findsOneWidget);
      expect(key('swarm-pick-person-ken'), findsNothing);
    });

    testWidgets('a private project offers its members at the membership '
        'they were added in: someone who left and rejoined is not offered', (
      tester,
    ) async {
      final fake = backend(
        [message('m1', 1)],
        members: everyone,
        projects: [
          {
            'id': project,
            'name': 'Mobile',
            'ownerId': me,
            'leadConversationId': leadChat,
            'visibility': 'private',
            'members': [
              {'id': 'dee', 'generation': 'gen-dee'},
            ],
          },
        ],
      );
      final host = await pump(tester, fake);
      await type(tester, '@');
      expect(key('swarm-pick-person-dee'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3', lastChangedAt: 200),
        'members': [
          part('dee', 2, {
            ...dee,
            'generation': 'rejoined-dee',
            'username': 'new-dee',
          }),
        ],
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pump();

      expect(
        key('swarm-pick-person-dee'),
        findsNothing,
        reason: 'the project holds their old membership, not this one',
      );
      expect(find.text('new-dee'), findsNothing);
    });

    testWidgets('a Buddy chat and the Leads conversation offer no people', (
      tester,
    ) async {
      for (final kind in [
        {'kind': 'buddy', 'buddyOwnerId': me},
        {'kind': 'leads'},
      ]) {
        await pump(
          tester,
          backend([message('m1', 1)], members: everyone, g1: kind),
        );
        await type(tester, '@');
        expect(key('swarm-pick-person-ken'), findsNothing, reason: '$kind');
        expect(key('swarm-pick-person-dee'), findsNothing, reason: '$kind');
        expect(find.text('kenji'), findsNothing, reason: '$kind');
      }
    });

    testWidgets('an agent of the same name in another project is never '
        'offered', (tester) async {
      final fake = backend([message('m1', 1)], members: everyone);
      final full = fake.routes['/api/super-tabs/$tab/parts']!(null)! as Map;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...full,
        'agents': [
          ...full['agents'] as List,
          part('agent-other', 1, {
            ...agent('agent-other', displayName: 'Nova'),
            'projectId': 'project-2',
          }),
        ],
      };
      await pump(tester, fake);

      await type(tester, '@N');
      expect(key('swarm-pick-agent-builder'), findsOneWidget);
      expect(key('swarm-pick-agent-other'), findsNothing);
    });

    testWidgets('losing the Swarm with the @ list open leaves no name on '
        'screen', (tester) async {
      final fake = backend([message('m1', 1)], members: everyone);
      final host = await pump(tester, fake);
      await type(tester, '@');
      expect(find.text('kenji'), findsOneWidget);

      const refused = SuperTabFailure(
        'FORBIDDEN',
        'Not yours.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(key('swarm-mention-picker'), findsNothing);
      for (final name in ['kenji', 'dee', 'River', 'Nova']) {
        expect(find.textContaining(name), findsNothing, reason: name);
      }
    });

    testWidgets('someone who leaves the Swarm leaves the list, and a tag of '
        'them in the draft is not sent', (tester) async {
      final fake = backend([message('m1', 1)], members: everyone);
      final host = await pump(tester, fake);

      await type(tester, '@ke');
      await tester.tap(key('swarm-pick-person-ken'));
      await tester.pump();
      await type(tester, '@kenji and @');
      expect(key('swarm-pick-person-ken'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3', lastChangedAt: 200),
        'members': [
          {'key': 'ken', 'version': 2, 'changedAt': 2, 'deleted': true},
        ],
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pump();
      expect(key('swarm-pick-person-ken'), findsNothing);
      expect(key('swarm-pick-person-dee'), findsOneWidget);

      await type(tester, '@kenji hello');
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      expect(fake.commands.single.containsKey('mentions'), isFalse);
    });
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
    // Under the message, as Slack shows it, not beside the name.
    expect(
      tester.getTopLeft(find.text('Sending…')).dy,
      greaterThan(tester.getBottomLeft(find.text('On it')).dy),
    );

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

  testWidgets('a post lost to an unknown failure says to Retry, the word '
      'under it', (tester) async {
    final fake = backend([message('m1', 1)]);
    fake.routes[commands] = (_) => throw StateError('socket closed');
    await pump(tester, fake);

    await tester.enterText(find.byType(TextField), 'On it');
    await tester.pump();
    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();

    expect(find.text('Not sent'), findsOneWidget);
    expect(
      find.text('Your message was not sent. Retry to check it.'),
      findsOneWidget,
    );
  });

  testWidgets('a post whose answer was lost reads Not sent under it, and '
      'Retry sends the same post', (tester) async {
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

    expect(find.text('Not sent'), findsOneWidget);
    expect(find.text('Not confirmed'), findsNothing);
    expect(
      tester.getTopLeft(find.text('Not sent')).dy,
      greaterThan(tester.getBottomLeft(find.text('On it')).dy),
    );
    expect(
      find.descendant(
        of: key('swarm-resend-post'),
        matching: find.text('Retry'),
      ),
      findsOneWidget,
    );
    expect(
      tester.getSize(key('swarm-resend-post')).height,
      greaterThanOrEqualTo(44),
    );

    lost = false;
    await tester.tap(key('swarm-resend-post'));
    await tester.pumpAndSettle();

    // The posts sent, not the chat's read marks.
    final receipts = {
      for (final call in fake.calls)
        if (call.method == 'POST' && call.path == commands)
          call.body!['operationId'],
    };
    expect(receipts, hasLength(1));
    expect(find.text('Not sent'), findsNothing);
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

  group('the keyboard', () {
    testWidgets('stays up while a post is on its way and goes down once it '
        'is taken', (tester) async {
      final fake = backend([message('m1', 1)]);
      final taken = Completer<Object?>();
      fake.routes[commands] = (_) => taken.future;
      await pump(tester, fake);

      await tester.enterText(find.byType(TextField), 'On it');
      await tester.pump();
      expect(composer(tester), up);

      await tester.tap(key('swarm-send'));
      await tester.pump();
      expect(composer(tester), up);

      fake.routes['$messages?after=1'] = (_) => {
        'messages': [message('m2', 2, author: me, text: 'On it', minute: 5)],
        'next': null,
      };
      taken.complete({'result': <String, dynamic>{}});
      await tester.pumpAndSettle();

      expect(key('swarm-message-m2'), findsOneWidget);
      expect(composer(tester), down);
    });

    testWidgets('stays up for a refused post, to correct it and send again', (
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
      expect(composer(tester), up);
    });

    testWidgets('stays up for a post not confirmed, and goes down once Send '
        'again is taken', (tester) async {
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

      expect(find.text('Not sent'), findsOneWidget);
      expect(composer(tester), up);

      lost = false;
      await tester.tap(key('swarm-resend-post'));
      await tester.pumpAndSettle();

      expect(find.text('Not sent'), findsNothing);
      expect(composer(tester), down);
    });

    testWidgets('stays up when the next message is typed before the post is '
        'taken', (tester) async {
      final fake = backend([message('m1', 1)]);
      final taken = Completer<Object?>();
      fake.routes[commands] = (_) => taken.future;
      await pump(tester, fake);

      await tester.enterText(find.byType(TextField), 'On it');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'And the');
      await tester.pump();

      taken.complete({'result': <String, dynamic>{}});
      await tester.pumpAndSettle();

      expect(composer(tester), up);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'And the',
      );
    });
  });

  testWidgets('the header names the chat, with its project under it; an old '
      'private chat is no Chat with PM any more (#2090)', (tester) async {
    await pump(tester, backend([message('m1', 1)]));
    expect(find.text('Fix login'), findsOneWidget);
    expect(find.text('Mobile'), findsOneWidget);

    await pump(tester, backend([message('m1', 1)], audience: [me]));
    expect(find.text('Chat with PM'), findsNothing);
    expect(find.text('Fix login'), findsOneWidget);
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
      // Past the stretch at the edge, pumped as a settle would be but not
      // settled: the earlier messages being read breathe as skeletons
      // meanwhile.
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    testWidgets('are read behind skeleton bubbles, not a line of text', (
      tester,
    ) async {
      final fake = long();
      final page = Completer<Object?>();
      fake.routes[older] = (_) => page.future;
      await pump(tester, fake);

      await nearTop(tester);

      expect(
        find.descendant(
          of: key('swarm-older-loading'),
          matching: key('swarm-skeleton-bubble'),
        ),
        findsWidgets,
      );
      expect(find.text('Loading earlier messages…'), findsNothing);
      page.complete({'messages': earlier(), 'next': null});
      await tester.pumpAndSettle();
      expect(key('swarm-older-loading'), findsNothing);
    });

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
  group('reactions', () {
    late List<String> haptics;

    setUp(() {
      haptics = [];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
            if (call.method == 'HapticFeedback.vibrate') {
              haptics.add(call.arguments as String? ?? call.method);
            }
            return null;
          });
    });
    tearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );

    testWidgets('a long-press on a message opens the six with a light tap; '
        'the pick counts under it at once and goes to the backend', (
      tester,
    ) async {
      final fake = backend([message('m1', 1, text: 'Plan')]);
      final sent = Completer<Object?>();
      fake.routes[commands] = (_) => sent.future;
      fake.routes['$messages?before=2'] = (_) => {
        'messages': [
          message(
            'm1',
            1,
            text: 'Plan',
            reactions: {
              'tada': [('person', me)],
            },
          ),
        ],
        'next': null,
        'reactionSeq': 1,
      };
      await pump(tester, fake);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      expect(haptics, ['HapticFeedbackType.lightImpact']);
      await tester.tap(key('swarm-react-tada'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'message.react',
        'conversationId': 'g1',
        'messageId': 'm1',
        'emoji': 'tada',
        'on': true,
      });
      expect(
        find.descendant(
          of: key('swarm-reaction-m1-tada'),
          matching: find.text('1'),
        ),
        findsOneWidget,
        reason: 'counted before the backend answers',
      );
      sent.complete({'result': <String, dynamic>{}});
      await tester.pumpAndSettle();
      expect(key('swarm-reaction-m1-tada'), findsOneWidget);
    });

    testWidgets('a tap on your own count takes it back', (tester) async {
      final fake = backend([
        message(
          'm1',
          1,
          reactions: {
            'heart': [('person', me), ('agent', 'agent-lead')],
          },
        ),
      ]);
      fake.routes['$messages?before=2'] = (_) => {
        'messages': [
          message(
            'm1',
            1,
            reactions: {
              'heart': [('agent', 'agent-lead')],
            },
          ),
        ],
        'next': null,
        'reactionSeq': 2,
      };
      await pump(tester, fake);

      await tester.tap(key('swarm-reaction-m1-heart'));
      await tester.pumpAndSettle();

      expect(fake.commands.single['on'], isFalse);
      expect(
        find.descendant(
          of: key('swarm-reaction-m1-heart'),
          matching: find.text('1'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('holding a count names who gave it, never by email', (
      tester,
    ) async {
      await pump(
        tester,
        backend(
          [
            message(
              'm1',
              1,
              reactions: {
                'eyes': [
                  ('agent', 'agent-lead'),
                  ('person', 'person-ann'),
                  ('person', me),
                ],
              },
            ),
          ],
          members: [
            person(me),
            person('person-ann', role: 'collaborator'),
          ],
        ),
      );

      await tester.longPress(key('swarm-reaction-m1-eyes'));
      await tester.pump();

      expect(find.text('River, person-ann and You'), findsOneWidget);
      expect(find.textContaining('@example.com'), findsNothing);
      expect(key('swarm-react-eyes'), findsNothing, reason: 'no picker');
      await tester.pumpAndSettle(const Duration(seconds: 3));
    });

    testWidgets('a person who cannot post sees the counts; neither a tap nor '
        'a long-press reacts', (tester) async {
      final fake = backend(
        [
          message(
            'm1',
            1,
            text: 'Plan',
            reactions: {
              'rocket': [('agent', 'agent-lead')],
            },
          ),
        ],
        members: [person(me, role: 'viewer')],
      );
      await pump(tester, fake);

      await tester.tap(key('swarm-reaction-m1-rocket'));
      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();

      expect(key('swarm-reaction-m1-rocket'), findsOneWidget);
      expect(key('swarm-react-rocket'), findsNothing);
      expect(fake.commands, isEmpty);
    });
  });

  group('Copy link to message', () {
    late List<String> copied;

    setUp(() {
      copied = [];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
            if (call.method == 'Clipboard.setData') {
              copied.add((call.arguments as Map)['text'] as String);
            }
            return null;
          });
    });
    tearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );

    testWidgets('the long-press sheet copies the link Desktop copies, and '
        'says so', (tester) async {
      final fake = backend([message('m1', 1, text: 'Plan')]);
      await pump(tester, fake);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      expect(key('swarm-react-tada'), findsOneWidget);
      await tester.tap(key('swarm-copy-link'));
      await tester.pumpAndSettle();

      expect(copied, ['harness://swarm/$tab/g1/m1']);
      expect(key('swarm-copy-link'), findsNothing, reason: 'sheet closed');
      expect(find.text('Link copied'), findsOneWidget);
      expect(fake.commands, isEmpty);
    });

    testWidgets('the Add reaction chip opens the reactions alone: Copy link '
        'is the long-press sheet\'s', (tester) async {
      final fake = backend([
        message(
          'm1',
          1,
          text: 'Plan',
          reactions: {
            'eyes': [('agent', 'agent-lead')],
          },
        ),
      ]);
      await pump(tester, fake, homeC: true);

      await tester.tap(key('swarm-add-reaction-m1'));
      await tester.pumpAndSettle();
      expect(key('swarm-react-tada'), findsOneWidget);
      expect(key('swarm-copy-link'), findsNothing);
      await tester.tap(key('swarm-react-tada'));
      await tester.pumpAndSettle();

      expect(copied, isEmpty);
      expect(fake.commands.where((c) => c['type'] == 'message.react'), [
        {
          'type': 'message.react',
          'conversationId': 'g1',
          'messageId': 'm1',
          'emoji': 'tada',
          'on': true,
        },
      ]);
    });

    testWidgets('a person who cannot post still copies the link; the sheet '
        'offers no reactions', (tester) async {
      final fake = backend(
        [message('m1', 1, text: 'Plan')],
        members: [person(me, role: 'viewer')],
      );
      await pump(tester, fake);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      expect(key('swarm-react-tada'), findsNothing);
      await tester.tap(key('swarm-copy-link'));
      await tester.pumpAndSettle();

      expect(copied, ['harness://swarm/$tab/g1/m1']);
      expect(fake.commands, isEmpty);
    });

    testWidgets('a reply in a thread copies its own link: its id alone '
        'places it', (tester) async {
      final fake = backend(
        [
          message('m1', 1, author: 'agent-lead', text: 'Root', thread: 'm1'),
          message('m2', 2, text: 'In thread', thread: 'm1', replyTo: 'm1'),
        ],
        threads: [
          {
            'id': 'm1',
            'replies': 1,
            'lastSequence': 2,
            'lastAt': DateTime.utc(2026, 10, 27, 1, 2).toIso8601String(),
            'authors': [
              {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
            ],
            'people': <String>[],
          },
        ],
      );
      fake.routes['$messages?thread=m1'] = (_) => {
        'messages': [
          message('m2', 2, text: 'In thread', thread: 'm1', replyTo: 'm1'),
          message('m1', 1, author: 'agent-lead', text: 'Root', thread: 'm1'),
        ],
        'next': null,
        'threads': <Object>[],
      };
      await pump(tester, fake);
      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();

      await tester.longPress(
        find.descendant(
          of: key('swarm-thread-messages'),
          matching: find.text('In thread'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-copy-link'));
      await tester.pumpAndSettle();

      expect(copied, ['harness://swarm/$tab/g1/m2']);
    });
  });

  group('threads', () {
    const parts = '/api/super-tabs/$tab/parts';
    const root = 'Can you check the drawer mockup?';
    const onlyThere = 'Looks good. One question.';
    const alsoHere = 'Pushed the fix.';
    const next = 'Next: the leaderboard.';

    /// The line under [id]: [replies] replies, the last [ago], Nova's.
    Map<String, dynamic> line(
      String id,
      int replies,
      int last, {
      Duration ago = const Duration(minutes: 5),
    }) => {
      'id': id,
      'replies': replies,
      'lastSequence': last,
      'lastAt': DateTime.now().subtract(ago).toUtc().toIso8601String(),
      'authors': [
        {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
      ],
      'people': <String>[],
    };

    /// River's question with two replies in its thread, Nova's only there
    /// and Nova's also sent to the chat; then a message of Nova's own. A
    /// reply sent comes back in the page under its operation id, as the
    /// backend writes it, and on the line; in both when also sent.
    FakeSwarm threaded({List<Map<String, dynamic>>? members}) {
      final page = [
        message('m1', 1, author: 'agent-lead', text: root, thread: 'm1'),
        message(
          'm2',
          2,
          text: onlyThere,
          thread: 'm1',
          replyTo: 'm1',
          minute: 2,
        ),
        message(
          'm3',
          3,
          text: alsoHere,
          thread: 'm1',
          replyTo: 'm1',
          alsoInChat: true,
          minute: 8,
        ),
        message('m4', 4, text: next, thread: 'm4', minute: 9),
      ];
      final lines = [line('m1', 2, 3)];
      final fake = backend(page, threads: lines, members: members);
      for (final id in ['m1', 'm4']) {
        fake.routes['$messages?thread=$id'] = (_) => {
          'messages': [
            for (final m in page.reversed)
              if (m['thread'] == id) m,
          ],
          'next': null,
          'threads': [
            for (final l in lines)
              if (l['id'] == id) l,
          ],
        };
      }
      fake.routes[commands] = (body) {
        final command = body!['command'] as Map<String, dynamic>;
        page.add(
          message(
            body['operationId'] as String,
            5,
            author: me,
            text: command['text'] as String,
            thread: 'm1',
            replyTo: 'm1',
            alsoInChat: command['alsoSend'] == true,
            minute: 10,
          ),
        );
        lines[0] = line('m1', 3, 5, ago: Duration.zero);
        return {'result': <String, dynamic>{}};
      };
      return fake;
    }

    Finder inThread(String text) => find.descendant(
      of: key('swarm-thread-messages'),
      matching: find.text(text),
    );

    Future<void> back(WidgetTester tester) async {
      await tester.tap(find.bySemanticsLabel('Back'));
      await tester.pumpAndSettle();
    }

    testWidgets('a root says how many replies and when the last came; a reply '
        'only in its thread is not in the chat, and one also sent says where '
        'it was written', (tester) async {
      await pump(tester, threaded());

      final under = key('swarm-thread-line-m1');
      expect(
        find.descendant(of: under, matching: find.text('2 replies')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: under, matching: find.text('Last reply 5 min ago')),
        findsOneWidget,
      );
      expect(find.text(onlyThere), findsNothing);
      expect(find.text(alsoHere), findsOneWidget);
      expect(key('swarm-replied-in-thread-m3'), findsOneWidget);
      expect(key('swarm-quote-m3'), findsNothing, reason: 'no quote of m1');
      expect(key('swarm-thread-line-m4'), findsNothing, reason: 'no replies');
    });

    testWidgets('a tap on the line opens the thread: the root, how many '
        'replies, each reply in order, and a box to reply in', (tester) async {
      final fake = threaded();
      await pump(tester, fake);

      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();

      expect(fake.paths, contains('$messages?thread=m1'));
      expect(find.text('Thread'), findsOneWidget);
      expect(
        tester.widget<Text>(key('swarm-thread-chat-title')).data,
        'Fix login',
      );
      expect(
        find.descendant(
          of: key('swarm-thread-divider'),
          matching: find.text('2 replies'),
        ),
        findsOneWidget,
      );
      final tops = [
        for (final text in [root]) tester.getTopLeft(inThread(text)).dy,
        tester.getTopLeft(key('swarm-thread-divider')).dy,
        for (final text in [onlyThere, alsoHere])
          tester.getTopLeft(inThread(text)).dy,
      ];
      expect(tops, orderedEquals([...tops]..sort()));
      expect(key('swarm-replied-in-thread-m3'), findsNothing);
      expect(key('swarm-thread-box'), findsOneWidget);
      expect(find.text('Reply'), findsOneWidget, reason: 'the field hint');
      expect(find.text('Also send to the chat'), findsOneWidget);
    });

    testWidgets('Reply in thread: a message\'s Reply opens its thread, with no '
        'reply bar in the chat', (tester) async {
      final fake = threaded();
      await pump(tester, fake);

      await tester.tap(find.text(next));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: key('swarm-reply-m4'),
          matching: find.text('Reply in thread'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-reply-m4'));
      await tester.pumpAndSettle();

      expect(fake.paths, contains('$messages?thread=m4'));
      expect(inThread(next), findsOneWidget);
      expect(key('swarm-thread-divider'), findsNothing, reason: 'no replies');

      await back(tester);
      expect(key('swarm-reply-bar'), findsNothing);
    });

    testWidgets('a message that is only a code block still opens its thread: '
        'a tap on the code shows Reply, Copy only copies', (tester) async {
      const code = '```\nflutter test\n```';
      final page = [message('m5', 5, text: code, thread: 'm5')];
      final fake = backend(page);
      fake.routes['$messages?thread=m5'] = (_) => {
        'messages': page,
        'next': null,
        'threads': <Object>[],
      };
      await pump(tester, fake);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (_) async => null);
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, null),
      );

      // Copy does its own thing: no Reply.
      await tester.tap(find.text('Copy'));
      await tester.pumpAndSettle();
      expect(key('swarm-reply-m5'), findsNothing);

      await tester.tap(find.text('flutter test'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: key('swarm-reply-m5'),
          matching: find.text('Reply in thread'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-reply-m5'));
      await tester.pumpAndSettle();

      expect(fake.paths, contains('$messages?thread=m5'));
      expect(inThread('flutter test'), findsOneWidget);
    });

    testWidgets('Replied in thread opens the thread it was written in', (
      tester,
    ) async {
      await pump(tester, threaded());

      await tester.tap(key('swarm-replied-in-thread-m3'));
      await tester.pumpAndSettle();

      expect(inThread(root), findsOneWidget);
      expect(inThread(onlyThere), findsOneWidget);
      expect(inThread(alsoHere), findsOneWidget);
    });

    testWidgets('a reply goes to the thread alone: it shows there, and the '
        'chat\'s line counts it', (tester) async {
      final fake = threaded();
      await pump(tester, fake);
      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();

      await tester.enterText(key('swarm-thread-field'), 'Ship it as drawn.');
      await tester.pump();
      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'message.send',
        'conversationId': 'g1',
        'text': 'Ship it as drawn.',
        'replyTo': 'm1',
        'recipientIds': <String>[],
      });
      expect(inThread('Ship it as drawn.'), findsOneWidget);
      expect(key('swarm-thread-pending'), findsNothing);

      await back(tester);
      expect(find.text('Ship it as drawn.'), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-thread-line-m1'),
          matching: find.text('3 replies'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('Also send to the chat posts the reply in both', (
      tester,
    ) async {
      final fake = threaded();
      await pump(tester, fake);
      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();

      await tester.enterText(key('swarm-thread-field'), 'Ship it as drawn.');
      await tester.tap(key('swarm-thread-also-send'));
      await tester.pump();
      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();

      expect(fake.commands.single['alsoSend'], isTrue);
      expect(fake.commands.single['replyTo'], 'm1');
      expect(inThread('Ship it as drawn.'), findsOneWidget);
      // Ticked for this reply alone.
      expect(
        tester
            .widget<Semantics>(key('swarm-thread-also-send'))
            .properties
            .checked,
        isFalse,
      );

      await back(tester);
      final sent = fake.calls
          .lastWhere((call) => call.path == commands)
          .body!['operationId'];
      expect(find.text('Ship it as drawn.'), findsOneWidget);
      expect(key('swarm-replied-in-thread-$sent'), findsOneWidget);
    });

    testWidgets('a notification of a reply only in its thread opens the '
        'thread', (tester) async {
      await pump(tester, threaded(), messageId: 'm2');

      expect(find.text('Thread'), findsOneWidget);
      expect(inThread(onlyThere), findsOneWidget);
      expect(
        find.text('The original message is no longer in this chat.'),
        findsNothing,
      );
    });

    testWidgets('a person who can only read opens the thread with no box to '
        'reply in, and no Reply', (tester) async {
      await pump(tester, threaded(members: [person(me, role: 'viewer')]));

      await tester.tap(find.text(next));
      await tester.pumpAndSettle();
      expect(key('swarm-reply-m4'), findsNothing);

      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();

      expect(inThread(onlyThere), findsOneWidget);
      expect(key('swarm-thread-box'), findsNothing);
      expect(
        find.text('You can read this chat, not post in it.'),
        findsOneWidget,
      );
    });

    testWidgets('taken out of the chat while its thread is open: nothing of '
        'it stays, not even the chat\'s name', (tester) async {
      final fake = threaded();
      final host = await pump(tester, fake);
      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();
      await tester.enterText(key('swarm-thread-field'), 'Half a reply');
      await tester.pump();
      expect(inThread(onlyThere), findsOneWidget);

      final full = fake.routes[parts]!(null)! as Map;
      fake.routes[parts] = (_) => {
        ...full,
        'groups': [
          for (final g in full['groups'] as List)
            if ((g as Map)['key'] != 'g1') g,
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(find.text('This chat is not open to you.'), findsOneWidget);
      for (final text in [root, onlyThere, alsoHere, 'Half a reply']) {
        expect(find.text(text), findsNothing, reason: text);
      }
      expect(key('swarm-thread-chat-title'), findsNothing);
      expect(key('swarm-thread-box'), findsNothing);
    });

    testWidgets('a reply refused as the chat is no longer the person\'s '
        'leaves nothing of the thread on screen', (tester) async {
      final fake = threaded();
      await pump(tester, fake);
      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();
      fake.routes[commands] = (_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'Not yours.',
        statusCode: 403,
      );

      await tester.enterText(key('swarm-thread-field'), 'Secret plan');
      await tester.pump();
      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();

      expect(find.text('This chat is not open to you.'), findsOneWidget);
      for (final text in [root, onlyThere, alsoHere, 'Secret plan']) {
        expect(find.text(text), findsNothing, reason: text);
      }
      expect(key('swarm-thread-chat-title'), findsNothing);
      expect(key('swarm-thread-box'), findsNothing);
    });

    testWidgets('a thread that fails to read shows what the chat has of it '
        'and Try again, which reads it', (tester) async {
      final fake = threaded();
      final working = fake.routes['$messages?thread=m1']!;
      var fails = true;
      fake.routes['$messages?thread=m1'] = (body) => fails
          ? throw SuperTabFailure('INTERNAL', 'Server error', statusCode: 500)
          : working(body);
      await pump(tester, fake);

      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();

      expect(inThread(root), findsOneWidget);
      expect(find.text('Server error'), findsOneWidget);
      expect(key('swarm-chat-skeleton'), findsNothing);
      final reads = fake.paths.where((p) => p.contains('thread=m1')).length;
      await tester.pump(const Duration(seconds: 30));
      expect(
        fake.paths.where((p) => p.contains('thread=m1')).length,
        reads,
        reason: 'no read again on its own',
      );

      fails = false;
      await tester.tap(key('swarm-thread-retry'));
      await tester.pumpAndSettle();

      expect(find.text('Server error'), findsNothing);
      expect(key('swarm-thread-retry'), findsNothing);
      expect(inThread(onlyThere), findsOneWidget);
    });

    group('files', () {
      final picker = (
        documents: pickSwarmFiles,
        copies: swarmPickerCopyFolders,
      );
      // No plugin answers in a widget test: the pickers' copies here are in
      // memory.
      setUp(() => swarmPickerCopyFolders = () async => const []);
      tearDown(() {
        swarmPickerCopyFolders = picker.copies;
        pickSwarmFiles = picker.documents;
      });

      /// Uploads the test answers: each held until [answer] completes it.
      final uploads =
          <
            ({
              String name,
              String conversationId,
              CancelToken cancel,
              void Function(double) progress,
              Completer<Map<String, dynamic>> answer,
            })
          >[];
      setUp(uploads.clear);
      Future<Map<String, dynamic>> held({
        required String tabId,
        required String conversationId,
        required String name,
        required String mime,
        required Uint8List bytes,
        required CancelToken cancel,
        required void Function(double sent) onProgress,
      }) {
        final answer = Completer<Map<String, dynamic>>();
        uploads.add((
          name: name,
          conversationId: conversationId,
          cancel: cancel,
          progress: onProgress,
          answer: answer,
        ));
        return answer.future;
      }

      Map<String, dynamic> attachment(String id) => {
        'attachment': {
          'id': id,
          'name': 'x',
          'mime': 'text/plain',
          'size': 1,
          'url': 'https://cdn.harness.autonomous.ai/$id/x',
        },
      };

      /// Opens m1's thread and attaches crash.log with the box's +.
      Future<void> attachInThread(WidgetTester tester) async {
        pickSwarmFiles = () async => [
          XFile.fromData(
            Uint8List(12),
            path: '/picker-copies/crash.log',
            length: 12,
          ),
        ];
        await tester.tap(key('swarm-thread-line-m1'));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-thread-attach'));
        await tester.pumpAndSettle();
        expect(find.text('Photo library'), findsOneWidget, reason: 'the sheet');
        await tester.tap(key('swarm-attach-files'));
        await tester.pumpAndSettle();
      }

      Finder inBox(Finder finder) =>
          find.descendant(of: key('swarm-thread-box'), matching: finder);

      testWidgets('the box\'s + attaches as the chat\'s does: the files show '
          'over the field, go up for the chat, then go with the reply', (
        tester,
      ) async {
        final fake = threaded();
        await pump(tester, fake, upload: held);
        await attachInThread(tester);

        expect(inBox(key('swarm-outgoing-crash.log')), findsOneWidget);
        expect(inBox(find.text('1 KB')), findsOneWidget);
        await tester.enterText(key('swarm-thread-field'), 'The log');
        await tester.pump();
        await tester.tap(key('swarm-thread-send'));
        await tester.pump();

        expect(uploads.single.name, 'crash.log');
        expect(uploads.single.conversationId, 'g1');
        expect(
          tester.widget<SwarmAttachButton>(key('swarm-thread-attach')).onTap,
          isNull,
          reason: 'off while the files go up',
        );
        uploads.single.progress(0.6);
        await tester.pump();
        expect(inBox(find.text('60%')), findsOneWidget);

        uploads.single.answer.complete(attachment('f1'));
        await tester.pumpAndSettle();

        expect(fake.commands.single, {
          'type': 'message.send',
          'conversationId': 'g1',
          'text': 'The log',
          'replyTo': 'm1',
          'recipientIds': <String>[],
          'attachmentIds': ['f1'],
        });
        expect(key('swarm-outgoing-crash.log'), findsNothing);
        await back(tester);
        expect(
          key('swarm-outgoing-crash.log'),
          findsNothing,
          reason: 'never in the chat\'s own box',
        );
      });

      testWidgets('a reply of files alone shows them while it is sent', (
        tester,
      ) async {
        final fake = threaded();
        fake.routes[commands] = (_) => Completer<Object?>().future;
        await pump(tester, fake, upload: held);
        await attachInThread(tester);

        await tester.tap(key('swarm-thread-send'));
        await tester.pump();
        uploads.single.answer.complete(attachment('f1'));
        await tester.pump();
        await tester.pump();

        expect(
          find.descendant(
            of: key('swarm-thread-pending'),
            matching: find.textContaining('crash.log'),
          ),
          findsOneWidget,
        );
      });

      testWidgets('a refused upload says what the chat says, and keeps the '
          'draft and the files', (tester) async {
        final fake = threaded();
        await pump(tester, fake, upload: held);
        await attachInThread(tester);
        await tester.enterText(key('swarm-thread-field'), 'The log');
        await tester.pump();

        await tester.tap(key('swarm-thread-send'));
        await tester.pump();
        uploads.single.answer.completeError(StateError('socket closed'));
        await tester.pumpAndSettle();

        expect(
          tester.widget<Text>(key('swarm-thread-post-error')).data,
          'Could not upload the file. Try again.',
        );
        expect(inBox(key('swarm-outgoing-crash.log')), findsOneWidget);
        expect(inBox(find.text('The log')), findsOneWidget);
        expect(fake.commands, isEmpty);
      });

      testWidgets('leaving the thread while its files go up sends nothing; '
          'opened again, the draft and the files are there', (tester) async {
        final fake = threaded();
        await pump(tester, fake, upload: held);
        await attachInThread(tester);
        await tester.enterText(key('swarm-thread-field'), 'The log');
        await tester.pump();
        await tester.tap(key('swarm-thread-send'));
        await tester.pump();

        await back(tester);
        expect(uploads.single.cancel.isCancelled, isTrue);
        uploads.single.answer.complete(attachment('late'));
        await tester.pumpAndSettle();
        expect(fake.commands, isEmpty);

        await tester.tap(key('swarm-thread-line-m1'));
        await tester.pumpAndSettle();
        expect(inBox(key('swarm-outgoing-crash.log')), findsOneWidget);
        expect(inBox(find.text('The log')), findsOneWidget);
        expect(key('swarm-thread-post-error'), findsNothing);
        expect(
          tester.widget<SwarmAttachButton>(key('swarm-thread-attach')).onTap,
          isNotNull,
        );
      });
    });
  });

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

    /// The read marks sent for g1, in order.
    List<Object?> marksSent(FakeSwarm fake) => [
      for (final call in fake.calls)
        if (call.method == 'POST' &&
            call.path == '/api/super-tabs/$tab/conversations/g1/read')
          call.body?['sequence'],
    ];

    /// Whether g1 reads as unread on the phone.
    bool unread(SwarmHost host) {
      final reader = host.session!.inbox.reader(tab)!;
      return reader.readMarks!.unread(reader.snapshot!.conversation('g1')!);
    }

    /// g1 moved on to [sequence], as the Swarm's next read says.
    void movedOn(FakeSwarm fake, int sequence) =>
        fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
          cursor: 'c3',
          lastChangedAt: 200,
          derived: {'decisionsWaiting': 0},
          groups: [
            part(
              'g1',
              9,
              groupData(
                'g1',
                title: 'Fix login',
                agentIds: ['agent-lead', 'agent-builder'],
                status: 'working',
                lastMessageSequence: sequence,
              ),
            ),
          ],
        );

    testWidgets('a reaction: its own row alone', (tester) async {
      final fake = backend(page());
      fake.routes['$messages?before=4'] = (_) => {
        'messages': [
          for (final row in page().reversed)
            if (row['id'] == 'm2')
              message(
                'm2',
                2,
                text: 'On it @River',
                minute: 1,
                reactions: {
                  'thumbs_up': [('person', me)],
                },
              )
            else
              row,
        ],
        'next': null,
        'reactionSeq': 1,
      };
      await pump(tester, fake);

      final reacted = await rowsBuilt(() async {
        await tester.longPress(find.text('On it @River'));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-react-thumbs_up'));
        await tester.pumpAndSettle();
      });

      expect(reacted.toSet(), {'m2'});
      expect(key('swarm-reaction-m2-thumbs_up'), findsOneWidget);
    });

    testWidgets('a new message at the foot: its own row alone, at once', (
      tester,
    ) async {
      final fake = backend(page());
      final host = await pump(tester, fake);
      movedOn(fake, 4);
      fake.routes['$messages?after=3'] = (_) => {
        'messages': [message('m4', 4, text: 'Fresh news', minute: 3)],
        'next': null,
      };

      final built = await rowsBuilt(() async {
        await host.session!.inbox.reader(tab)!.refresh();
        await tester.pumpAndSettle();
      });

      expect(built, ['m4']);
      expect(inView(tester, find.text('Fresh news')), isTrue);
      expect(key('swarm-new-pill'), findsNothing);
    });

    testWidgets('only the row a quote leads to is lit, and fades', (
      tester,
    ) async {
      await pump(tester, backend(page()));
      final fading = find.descendant(
        of: key('swarm-messages'),
        matching: find.byType(AnimatedContainer),
      );
      expect(fading, findsNothing);

      await tester.tap(key('swarm-quote-m3'));
      await tester.pumpAndSettle();

      expect(key('swarm-lit-m1'), findsOneWidget);
      expect(fading, findsOneWidget);
      expect(
        find.descendant(of: key('swarm-message-m1'), matching: fading),
        findsNothing,
        reason: 'the lit row is the animated one itself',
      );
      expect(tester.widget(fading).key, const ValueKey('swarm-message-m1'));
    });

    testWidgets('a message arriving while the person reads back keeps what '
        'they read in place, and says how many wait below; the pill goes '
        'to them', (tester) async {
      final fake = backend([
        for (var i = 1; i < 40; i++)
          message('m$i', i, text: 'Line $i\nof the log', minute: i),
      ]);
      final host = await pump(tester, fake);
      await tester.drag(key('swarm-messages'), const Offset(0, 300));
      await tester.pumpAndSettle();
      final reading = [
        for (var i = 39; i > 0; i--) key('swarm-message-m$i'),
      ].firstWhere((row) => row.evaluate().isNotEmpty && inView(tester, row));
      final before = tester.getRect(reading).top;

      movedOn(fake, 40);
      fake.routes['$messages?after=39'] = (_) => {
        'messages': [message('m40', 40, text: 'Fresh news', minute: 45)],
        'next': null,
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(tester.getRect(reading).top, moreOrLessEquals(before, epsilon: 1));
      expect(
        find.descendant(
          of: key('swarm-new-pill'),
          matching: find.text('1 new'),
        ),
        findsOneWidget,
      );

      // Waiting below, it is not read: no mark goes past what they saw.
      expect(marksSent(fake), everyElement(lessThan(40)));
      expect(unread(host), isTrue);

      await tester.tap(key('swarm-new-pill'));
      await tester.pumpAndSettle();

      expect(inView(tester, find.text('Fresh news')), isTrue);
      expect(key('swarm-new-pill'), findsNothing);
      expect(marksSent(fake).last, 40, reason: 'shown now, so read');
      expect(unread(host), isFalse);
    });

    testWidgets('a message left waiting below stays unread when the chat '
        'opens again from what it kept, at an earlier message', (tester) async {
      final fake = backend([
        for (var i = 1; i < 40; i++)
          message('m$i', i, text: 'Line $i\nof the log', minute: i),
      ]);
      final host = await pump(tester, fake);
      await tester.drag(key('swarm-messages'), const Offset(0, 300));
      await tester.pumpAndSettle();
      movedOn(fake, 40);
      fake.routes['$messages?after=39'] = (_) => {
        'messages': [message('m40', 40, text: 'Fresh news', minute: 45)],
        'next': null,
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(marksSent(fake), everyElement(lessThan(40)));

      // Closed with 40 unseen; the chat keeps what it read.
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      expect(SwarmChatCache.length, greaterThan(0));
      // A notice opens it again at its first message.
      await show(tester, host, messageId: 'm1');

      expect(inView(tester, find.text('Line 1\nof the log')), isTrue);
      expect(marksSent(fake), everyElement(lessThan(40)));
      expect(unread(host), isTrue);
    });

    testWidgets('a message that arrives while Harness is behind is read only '
        'once Harness is in front again', (tester) async {
      final fake = backend([message('m1', 1, text: 'The plan', minute: 1)]);
      final host = await pump(tester, fake);
      // The app's states, one step at a time, as the platform moves them.
      void go(List<AppLifecycleState> states) {
        for (final state in states) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
      }

      const behind = [
        AppLifecycleState.inactive,
        AppLifecycleState.hidden,
        AppLifecycleState.paused,
      ];
      const front = [
        AppLifecycleState.hidden,
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
      ];
      addTearDown(() {
        if (tester.binding.lifecycleState == AppLifecycleState.paused) {
          go(front);
        }
      });

      go(behind);
      movedOn(fake, 2);
      fake.routes['$messages?after=1'] = (_) => {
        'messages': [message('m2', 2, text: 'Fresh news', minute: 2)],
        'next': null,
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      // Behind, no frame is drawn, but the chat reads the message all the
      // same: it is not seen.
      expect(marksSent(fake), everyElement(lessThan(2)));
      expect(unread(host), isTrue);

      go(front);
      await tester.pumpAndSettle();

      expect(marksSent(fake).last, 2);
      expect(unread(host), isFalse);
    });
  });

  group('while it loads', () {
    const parts = '/api/super-tabs/$tab/parts';
    const notOpen = 'This chat is not open to you.';

    /// Skeleton bubbles fill the chat, from its foot up to its top.
    void skeleton(WidgetTester tester) {
      expect(key('swarm-chat-skeleton'), findsOneWidget);
      // Those built just past the top count: one ending right at it is full.
      final bubbles = find.byKey(
        const ValueKey('swarm-skeleton-bubble'),
        skipOffstage: false,
      );
      final tops = [
        for (final bubble in bubbles.evaluate())
          tester
              .getTopLeft(
                find.byElementPredicate(
                  (e) => e == bubble,
                  skipOffstage: false,
                ),
              )
              .dy,
      ];
      expect(
        tops.reduce(math.min),
        lessThanOrEqualTo(tester.getTopLeft(key('swarm-chat-skeleton')).dy),
        reason: 'no gap above the first bubble',
      );
    }

    for (final (name, size) in [
      ('a small phone', const Size(320, 568)),
      ('an iPhone 14', const Size(390, 844)),
      ('a tablet', const Size(1024, 1366)),
    ]) {
      testWidgets('on $name the skeleton leaves no gap at the top', (
        tester,
      ) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final fake = backend([message('m1', 1, text: 'The plan')]);
        final page = Completer<Object?>();
        fake.routes[messages] = (_) => page.future;

        await pump(tester, fake, settle: false);

        skeleton(tester);
        page.complete({'messages': <Object>[], 'next': null});
        await tester.pumpAndSettle();
      });
    }

    testWidgets('the first page shows skeleton bubbles, and nothing says the '
        'chat is empty or not open', (tester) async {
      final fake = backend([message('m1', 1, text: 'The plan')]);
      final page = Completer<Object?>();
      fake.routes[messages] = (_) => page.future;

      await pump(tester, fake, settle: false);

      skeleton(tester);
      expect(find.text(notOpen), findsNothing);
      expect(find.text('No messages yet.'), findsNothing);

      page.complete({
        'messages': [message('m1', 1, text: 'The plan')],
        'next': null,
      });
      await tester.pumpAndSettle();
      expect(find.text('The plan'), findsOneWidget);
      expect(key('swarm-chat-skeleton'), findsNothing);
    });

    testWidgets('before the account\'s Swarms are read, the chat is a '
        'skeleton under a placeholder header', (tester) async {
      final fake = backend([message('m1', 1)]);
      final list = Completer<Object?>();
      final listed = fake.routes['/api/super-tabs/list']!;
      fake.routes['/api/super-tabs/list'] = (_) => list.future;

      await pump(tester, fake, settle: false);

      skeleton(tester);
      expect(key('swarm-header-placeholder'), findsOneWidget);
      expect(find.text(notOpen), findsNothing);

      list.complete(listed(null));
      await tester.pumpAndSettle();
      expect(find.text('Fix login'), findsOneWidget);
      expect(key('swarm-header-placeholder'), findsNothing);
    });

    testWidgets('before its Swarm is read, the header is a placeholder of the '
        'same height and nothing says the chat is not open', (tester) async {
      final fake = backend([message('m1', 1, text: 'The plan')]);
      final swarm = Completer<Object?>(), page = Completer<Object?>();
      final read = fake.routes[parts]!;
      fake.routes[parts] = (_) => swarm.future;
      fake.routes[messages] = (_) => page.future;

      await pump(tester, fake, settle: false);

      skeleton(tester);
      expect(key('swarm-header-placeholder'), findsOneWidget);
      expect(find.text(notOpen), findsNothing);
      expect(find.text('Chat'), findsNothing);
      final height = tester.getSize(key('swarm-chat-header')).height;

      swarm.complete(read(null));
      page.complete({
        'messages': [message('m1', 1, text: 'The plan')],
        'next': null,
      });
      await tester.pumpAndSettle();
      expect(find.text('Fix login'), findsOneWidget);
      expect(find.text('The plan'), findsOneWidget);
      expect(tester.getSize(key('swarm-chat-header')).height, height);
    });

    testWidgets('a chat looked for by id is a skeleton until the lookup '
        'refuses it; only then is it not open', (tester) async {
      final fake = backend([]);
      final lookup = Completer<Object?>(), page = Completer<Object?>();
      fake.routes['/api/super-tabs/$tab/groups/g9'] = (_) => lookup.future;
      fake.routes['/api/super-tabs/$tab/conversations/g9/messages'] = (_) =>
          page.future;

      await pump(tester, fake, conversation: 'g9', settle: false);

      expect(fake.paths, contains('/api/super-tabs/$tab/groups/g9'));
      skeleton(tester);
      expect(find.text(notOpen), findsNothing);

      lookup.completeError(
        const SuperTabFailure('FORBIDDEN', 'Not yours.', statusCode: 403),
      );
      await frames(tester);
      expect(find.text(notOpen), findsOneWidget);
      expect(key('swarm-chat-skeleton'), findsNothing);
      expect(key('swarm-header-placeholder'), findsNothing);

      page.completeError(
        const SuperTabFailure('FORBIDDEN', 'Not yours.', statusCode: 403),
      );
      await tester.pumpAndSettle();
      expect(find.text(notOpen), findsOneWidget);
    });

    testWidgets('a chat with no message yet says so', (tester) async {
      await pump(tester, backend([]));

      expect(find.text('No messages yet.'), findsOneWidget);
      expect(key('swarm-chat-skeleton'), findsNothing);
      expect(find.text(notOpen), findsNothing);
    });
  });

  // A message link opens the chat at its message (phone_shell.dart). One the
  // person cannot open says "not open" alike, whatever the reason, and shows
  // nothing of the chat: no title, project, message or name.
  group('opened from a message link', () {
    const notOpen = 'This chat is not open to you.';
    const secret = 'The secret plan';

    void nothingLeaks(WidgetTester tester) {
      expect(find.text(notOpen), findsOneWidget);
      expect(key('swarm-chat-skeleton'), findsNothing);
      for (final text in [secret, 'Fix login', 'Mobile', '#Mobile', 'Nova']) {
        expect(find.textContaining(text), findsNothing, reason: text);
      }
    }

    for (final (why, failure) in [
      (
        'an unknown id',
        const SuperTabFailure('NOT_FOUND', 'No such chat.', statusCode: 404),
      ),
      (
        'a private chat of others',
        const SuperTabFailure('FORBIDDEN', 'Not yours.', statusCode: 403),
      ),
      (
        'someone else\'s Buddy chat',
        const SuperTabFailure('FORBIDDEN', 'Not yours.', statusCode: 403),
      ),
    ]) {
      testWidgets('$why is not open, and shows nothing of it', (tester) async {
        final fake = backend([message('m1', 1, text: secret)]);
        fake.routes['/api/super-tabs/$tab/groups/g9'] = (_) => throw failure;
        fake.routes['/api/super-tabs/$tab/conversations/g9/messages'] = (_) =>
            throw failure;

        await pump(tester, fake, conversation: 'g9', messageId: 'm1');

        nothingLeaks(tester);
      });
    }

    testWidgets('a chat of a Swarm the person is not in is not open', (
      tester,
    ) async {
      final fake = backend([message('m1', 1, text: secret)]);
      const other = 'tab-other';
      fake.routes['/api/super-tabs/$other/parts'] = (_) =>
          throw const SuperTabFailure(
            'FORBIDDEN',
            'Not yours.',
            statusCode: 403,
          );
      fake.routes['/api/super-tabs/$other/conversations/g1/messages'] = (_) =>
          throw const SuperTabFailure(
            'FORBIDDEN',
            'Not yours.',
            statusCode: 403,
          );

      await pump(
        tester,
        fake,
        swarmId: other,
        conversation: 'g1',
        messageId: 'm1',
      );

      nothingLeaks(tester);
    });

    testWidgets('a person removed from the Swarm while it is open loses it '
        'at once: nothing of it stays', (tester) async {
      final fake = backend([message('m1', 1, text: secret)]);
      final host = await pump(tester, fake, messageId: 'm1');
      expect(find.text(secret), findsOneWidget);

      const refused = SuperTabFailure(
        'FORBIDDEN',
        'Not yours.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      fake.routes[messages] = (_) => throw refused;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      nothingLeaks(tester);
    });

    testWidgets('a lookup that fails is asked again at the next read, and '
        'opens the chat at the message then', (tester) async {
      final fake = backend([message('m1', 1, text: secret)]);
      var lookups = 0;
      final g9 = {
        'group': part(
          'g9',
          9,
          groupData('g9', title: 'Found later', lastMessageSequence: 5),
        ),
      };
      fake.routes['/api/super-tabs/$tab/groups/g9'] = (_) {
        lookups++;
        if (lookups == 1) throw StateError('socket closed');
        return g9;
      };
      fake.routes['/api/super-tabs/$tab/conversations/g9/messages'] = (_) => {
        'messages': [
          {...message('m5', 5, text: 'Found it'), 'conversationId': 'g9'},
        ],
        'next': null,
      };
      final host = await pump(
        tester,
        fake,
        conversation: 'g9',
        messageId: 'm5',
        settle: false,
      );
      expect(lookups, 1);
      expect(find.text(notOpen), findsNothing);

      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(lookups, 2);
      expect(find.text('Found it'), findsOneWidget);
    });
  });

  group('opened again', () {
    const parts = '/api/super-tabs/$tab/parts';

    FakeSwarm read() => backend([
      message('m1', 1, author: 'agent-lead', text: 'The plan'),
      message('m2', 2, text: 'On it'),
    ]);

    /// The chat closed, its Swarm still read.
    Future<void> close(WidgetTester tester) =>
        tester.pumpWidget(const SizedBox());

    testWidgets('shows at once what was read, then reads only what is newer', (
      tester,
    ) async {
      final fake = read();
      final host = await pump(tester, fake);
      await close(tester);
      final newer = Completer<Object?>();
      fake.routes['$messages?after=2'] = (_) => newer.future;

      await show(tester, host, settle: false);

      expect(find.text('The plan'), findsOneWidget);
      expect(find.text('On it'), findsOneWidget);
      expect(key('swarm-chat-skeleton'), findsNothing);
      expect(
        fake.paths.where((p) => p.startsWith(messages)).last,
        '$messages?after=2',
      );

      newer.complete({
        'messages': [message('m3', 3, text: 'Done')],
        'next': null,
      });
      await tester.pumpAndSettle();
      expect(find.text('Done'), findsOneWidget);
    });

    testWidgets('signing out forgets every chat kept', (tester) async {
      final fake = read();
      final host = await pump(tester, fake);
      await close(tester);
      expect(SwarmChatCache.length, 1);

      account.value = null;

      expect(SwarmChatCache.length, 0);
      account.value = me;
      fake.calls.clear();
      // Harness is behind in these tests: the new session's Swarms are read
      // here.
      await host.session!.inbox.refresh();
      await show(tester, host);
      expect(fake.paths, contains(messages));
      expect(
        fake.paths.where((p) => p.startsWith('$messages?after=')),
        isEmpty,
        reason: 'read from the start, as a first open',
      );
    });

    testWidgets('turning Swarm off forgets every chat kept', (tester) async {
      final host = await pump(tester, read());
      await close(tester);
      expect(SwarmChatCache.length, 1);

      features.value = {};

      expect(host.session, isNull);
      expect(SwarmChatCache.length, 0);
    });

    testWidgets('a chat the person can no longer read is forgotten, open or '
        'closed', (tester) async {
      final fake = read();
      final host = await pump(tester, fake);
      await close(tester);
      expect(SwarmChatCache.length, 1);
      final reader = host.session!.inbox.reader(tab)!;

      // Closed: taken out of g1, the Swarm is read again without it.
      final full = fake.routes[parts]!(null)! as Map;
      void leaveOut() {
        fake.routes[parts] = (_) => {
          ...full,
          'groups': [
            for (final g in full['groups'] as List)
              if ((g as Map)['key'] != 'g1') g,
          ],
        };
        fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      }

      leaveOut();
      await reader.refresh();
      expect(SwarmChatCache.length, 0);

      await show(tester, host);
      expect(find.text('The plan'), findsNothing);
      expect(find.text('This chat is not open to you.'), findsOneWidget);
      await close(tester);
      expect(SwarmChatCache.length, 0);

      // Open: kept from before, then taken out while on screen.
      fake.routes[parts] = (_) => full;
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      await reader.refresh();
      await show(tester, host);
      await close(tester);
      expect(SwarmChatCache.length, 1);
      await show(tester, host);
      expect(find.text('The plan'), findsOneWidget);

      leaveOut();
      await reader.refresh();
      await tester.pumpAndSettle();

      expect(find.text('The plan'), findsNothing);
      expect(find.text('This chat is not open to you.'), findsOneWidget);
      expect(SwarmChatCache.length, 0);
      await close(tester);
      expect(SwarmChatCache.length, 0);
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

  group('attaching files', () {
    final picker = (
      photos: pickSwarmPhotos,
      camera: takeSwarmPhoto,
      documents: pickSwarmFiles,
      settings: openSwarmSettings,
      copies: swarmPickerCopyFolders,
    );
    // No plugin answers in a widget test: the pickers' copies here are in memory.
    setUp(() => swarmPickerCopyFolders = () async => const []);
    tearDown(() {
      swarmPickerCopyFolders = picker.copies;
      pickSwarmPhotos = picker.photos;
      takeSwarmPhoto = picker.camera;
      pickSwarmFiles = picker.documents;
      openSwarmSettings = picker.settings;
    });

    /// A picker's file held in memory, named as on a phone: by its path.
    XFile picked(String name, int size) => XFile.fromData(
      Uint8List(size),
      path: '/picker-copies/$name',
      length: size,
    );

    /// Uploads the test answers: each held until [answer] completes it.
    final uploads =
        <
          ({
            String name,
            void Function(double) progress,
            Completer<Map<String, dynamic>> answer,
          })
        >[];
    setUp(uploads.clear);
    Future<Map<String, dynamic>> held({
      required String tabId,
      required String conversationId,
      required String name,
      required String mime,
      required Uint8List bytes,
      required dynamic cancel,
      required void Function(double sent) onProgress,
    }) {
      final answer = Completer<Map<String, dynamic>>();
      uploads.add((name: name, progress: onProgress, answer: answer));
      return answer.future;
    }

    Map<String, dynamic> attachment(String id) => {
      'attachment': {
        'id': id,
        'name': 'x',
        'mime': 'image/jpeg',
        'size': 1,
        'url': 'https://cdn.harness.autonomous.ai/$id/x',
      },
    };

    Future<void> attach(WidgetTester tester, String row) async {
      await tester.tap(key('swarm-attach'));
      await tester.pumpAndSettle();
      await tester.tap(key(row));
      await tester.pumpAndSettle();
    }

    testWidgets('+ opens a sheet with Photo library, Camera and Files', (
      tester,
    ) async {
      await pump(tester, backend([message('m1', 1)]));

      await tester.tap(key('swarm-attach'));
      await tester.pumpAndSettle();

      expect(find.text('Photo library'), findsOneWidget);
      expect(find.text('Camera'), findsOneWidget);
      expect(find.text('Files'), findsOneWidget);
      for (final row in ['library', 'camera', 'files']) {
        expect(
          tester.getSize(key('swarm-attach-$row')).height,
          greaterThanOrEqualTo(44),
        );
      }
    });

    testWidgets('the sheet rounds at the theme\'s sheet radius', (
      tester,
    ) async {
      await pump(tester, backend([message('m1', 1)]));

      await tester.tap(key('swarm-attach'));
      await tester.pumpAndSettle();

      expect(sheetTopRadius(tester), grid.AppControl.sheetRadius);
    });

    testWidgets('photos picked show as chips with their size; ✕ takes one '
        'off before sending', (tester) async {
      pickSwarmPhotos = (limit) async => [
        picked('a.jpg', 2 * 1024 * 1024),
        picked('b.jpg', 4 * 1024),
      ];
      await pump(tester, backend([message('m1', 1)]));

      await attach(tester, 'swarm-attach-library');

      expect(key('swarm-outgoing-photo.jpg'), findsOneWidget);
      expect(key('swarm-outgoing-photo-2.jpg'), findsOneWidget);
      expect(find.text('2.0 MB'), findsOneWidget);
      expect(find.text('4 KB'), findsOneWidget);

      await tester.tap(key('swarm-outgoing-remove-photo.jpg'));
      await tester.pump();

      expect(key('swarm-outgoing-photo.jpg'), findsNothing);
      expect(key('swarm-outgoing-photo-2.jpg'), findsOneWidget);
    });

    testWidgets('Send with files and no text uploads them, shows each one\'s '
        'progress, then posts them', (tester) async {
      pickSwarmFiles = () async => [picked('crash.log', 12)];
      final fake = backend([message('m1', 1)]);
      await pump(tester, fake, upload: held);

      await attach(tester, 'swarm-attach-files');
      await tester.tap(key('swarm-send'));
      await tester.pump();

      expect(uploads.single.name, 'crash.log');
      uploads.single.progress(0.6);
      await tester.pump();
      expect(find.text('60%'), findsOneWidget);

      uploads.single.answer.complete(attachment('f1'));
      await tester.pumpAndSettle();

      expect(fake.commands.single['attachmentIds'], ['f1']);
      expect(key('swarm-outgoing-crash.log'), findsNothing);
    });

    testWidgets('the keyboard stays up while the files go up and goes down '
        'once they are posted', (tester) async {
      pickSwarmFiles = () async => [picked('crash.log', 12)];
      final fake = backend([message('m1', 1)]);
      await pump(tester, fake, upload: held);

      await attach(tester, 'swarm-attach-files');
      await tester.enterText(find.byType(TextField), 'The log');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pump();

      expect(uploads.single.name, 'crash.log');
      expect(composer(tester), up);

      uploads.single.answer.complete(attachment('f1'));
      await tester.pumpAndSettle();

      expect(fake.commands.single['attachmentIds'], ['f1']);
      expect(composer(tester), down);
    });

    testWidgets('the keyboard stays up when the files could not go up', (
      tester,
    ) async {
      pickSwarmFiles = () async => [picked('crash.log', 12)];
      final fake = backend([message('m1', 1)]);
      await pump(tester, fake, upload: held);

      await attach(tester, 'swarm-attach-files');
      await tester.enterText(find.byType(TextField), 'The log');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pump();
      uploads.single.answer.completeError(
        const SuperTabFailure(
          'UPLOAD_FAILED',
          'Could not upload the file. Try again.',
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Could not upload the file. Try again.'),
        findsOneWidget,
      );
      expect(composer(tester), up);
    });

    testWidgets('a post of files alone shows them while it is sent', (
      tester,
    ) async {
      pickSwarmFiles = () async => [picked('crash.log', 12)];
      final fake = backend([message('m1', 1)]);
      fake.routes[commands] = (_) => Completer<Object?>().future;
      await pump(tester, fake, upload: held);

      await attach(tester, 'swarm-attach-files');
      await tester.tap(key('swarm-send'));
      await tester.pump();
      uploads.single.answer.complete(attachment('f1'));
      await tester.pump();
      await tester.pump();

      expect(
        find.descendant(
          of: key('swarm-pending'),
          matching: find.textContaining('crash.log'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a refused upload says why and keeps the files', (
      tester,
    ) async {
      pickSwarmFiles = () async => [picked('crash.log', 12)];
      final fake = backend([message('m1', 1)]);
      await pump(tester, fake, upload: held);

      await attach(tester, 'swarm-attach-files');
      await tester.tap(key('swarm-send'));
      await tester.pump();
      uploads.single.answer.completeError(
        const SuperTabFailure(
          'UPLOAD_FAILED',
          'Could not upload the file. Try again.',
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Could not upload the file. Try again.'),
        findsOneWidget,
      );
      expect(key('swarm-outgoing-crash.log'), findsOneWidget);
      expect(fake.commands, isEmpty);
    });

    testWidgets('a file over 10 MB is named under the files', (tester) async {
      pickSwarmFiles = () async => [
        picked('big.zip', 10 * 1024 * 1024 + 1),
        picked('ok.txt', 3),
      ];
      await pump(tester, backend([message('m1', 1)]));

      await attach(tester, 'swarm-attach-files');

      expect(find.text('big.zip is over 10 MB.'), findsOneWidget);
      expect(key('swarm-outgoing-ok.txt'), findsOneWidget);
    });

    testWidgets('camera access turned off offers Settings', (tester) async {
      takeSwarmPhoto = () async =>
          throw PlatformException(code: 'camera_access_denied');
      var opened = 0;
      openSwarmSettings = () async {
        opened++;
        return true;
      };
      await pump(tester, backend([message('m1', 1)]));

      await attach(tester, 'swarm-attach-camera');

      expect(find.text('Camera access is off'), findsOneWidget);
      await tester.tap(find.text('Open Settings'));
      await tester.pumpAndSettle();

      expect(opened, 1);
      expect(find.text('Camera access is off'), findsNothing);
    });

    testWidgets('Not now closes the camera box without Settings', (
      tester,
    ) async {
      takeSwarmPhoto = () async =>
          throw PlatformException(code: 'camera_access_denied');
      var opened = 0;
      openSwarmSettings = () async {
        opened++;
        return true;
      };
      await pump(tester, backend([message('m1', 1)]));

      await attach(tester, 'swarm-attach-camera');
      await tester.tap(find.text('Not now'));
      await tester.pumpAndSettle();

      expect(opened, 0);
      expect(find.text('Camera access is off'), findsNothing);
    });

    testWidgets('a person who cannot post has no attach button', (
      tester,
    ) async {
      await pump(
        tester,
        backend([message('m1', 1)], members: [person(me, role: 'viewer')]),
      );

      expect(key('swarm-read-only'), findsOneWidget);
      expect(key('swarm-attach'), findsNothing);
    });
  });
  group('the delivery line under the newest own message', () {
    final queued = {'id': 'd1', 'agentId': 'agent-lead', 'status': 'queued'};
    final claimed = {...queued, 'status': 'claimed'};
    const notDelivered = 'Not delivered yet';

    Map<String, dynamic> mine(
      String id,
      int sequence, {
      String? thread,
      Object? delivery,
    }) => {
      ...message(id, sequence, author: me, thread: thread, minute: sequence),
      'deliveries': [?delivery],
    };

    Future<SwarmHost> open(WidgetTester tester, FakeSwarm fake) async {
      final host = await pump(tester, fake);
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      return host;
    }

    testWidgets('only the person\'s newest message carries it', (tester) async {
      await open(
        tester,
        backend([
          mine('m1', 1, delivery: queued),
          {
            ...message('m2', 2, text: 'On it', minute: 2),
            'deliveries': [queued],
          },
          mine('m3', 3, delivery: queued),
          message('m4', 4, text: 'Still here', minute: 4),
        ]),
      );

      expect(key('swarm-message-receipt-m3'), findsOneWidget);
      expect(key('swarm-message-receipt-m1'), findsNothing);
      expect(key('swarm-message-receipt-m2'), findsNothing);
      expect(find.text(notDelivered), findsOneWidget);
      expect(find.textContaining("River's computer is online"), findsOneWidget);
    });

    testWidgets('a delivery claimed clears it, its own row alone', (
      tester,
    ) async {
      final page = [mine('m1', 1), mine('m2', 2, delivery: queued)];
      final fake = backend(page);
      var answer = page.last;
      fake.routes['$messages?messageId='] = (_) => {
        'messages': [answer],
      };
      final host = await open(tester, fake);
      expect(find.text(notDelivered), findsOneWidget);

      answer = mine('m2', 2, delivery: claimed);
      await tester.pump(const Duration(seconds: 30));
      final built = await rowsBuilt(() async {
        await host.session!.inbox.reader(tab)!.refresh();
        await tester.pumpAndSettle();
      });

      expect(built, ['m2']);
      expect(find.text(notDelivered), findsNothing);
      expect(key('swarm-message-receipt-m2'), findsNothing);
    });

    testWidgets('sign-out while it shows: nothing of it stays', (tester) async {
      await open(tester, backend([mine('m1', 1, delivery: queued)]));
      expect(find.text(notDelivered), findsOneWidget);

      account.value = null;
      await frames(tester);

      expect(find.text(notDelivered), findsNothing);
      expect(find.textContaining('River'), findsNothing);
    });

    testWidgets('a newest own reply only in its thread leaves the chat quiet', (
      tester,
    ) async {
      await open(
        tester,
        backend([
          mine('m1', 1, delivery: queued),
          message('m2', 2, text: 'Root', minute: 2),
          mine('m3', 3, thread: 'm2', delivery: queued),
        ]),
      );
      expect(find.text(notDelivered), findsNothing);
    });
  });
}
