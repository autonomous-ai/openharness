import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderSliverMultiBoxAdaptor;
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart' show XFile;

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppPalette;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_dictation.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_new_message_sheet.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// New message on Swarm Home (Tony, 10-30: as Slack Mobile starts one): the
/// header's compose is gone, a round + floats at Home's bottom right, and it
/// opens a sheet where the person picks a project's chat or their own Buddy
/// chat, types and sends — through the chat's own send — and lands in that
/// chat. Over a scripted backend: one Swarm whose person reads Điện thoại,
/// Mobile, Team (private, theirs) and Web, not Secret (private, another's);
/// Mobile has their Buddy chat with Wren, another person's Buddy chat and a
/// private chat; Web their archived Buddy chat; Old's chat is archived.
void main() {
  const web = 'project-2', team = 'project-3', secret = 'project-4';
  const phone = 'project-5', old = 'project-6';
  const webLead = 'group-lead-web', teamLead = 'group-lead-team';
  const secretLead = 'group-lead-secret', phoneLead = 'group-lead-phone';
  const oldLead = 'group-lead-old';
  const buddyChat = 'buddy-me';
  const other = 'person-other';
  const lab = 'tab-2';

  final original = (documents: pickSwarmFiles, copies: swarmPickerCopyFolders);
  setUp(() => swarmPickerCopyFolders = () async => const []);
  tearDown(() {
    swarmPickerCopyFolders = original.copies;
    pickSwarmFiles = original.documents;
  });

  Map<String, dynamic> projectRow(
    String id,
    String name,
    String lead, {
    bool private = false,
    String owner = me,
    List<String> members = const [],
  }) => {
    'id': id,
    'name': name,
    'ownerId': owner,
    'leadConversationId': lead,
    'visibility': private ? 'private' : 'public',
    'members': [
      for (final member in members) {'id': member, 'generation': 'gen-$member'},
    ],
    'updateMinutes': 5,
  };

  Map<String, dynamic> inProject(String id, Map<String, dynamic> row) => {
    ...row,
    'projectId': id,
  };

  final readable = [
    projectRow(project, 'Mobile', leadChat),
    projectRow(web, 'Web', webLead),
    projectRow(
      team,
      'Team',
      teamLead,
      private: true,
      owner: other,
      members: [me],
    ),
    projectRow(secret, 'Secret', secretLead, private: true, owner: other),
    projectRow(phone, 'Điện thoại', phoneLead),
    projectRow(old, 'Old', oldLead),
  ];

  /// The messages posted, by chat, as the backend has them.
  late Map<String, List<Map<String, dynamic>>> posted;

  /// What the messages route of each chat answers: those posted to it.
  void messagesOf(FakeSwarm fake, String tabId, String chat) =>
      fake.routes['/api/super-tabs/$tabId/conversations/$chat/messages'] =
          (_) => {
            'messages': [...?posted['$tabId/$chat']].reversed.toList(),
            'next': null,
          };

  /// The backend: each message.send is taken and read back in its chat, in
  /// Swarm [tabId]; [role] is the person's there.
  void serve(
    FakeSwarm fake, {
    String tabId = tab,
    String name = 'Phone Swarm',
    String role = 'owner',
    List<Map<String, dynamic>>? projects,
  }) {
    fake.routes['/api/super-tabs/$tabId/parts'] = (_) => {
      ...firstLoad(
        tabId: tabId,
        head: headData(id: tabId, name: name, projects: projects ?? readable),
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          buddyData('agent-wren', displayName: 'Wren'),
          buddyData('agent-ivy', owner: other, displayName: 'Ivy'),
        ],
        groups: [
          inProject(
            web,
            groupData(
              webLead,
              title: 'Web',
              lastMessageSequence: posted['$tabId/$webLead']?.length ?? 0,
            ),
          ),
          inProject(team, groupData(teamLead, title: 'Team')),
          inProject(secret, groupData(secretLead, title: 'Secret')),
          inProject(phone, groupData(phoneLead, title: 'Điện thoại')),
          inProject(old, {
            ...groupData(oldLead, title: 'Old'),
            'archived': true,
          }),
          groupData('g-private', title: 'Their chat', audience: [other]),
          buddyChatData(buddyChat, agentIds: ['agent-wren']),
          buddyChatData('buddy-other', owner: other, agentIds: ['agent-ivy']),
          inProject(web, {...buddyChatData('buddy-me-web'), 'archived': true}),
        ],
      ),
      'members': [
        part(me, 1, person(me, role: role)),
        part(other, 1, person(other, role: 'collaborator')),
      ],
    };
    fake.routes['/api/super-tabs/$tabId/changes'] = (_) =>
        changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tabId/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tabId/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tabId/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      if (command['type'] == 'message.send') {
        final chat = command['conversationId'] as String;
        final list = posted.putIfAbsent('$tabId/$chat', () => []);
        list.add({
          'id': 'posted-${list.length + 1}',
          'conversationId': chat,
          'text': command['text'],
          'sequence': list.length + 1,
          'author': {'kind': 'person', 'id': me, 'name': 'tony'},
          'attachments': <Object>[],
          'reactions': <Object>[],
          'createdAt': DateTime.utc(2026, 10, 30, 1).toIso8601String(),
        });
      }
      return {'result': <String, dynamic>{}};
    };
    for (final chat in [
      leadChat,
      webLead,
      teamLead,
      phoneLead,
      buddyChat,
      'g-private',
    ]) {
      messagesOf(fake, tabId, chat);
    }
  }

  FakeSwarm backend({String role = 'owner', bool twoSwarms = false}) {
    posted = {};
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        if (twoSwarms) {'id': lab, 'name': 'Lab Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    serve(fake, role: role);
    if (twoSwarms) {
      serve(
        fake,
        tabId: lab,
        name: 'Lab Swarm',
        projects: [projectRow(project, 'Mobile', leadChat)],
      );
    }
    return fake;
  }

  late ValueNotifier<String?> account;

  /// Swarm Home as the root of its own stack, Swarm on, on an iPhone's
  /// screen, 390 points wide.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    SwarmUpload upload = refuseSwarmUpload,
    VoiceInputController Function()? voice,
    SwarmDictation? dictation,
    ValueListenable<bool>? out,
    bool settle = true,
    Size size = const Size(390, 844),
  }) async {
    tester.view.physicalSize = size * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
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
      voice: voice,
      dictation: dictation,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(
          notifier: host,
          child: out == null
              ? child!
              : ValueListenableBuilder(
                  valueListenable: out,
                  builder: (_, hidden, _) =>
                      OutOfSight(hidden: hidden, child: child!),
                ),
        ),
        onGenerateRoute: (_) =>
            CupertinoPageRoute<void>(builder: (_) => const SwarmPage()),
      ),
    );
    settle ? await tester.pumpAndSettle() : await tester.pump();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder row(String chat, {String swarm = tab}) =>
      key('swarm-new-message-$swarm-$chat');
  Finder inside(Finder of, Finder matching) =>
      find.descendant(of: of, matching: matching);
  double y(WidgetTester tester, Finder finder) => tester.getTopLeft(finder).dy;

  Future<void> open(WidgetTester tester) async {
    await tester.tap(key('swarm-new-message'));
    await tester.pumpAndSettle();
  }

  Future<void> write(WidgetTester tester, String text) async {
    await tester.enterText(
      inside(key('swarm-new-message-field'), find.byType(TextField)),
      text,
    );
    await tester.pump();
  }

  String field(WidgetTester tester) => tester
      .widget<TextField>(
        inside(key('swarm-new-message-field'), find.byType(TextField)),
      )
      .controller!
      .text;

  /// The messages sent, as the backend took them.
  List<Map<String, dynamic>> sends(FakeSwarm fake) => [
    for (final call in fake.calls)
      if (call.method == 'POST' &&
          call.path.endsWith('/commands') &&
          call.body?['command']?['type'] == 'message.send')
        call.body!,
  ];

  bool sheetOpen() => find.byType(SwarmNewMessageSheet).evaluate().isNotEmpty;

  group('Home', () {
    testWidgets('has no compose in its header; the + floats at its bottom '
        'right, 56 points round, in the accent, said as New message', (
      tester,
    ) async {
      await pump(tester, backend());

      expect(key('swarm-compose'), findsNothing);
      expect(tester.getSize(key('swarm-new-message')), const Size(56, 56));
      final corner = tester.getBottomRight(key('swarm-new-message'));
      expect(corner.dx, closeTo(390 - 16, 0.5), reason: '16 in from the side');
      expect(corner.dy, closeTo(844 - 16, 0.5), reason: '16 up from the foot');
      expect(
        tester
            .widget<Material>(
              inside(key('swarm-new-message'), find.byType(Material)),
            )
            .color,
        AppPalette.accent,
      );
      expect(find.bySemanticsLabel('New message'), findsOneWidget);
    });

    testWidgets("the + clears Home's last row once scrolled to the end", (
      tester,
    ) async {
      final fake = backend();
      // More projects than a screen holds.
      serve(
        fake,
        projects: [
          ...readable,
          for (var i = 0; i < 16; i++)
            projectRow('p-$i', 'Project $i', 'lead-p-$i'),
        ],
      );
      await pump(tester, fake);
      await tester.drag(find.byType(ListView).first, const Offset(0, -2000));
      await tester.pumpAndSettle();

      final position = tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position;
      expect(position.pixels, position.maxScrollExtent, reason: 'at its end');
      // Home's last row, whatever it is: it ends above the +.
      final list = tester.renderObject<RenderSliverMultiBoxAdaptor>(
        find.descendant(
          of: find.byType(ListView).first,
          matching: find.byType(SliverList),
        ),
      );
      final last = list.lastChild!;
      expect(
        last.localToGlobal(Offset(0, last.size.height)).dy,
        lessThan(tester.getTopLeft(key('swarm-new-message')).dy),
      );
    });

    testWidgets('a second tap on + before New message is up opens no second '
        'sheet', (tester) async {
      await pump(tester, backend());
      final plus = tester.widget<SwarmNewMessageButton>(
        key('swarm-new-message'),
      );
      plus.onPressed();
      plus.onPressed();
      await tester.pumpAndSettle();

      expect(find.byType(SwarmNewMessageSheet), findsOneWidget);
    });
  });

  group('the sheet', () {
    testWidgets('has ✕, its title and To:, and lists only the chats the '
        'person may post in: the project chats they read, then their own '
        'Buddy chat; never another person\'s Buddy chat, a private chat, an '
        'archived chat or a project they cannot read', (tester) async {
      await pump(tester, backend());
      await open(tester);

      expect(find.text('New message'), findsOneWidget);
      expect(find.text('To:'), findsOneWidget);
      expect(find.text('Search projects and chats'), findsOneWidget);
      for (final k in ['swarm-new-message-close', 'swarm-new-message-send']) {
        expect(tester.getSize(key(k)).height, greaterThanOrEqualTo(44));
      }
      final order = [phoneLead, leadChat, teamLead, webLead, buddyChat];
      for (final chat in order) {
        expect(row(chat), findsOneWidget, reason: chat);
        expect(tester.getSize(row(chat)).height, greaterThanOrEqualTo(44));
      }
      for (var i = 1; i < order.length; i++) {
        expect(
          y(tester, row(order[i - 1])),
          lessThan(y(tester, row(order[i]))),
        );
      }
      expect(inside(row(leadChat), find.text('#Mobile')), findsOneWidget);
      expect(inside(row(phoneLead), find.text('#Điện thoại')), findsOneWidget);
      expect(
        inside(row(buddyChat), find.text('Wren · Mobile')),
        findsOneWidget,
      );
      expect(
        inside(row(leadChat), find.text('Phone Swarm')),
        findsNothing,
        reason: 'one Swarm: its name is not on each row',
      );
      for (final chat in [
        secretLead,
        oldLead,
        'buddy-other',
        'g-private',
        'buddy-me-web',
      ]) {
        expect(row(chat), findsNothing, reason: chat);
      }
      for (final text in ['#Secret', '#Old', 'Ivy · Mobile', 'Their chat']) {
        expect(
          inside(find.byType(SwarmNewMessageSheet), find.textContaining(text)),
          findsNothing,
          reason: text,
        );
      }
      expect(key('swarm-new-message-picked'), findsNothing);
    });

    testWidgets('✕ closes it, and Home is as it was', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await open(tester);
      await tester.tap(row(webLead));
      await write(tester, 'Never sent');
      await tester.tap(key('swarm-new-message-close'));
      await tester.pumpAndSettle();

      expect(sheetOpen(), isFalse);
      expect(key('swarm-title-button'), findsOneWidget);
      expect(sends(fake), isEmpty);
    });

    testWidgets('To: narrows the chats by name, case and accents aside', (
      tester,
    ) async {
      await pump(tester, backend());
      await open(tester);

      Future<List<String>> shown(String query) async {
        await tester.enterText(key('swarm-new-message-to'), query);
        await tester.pump();
        return [
          for (final chat in [
            phoneLead,
            leadChat,
            teamLead,
            webLead,
            buddyChat,
          ])
            if (row(chat).evaluate().isNotEmpty) chat,
        ];
      }

      expect(await shown('WE'), [webLead]);
      expect(await shown('dien'), [phoneLead]);
      expect(await shown('ĐIỆN THOẠI'), [phoneLead]);
      expect(await shown('thoai'), [phoneLead]);
      expect(await shown('WREN'), [buddyChat]);
      expect(await shown('#mob'), [leadChat]);
      expect(await shown('mob'), [leadChat, buddyChat]);
      expect(await shown('nothing like it'), isEmpty);
      expect(
        tester.widget<Text>(key('swarm-new-message-none')).data,
        'No chat matches.',
      );
    });

    testWidgets('picking a chat picks it; picking another moves the pick, '
        'one at a time, and the box says where it goes', (tester) async {
      await pump(tester, backend());
      await open(tester);
      expect(
        tester
            .widget<TextField>(
              inside(key('swarm-new-message-field'), find.byType(TextField)),
            )
            .decoration!
            .hintText,
        'Write a message…',
      );

      await tester.tap(row(leadChat));
      await tester.pump();
      expect(inside(row(leadChat), key('swarm-new-message-picked')), findsOne);
      expect(
        tester.getSemantics(row(leadChat)),
        isSemantics(
          label: '#Mobile',
          isButton: true,
          isSelected: true,
          isInMutuallyExclusiveGroup: true,
        ),
      );

      await tester.tap(row(buddyChat));
      await tester.pump();
      expect(key('swarm-new-message-picked'), findsOneWidget);
      expect(inside(row(buddyChat), key('swarm-new-message-picked')), findsOne);
      expect(
        tester
            .widget<TextField>(
              inside(key('swarm-new-message-field'), find.byType(TextField)),
            )
            .decoration!
            .hintText,
        'Message Wren · Mobile',
      );
    });

    testWidgets('on a small phone with the keyboard up, ✕, To: and the '
        'chats scroll above the composer: a five-line draft and a refusal '
        'fit, Send stays above the keyboard, and ✕ is a scroll away', (
      tester,
    ) async {
      final fake = backend();
      fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw const SuperTabFailure(
            'INVALID',
            'This chat takes no new messages.',
            statusCode: 400,
          );
      await pump(tester, fake, size: const Size(320, 568));
      await open(tester);
      await tester.tap(row(webLead));
      await tester.pump();

      const keyboard = 260.0;
      tester.view.viewInsets = const FakeViewPadding(bottom: keyboard * 3);
      await tester.pumpAndSettle();
      await write(tester, 'one\ntwo\nthree\nfour\nfive');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull, reason: 'nothing overflows');
      expect(key('swarm-new-message-error'), findsOneWidget);
      expect(field(tester), 'one\ntwo\nthree\nfour\nfive');
      const above = 568 - keyboard;
      final send = tester.getRect(key('swarm-new-message-send'));
      expect(send.bottom, lessThanOrEqualTo(above), reason: 'above the keys');
      expect(send.height, greaterThanOrEqualTo(44));
      expect(
        tester.getRect(key('swarm-new-message-error')).bottom,
        lessThanOrEqualTo(above),
      );
      expect(
        tester.getRect(key('swarm-new-message-field')).top,
        greaterThanOrEqualTo(0),
        reason: 'the whole draft on screen',
      );

      await tester.ensureVisible(key('swarm-new-message-close'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-new-message-close'));
      await tester.pumpAndSettle();
      expect(sheetOpen(), isFalse);
    });

    testWidgets('Send waits for a pick and for words', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await open(tester);
      bool sendable() =>
          tester
              .widget<SwarmRoundButton>(key('swarm-new-message-send'))
              .onTap !=
          null;

      await write(tester, 'Where does it go?');
      expect(sendable(), isFalse, reason: 'no chat picked');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();
      expect(sends(fake), isEmpty, reason: 'no chat picked');

      await write(tester, '   ');
      await tester.tap(row(webLead));
      await tester.pump();
      expect(sendable(), isFalse, reason: 'nothing to say');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();
      expect(sends(fake), isEmpty, reason: 'nothing to say');
      expect(sheetOpen(), isTrue);

      await write(tester, 'Now');
      expect(sendable(), isTrue);
    });
  });

  group('Send', () {
    testWidgets('posts once to the project chat picked, however often it '
        'is tapped, then the sheet closes and the chat opens at its foot '
        'with the message in it, read through it', (tester) async {
      final fake = backend();
      // River wrote in Web before; the person has not read it.
      posted['$tab/$webLead'] = [
        {
          'id': 'river-1',
          'conversationId': webLead,
          'text': 'Deploy is green.',
          'sequence': 1,
          'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
          'createdAt': DateTime.utc(2026, 10, 30).toIso8601String(),
        },
      ];
      final take = fake.routes['/api/super-tabs/$tab/commands']!;
      final answer = Completer<void>();
      fake.routes['/api/super-tabs/$tab/commands'] = (body) async {
        await answer.future;
        return take(body);
      };
      await pump(tester, fake);
      await open(tester);
      await tester.tap(row(webLead));
      await write(tester, 'Ship it tonight');

      await tester.tap(key('swarm-new-message-send'));
      await tester.pump();
      expect(key('swarm-new-message-sending'), findsOneWidget);
      await tester.tap(key('swarm-new-message-send'));
      await tester.pump();
      await tester.tap(row(leadChat), warnIfMissed: false);
      await tester.pump();
      expect(
        inside(row(webLead), key('swarm-new-message-picked')),
        findsOne,
        reason: 'the pick holds while the post is on its way',
      );
      answer.complete();
      await tester.pumpAndSettle();

      final sent = sends(fake);
      expect(sent, hasLength(1));
      expect(sent.single['command'], {
        'type': 'message.send',
        'conversationId': webLead,
        'text': 'Ship it tonight',
        'replyTo': null,
        'recipientIds': <String>[],
      });
      expect(sheetOpen(), isFalse);
      final page = tester.widget<SwarmProjectPage>(
        find.byType(SwarmProjectPage),
      );
      expect((page.swarmId, page.projectId), (tab, web));
      expectHomeCProject('Web');
      expect(find.text('Deploy is green.'), findsOneWidget);
      expect(find.text('Ship it tonight'), findsOneWidget);
      expect(
        key('swarm-new-messages-line'),
        findsNothing,
        reason: 'read through the post: the chat opens at its foot',
      );
    });

    testWidgets('to their own Buddy chat posts there and opens it', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake);
      await open(tester);
      await tester.tap(row(buddyChat));
      await write(tester, 'Wren, look at the logs');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();

      expect(sends(fake).single['command']['conversationId'], buddyChat);
      expect(sheetOpen(), isFalse);
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, buddyChat));
      expect(find.text('Wren, look at the logs'), findsOneWidget);
    });

    testWidgets('refused, it keeps the text in the sheet with the reason and '
        'opens nothing; sent again, it is a new post', (tester) async {
      final fake = backend();
      final take = fake.routes['/api/super-tabs/$tab/commands']!;
      var refuse = true;
      fake.routes['/api/super-tabs/$tab/commands'] = (body) {
        if (refuse) {
          throw SuperTabFailure(
            'INVALID',
            'This chat takes no messages now.',
            statusCode: 400,
          );
        }
        return take(body);
      };
      await pump(tester, fake);
      await open(tester);
      await tester.tap(row(webLead));
      await write(tester, 'Hello Web');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();

      expect(sheetOpen(), isTrue);
      expect(
        tester.widget<Text>(key('swarm-new-message-error')).data,
        'This chat takes no messages now.',
      );
      expect(field(tester), 'Hello Web');
      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(key('swarm-new-message-picked'), findsOneWidget);

      refuse = false;
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();
      final sent = sends(fake);
      expect(sent, hasLength(2));
      expect(
        sent[1]['operationId'],
        isNot(sent[0]['operationId']),
        reason: 'the refused post made no change: this one is new',
      );
      expect(sheetOpen(), isFalse);
      expectHomeCProject('Web');
    });

    testWidgets('an answer that never came keeps the chat and the text, and '
        'Send sends the same post again, under the same operation id', (
      tester,
    ) async {
      final fake = backend();
      final take = fake.routes['/api/super-tabs/$tab/commands']!;
      var lost = true;
      fake.routes['/api/super-tabs/$tab/commands'] = (body) {
        if (lost) throw StateError('connection reset');
        return take(body);
      };
      await pump(tester, fake);
      await open(tester);
      await tester.tap(row(webLead));
      await write(tester, 'Did this go?');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();

      expect(sheetOpen(), isTrue);
      expect(
        tester.widget<Text>(key('swarm-new-message-error')).data,
        'Your message was not sent. Retry to check it.',
      );
      expect(field(tester), 'Did this go?');
      await tester.tap(row(leadChat), warnIfMissed: false);
      await tester.pump();
      expect(
        inside(row(webLead), key('swarm-new-message-picked')),
        findsOne,
        reason: 'it may have gone there: the pick holds',
      );

      lost = false;
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();
      final sent = sends(fake);
      expect(sent, hasLength(2));
      expect(sent[1]['operationId'], sent[0]['operationId']);
      expect(sent[1]['command']['text'], 'Did this go?');
      expect(posted['$tab/$webLead'], hasLength(1));
      expectHomeCProject('Web');
    });

    testWidgets('+ attaches files, which go up to the chat picked and with '
        'its message', (tester) async {
      final uploads = FakeUploads();
      final fake = backend();
      pickSwarmFiles = () async => [
        XFile.fromData(
          Uint8List.fromList([1, 2, 3]),
          name: 'build.log',
          path: '/copies/build.log',
        ),
      ];
      await pump(tester, fake, upload: uploads.upload);
      await open(tester);
      await tester.tap(row(webLead));
      await tester.tap(key('swarm-new-message-attach'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-attach-files'));
      await tester.pumpAndSettle();
      expect(key('swarm-outgoing-build.log'), findsOneWidget);

      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();

      expect(uploads.names, ['build.log']);
      expect(uploads.asked.single.conversationId, webLead);
      expect(sends(fake).single['command']['attachmentIds'], ['id-build.log']);
      expect(sheetOpen(), isFalse);
    });

    testWidgets('the mic writes into the box, and its second tap sends to '
        'the chat picked', (tester) async {
      final dictation = _Dictation();
      final fake = backend();
      await pump(
        tester,
        fake,
        voice: () => VoiceInputController(
          transcriber: FakeTranscriber().call,
          recorder: FakeVoiceRecorder(),
          language: ValueNotifier('vi'),
        ),
        dictation: dictation,
      );
      await open(tester);
      await tester.tap(row(leadChat));
      await tester.pump();

      await tester.tap(
        inside(find.byType(SwarmNewMessageSheet), key('swarm-mic')),
      );
      for (var i = 0; i < 5; i++) {
        await tester.pump();
      }
      dictation.say('Mai họp lúc 9 giờ');
      await tester.pump();
      expect(field(tester), 'Mai họp lúc 9 giờ');

      await tester.tap(
        inside(find.byType(SwarmNewMessageSheet), key('swarm-mic')),
      );
      await tester.pumpAndSettle();
      expect(sends(fake).single['command']['text'], 'Mai họp lúc 9 giờ');
      expect(sends(fake).single['command']['conversationId'], leadChat);
      expect(sheetOpen(), isFalse);
    });

    testWidgets('taken while Home is out of sight, it opens nothing, and the '
        'chat is read through the post, as posting in it reads it: Home '
        'shows no news of what the person wrote', (tester) async {
      final fake = backend();
      final take = fake.routes['/api/super-tabs/$tab/commands']!;
      final answer = Completer<void>();
      fake.routes['/api/super-tabs/$tab/commands'] = (body) async {
        await answer.future;
        return take(body);
      };
      // The read after the post brings Web's chat at the post.
      var version = 1;
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c${++version}',
        groups: [
          part(
            webLead,
            version,
            inProject(
              web,
              groupData(
                webLead,
                title: 'Web',
                lastMessageSequence: posted['$tab/$webLead']?.length ?? 0,
              ),
            ),
          ),
        ],
      );
      final out = ValueNotifier(false);
      addTearDown(out.dispose);
      final host = await pump(tester, fake, out: out);
      await open(tester);
      await tester.tap(row(webLead));
      await write(tester, 'Posted on the way out');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pump();

      out.value = true;
      await tester.pump();
      answer.complete();
      await tester.pumpAndSettle();

      expect(sends(fake), hasLength(1));
      expect(sheetOpen(), isFalse);
      expect(find.byType(SwarmProjectPage), findsNothing, reason: 'unseen');
      final reader = host.session!.inbox.reader(tab)!;
      expect(reader.snapshot!.conversation(webLead)!.mainSequence, 1);
      expect(reader.readMarks!.readThrough(webLead), 1);
      expect(
        reader.readMarks!.unread(reader.snapshot!.conversation(webLead)!),
        isFalse,
      );
    });
  });

  group('access lost', () {
    /// The Swarm's next read refused, as for a person taken out of it.
    Future<void> refuse(
      WidgetTester tester,
      FakeSwarm fake,
      SwarmHost host,
    ) async {
      for (final route in ['parts', 'changes']) {
        fake.routes['/api/super-tabs/$tab/$route'] = (_) =>
            throw SuperTabFailure('FORBIDDEN', 'No access.', statusCode: 403);
      }
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();
    }

    testWidgets("the Swarm's read taken away closes the sheet with all it "
        'held', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await open(tester);
      await tester.tap(row(webLead));
      await write(tester, 'Secret plans');

      await refuse(tester, fake, host);

      expect(sheetOpen(), isFalse);
      expect(find.text('Secret plans'), findsNothing);
      expect(find.text('#Web'), findsNothing);
      expect(sends(fake), isEmpty);
    });

    testWidgets('the Swarm leaving the list closes the sheet, picked or not', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await open(tester);

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      unawaited(host.session!.inbox.refresh());
      await tester.pumpAndSettle();

      expect(sheetOpen(), isFalse);
      expect(find.text('#Mobile'), findsNothing);
    });

    testWidgets('signing out closes the sheet', (tester) async {
      await pump(tester, backend());
      await open(tester);
      await tester.tap(row(leadChat));
      await write(tester, 'Half written');

      account.value = null;
      await tester.pumpAndSettle();

      expect(sheetOpen(), isFalse);
      expect(find.text('Half written'), findsNothing);
    });

    testWidgets('the chat picked leaving the list closes the sheet; another '
        'leaving only leaves the list', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await open(tester);
      await tester.tap(row(teamLead));
      await tester.pump();

      // Web goes: the pick, Team, stays.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'head': part(
          'head',
          2,
          headData(
            projects: [
              for (final p in readable)
                if (p['id'] != web) p,
            ],
          ),
        ),
      };
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();
      expect(sheetOpen(), isTrue);
      expect(row(webLead), findsNothing);
      expect(inside(row(teamLead), key('swarm-new-message-picked')), findsOne);

      // The person is taken out of Team, the private project picked.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c4'),
        'head': part(
          'head',
          3,
          headData(
            projects: [
              for (final p in readable)
                if (p['id'] != web && p['id'] != team) p,
              projectRow(team, 'Team', teamLead, private: true, owner: other),
            ],
          ),
        ),
      };
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();
      expect(sheetOpen(), isFalse);
    });

    testWidgets('a post on its way when access goes opens nothing once its '
        'answer comes', (tester) async {
      final fake = backend();
      final take = fake.routes['/api/super-tabs/$tab/commands']!;
      final answer = Completer<void>();
      fake.routes['/api/super-tabs/$tab/commands'] = (body) async {
        await answer.future;
        return take(body);
      };
      final host = await pump(tester, fake);
      await open(tester);
      await tester.tap(row(webLead));
      await write(tester, 'Racing the revoke');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pump();

      await refuse(tester, fake, host);
      expect(sheetOpen(), isFalse);
      answer.complete();
      await tester.pumpAndSettle();

      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(find.byType(SwarmConversationPage), findsNothing);
      expect(key('swarm-title-button'), findsOneWidget, reason: 'Home');
    });

    testWidgets('access lost while a post with a file is out: its refusal, '
        'once it comes, changes nothing and throws nothing', (tester) async {
      final uploads = FakeUploads();
      final fake = backend();
      final answer = Completer<void>();
      fake.routes['/api/super-tabs/$tab/commands'] = (_) async {
        await answer.future;
        throw const SuperTabFailure(
          'FORBIDDEN',
          'You can no longer post in this chat.',
          statusCode: 403,
        );
      };
      pickSwarmFiles = () async => [
        XFile.fromData(
          Uint8List.fromList([1, 2, 3]),
          name: 'build.log',
          path: '/copies/build.log',
        ),
      ];
      final host = await pump(tester, fake, upload: uploads.upload);
      await open(tester);
      await tester.tap(row(webLead));
      await tester.tap(key('swarm-new-message-attach'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-attach-files'));
      await tester.pumpAndSettle();
      await write(tester, 'With the log');
      await tester.tap(key('swarm-new-message-send'));
      for (var i = 0; i < 5; i++) {
        await tester.pump();
      }
      expect(sends(fake), hasLength(1), reason: 'the post is out');

      await refuse(tester, fake, host);
      expect(sheetOpen(), isFalse);
      answer.complete();
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(find.text('You can no longer post in this chat.'), findsNothing);
    });

    testWidgets('closed while its post is on its way, the answer opens '
        'nothing', (tester) async {
      final fake = backend();
      final take = fake.routes['/api/super-tabs/$tab/commands']!;
      final answer = Completer<void>();
      fake.routes['/api/super-tabs/$tab/commands'] = (body) async {
        await answer.future;
        return take(body);
      };
      await pump(tester, fake);
      await open(tester);
      await tester.tap(row(webLead));
      await write(tester, 'Gone before the answer');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pump();
      await tester.tap(key('swarm-new-message-close'));
      await tester.pumpAndSettle();
      expect(sheetOpen(), isFalse);

      answer.complete();
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(key('swarm-title-button'), findsOneWidget);
    });
  });

  group('reads', () {
    testWidgets('a Swarm that could not be read says so, never no chat, '
        'with no skeleton left; read again, its chats are there', (
      tester,
    ) async {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw SuperTabFailure('INTERNAL', 'Broken', statusCode: 500);
      final host = await pump(tester, fake);
      expect(key('swarm-new-message'), findsOneWidget);
      await open(tester);

      expect(key('swarm-new-message-loading'), findsNothing);
      expect(key('swarm-new-message-none'), findsNothing);
      expect(
        tester.widget<Text>(key('swarm-new-message-unread')).data,
        'Some chats could not be loaded. Pull down on Home to try again.',
      );

      fake.routes['/api/super-tabs/$tab/parts'] = load;
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();

      expect(key('swarm-new-message-unread'), findsNothing);
      expect(row(webLead), findsOneWidget);
    });

    testWidgets('a Swarm still being read shows rows on their way', (
      tester,
    ) async {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      final first = Completer<void>();
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        await first.future;
        return load(body);
      };
      await pump(tester, fake, settle: false);
      await tester.tap(key('swarm-new-message'));
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(key('swarm-new-message-loading'), findsOneWidget);

      first.complete();
      await tester.pumpAndSettle();
      expect(key('swarm-new-message-loading'), findsNothing);
      expect(row(leadChat), findsOneWidget);
    });

    testWidgets('a viewer is told they can read, not post, and nothing is '
        'listed', (tester) async {
      await pump(tester, backend(role: 'viewer'));
      await open(tester);

      expect(
        tester.widget<Text>(key('swarm-new-message-read-only')).data,
        'You can read these Swarms, not post in them.',
      );
      expect(row(leadChat), findsNothing);
    });

    testWidgets("with two Swarms, each row names its Swarm; the same ids in "
        'both are two chats, and each posts to its own Swarm', (tester) async {
      final fake = backend(twoSwarms: true);
      await pump(tester, fake);
      await open(tester);

      expect(row(leadChat), findsOneWidget);
      expect(row(leadChat, swarm: lab), findsOneWidget);
      expect(inside(row(leadChat), find.text('Phone Swarm')), findsOneWidget);
      expect(
        inside(row(leadChat, swarm: lab), find.text('Lab Swarm')),
        findsOneWidget,
      );
      expect(row(buddyChat, swarm: lab), findsOneWidget);

      await tester.tap(row(leadChat, swarm: lab));
      await tester.pump();
      expect(key('swarm-new-message-picked'), findsOneWidget);
      await write(tester, 'To the lab');
      await tester.tap(key('swarm-new-message-send'));
      await tester.pumpAndSettle();

      final sent = [
        for (final call in fake.calls)
          if (call.method == 'POST' && call.path.endsWith('/commands')) call,
      ];
      expect(sent.single.path, '/api/super-tabs/$lab/commands');
      expect(posted['$tab/$leadChat'], isNull);
      final page = tester.widget<SwarmProjectPage>(
        find.byType(SwarmProjectPage),
      );
      expect((page.swarmId, page.projectId), (lab, project));
    });
  });

  test('swarmSearchFold folds case and accents however they were composed', () {
    expect(swarmSearchFold('Điện Thoại'), 'dien thoai');
    // Decomposed: e + circumflex + dot below, as some keyboards send it.
    expect(swarmSearchFold('\u0110ie\u0302\u0323n'), 'dien');
    expect(swarmSearchFold('Mobile'), 'mobile');
    expect(swarmSearchFold('Œuvre'), 'œuvre', reason: 'no accent to fold');
  });
}

/// The phone's own recognizer, spoken for by the test.
class _Dictation implements SwarmDictation {
  void Function(String)? _words;
  void Function(SwarmDictationEnd)? _end;

  void say(String words) => _words?.call(words);

  @override
  Future<SwarmDictationAccess> access() async => SwarmDictationAccess.allowed;

  @override
  Future<bool> start(
    String locale, {
    required void Function(String words) onWords,
    required void Function(double level) onLevel,
    required void Function(SwarmDictationEnd end) onEnd,
  }) async {
    _words = onWords;
    _end = onEnd;
    return true;
  }

  @override
  Future<void> stop() async {
    final end = _end;
    _words = _end = null;
    end?.call(SwarmDictationEnd.done);
  }

  @override
  Future<void> cancel() async => _words = _end = null;
}
