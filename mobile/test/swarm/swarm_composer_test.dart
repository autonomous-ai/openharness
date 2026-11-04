import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppPalette;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:image_picker/image_picker.dart' show XFile;
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The composer card (Tony, 11-01): the X that clears the text, the @
/// button, and the card's layout on the chat and in a thread — with the
/// keyboard up, on a 320pt phone, with files and a reply.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String text = 'Which name for the flag?',
    String author = 'agent-builder',
    String? thread,
    String? replyTo,
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'thread': ?thread,
    'replyTo': ?replyTo,
    'author': {
      'kind': 'agent',
      'id': author,
      'name': author == 'agent-lead' ? 'River' : 'Nova',
    },
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 11, 1, 1, sequence).toIso8601String(),
  };

  /// Chat g1 with River and Nova in it (or [agentIds]), reading [page], with
  /// [members] in its Swarm and the line of a thread under m1 if [threads].
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    List<String> agentIds = const ['agent-lead', 'agent-builder'],
    List<Map<String, dynamic>>? members,
    bool threads = false,
  }) {
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
            agentIds: agentIds,
            status: 'working',
            lastMessageSequence: page.length,
          ),
        ],
      ),
      'members': [
        for (final member in members ?? [person(me)])
          part(member['id'] as String, 1, member),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    final line = {
      'id': 'm1',
      'replies': 1,
      'lastSequence': 2,
      'lastAt': DateTime.now().toUtc().toIso8601String(),
      'authors': [
        {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
      ],
      'people': <String>[],
    };
    fake.routes[messages] = (_) => {
      'messages': [
        for (final m in page.reversed)
          if (m['thread'] == null || m['id'] == m['thread']) m,
      ],
      'next': null,
      'threads': [if (threads) line],
    };
    fake.routes['$messages?thread=m1'] = (_) => {
      'messages': [
        for (final m in page.reversed)
          if (m['thread'] == 'm1') m,
      ],
      'next': null,
      'threads': [if (threads) line],
    };
    fake.routes[commands] = (_) => {'result': <String, dynamic>{}};
    return fake;
  }

  /// An upload answered at once.
  Future<Map<String, dynamic>> uploaded({
    required String tabId,
    required String conversationId,
    required String name,
    required String mime,
    required SwarmOutgoingFile file,
    required dynamic cancel,
    required void Function(double sent) onProgress,
  }) async => {
    'attachment': {
      'id': 'f-$name',
      'name': name,
      'mime': mime,
      'size': 12,
      'url': 'https://cdn.harness.autonomous.ai/f/$name',
    },
  };

  final picker = (documents: pickSwarmFiles, copies: swarmPickerCopyFolders);
  setUp(() {
    swarmPickerCopyFolders = () async => const [];
    pickSwarmFiles = () async => [
      XFile.fromData(Uint8List(12), path: '/copies/crash.log', length: 12),
    ];
  });
  tearDown(() {
    swarmPickerCopyFolders = picker.copies;
    pickSwarmFiles = picker.documents;
  });

  /// A [width] x [height] phone, with a keyboard [keyboard] tall up.
  void phone(
    WidgetTester tester, {
    double width = 393,
    double height = 852,
    double keyboard = 0,
  }) {
    tester.view.devicePixelRatio = 3;
    tester.view.physicalSize = Size(width * 3, height * 3);
    tester.view.padding = FakeViewPadding(
      top: 59 * 3,
      bottom: keyboard > 0 ? 0 : 34 * 3,
    );
    tester.view.viewPadding = const FakeViewPadding(
      top: 59 * 3,
      bottom: 34 * 3,
    );
    tester.view.viewInsets = FakeViewPadding(bottom: keyboard * 3);
    addTearDown(tester.view.reset);
  }

  /// Chat g1 on screen; with [shell], in a navigator under an outer Scaffold
  /// as the phone's shell puts every page, a thread pushed over it too (it
  /// takes the keyboard's inset out for its body).
  late ValueNotifier<String?> account;

  /// The microphone and the transcriber of the last [pump] with a voice.
  late FakeVoiceRecorder recorder;
  late FakeTranscriber stt;

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    bool shell = false,
    bool voice = false,
    SwarmUpload upload = refuseSwarmUpload,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    account = ValueNotifier<String?>(me);
    recorder = FakeVoiceRecorder();
    stt = FakeTranscriber();
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: upload,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
      voice: voice
          ? () => VoiceInputController(
              transcriber: stt.call,
              recorder: recorder,
              language: ValueNotifier('en'),
            )
          : null,
    )..foreground = false;
    addTearDown(host.dispose);
    const page = SwarmConversationPage(swarmId: tab, conversationId: 'g1');
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: shell
            ? Scaffold(
                body: Navigator(
                  onGenerateRoute: (_) =>
                      MaterialPageRoute<void>(builder: (_) => page),
                ),
              )
            : page,
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  TextEditingController field(
    WidgetTester tester, [
    String at = 'swarm-field',
  ]) => tester
      .widget<TextField>(
        find.descendant(of: key(at), matching: find.byType(TextField)),
      )
      .controller!;
  bool focused(WidgetTester tester, [String at = 'swarm-field']) => tester
      .widget<TextField>(
        find.descendant(of: key(at), matching: find.byType(TextField)),
      )
      .focusNode!
      .hasFocus;
  bool sendable(WidgetTester tester, [String send = 'swarm-send']) =>
      tester.widget<SwarmRoundButton>(key(send)).onTap != null;

  /// [text] typed into the field at [at]: focused as the keyboard would be,
  /// with no tap, so no selection handle is left over the toolbar.
  Future<void> type(
    WidgetTester tester,
    String text, [
    String at = 'swarm-field',
  ]) async {
    final input = find.descendant(
      of: key(at),
      matching: find.byType(TextField),
    );
    tester.widget<TextField>(input).focusNode!.requestFocus();
    await tester.pump();
    tester.testTextInput.enterText(text);
    await tester.pump();
    // The test keyboard leaves a caret handle over the toolbar (main does the
    // same); typing on a phone does not. Hidden, so taps reach the chips.
    tester.state<EditableTextState>(find.byType(EditableText)).hideToolbar();
    await tester.pump();
  }

  group('X on the chat', () {
    testWidgets('hidden while the box is empty; shows on the first '
        'character, a space included', (tester) async {
      await pump(tester, backend([message('m1', 1)]));

      expect(key('swarm-field-clear'), findsNothing);
      await type(tester, ' ');
      expect(key('swarm-field-clear'), findsOneWidget);
      expect(tester.getSemantics(key('swarm-field-clear')).label, 'Clear text');
    });

    testWidgets('clears the text only: focus and the keyboard stay, Send goes '
        'off with nothing left to send', (tester) async {
      final fake = backend([message('m1', 1)]);
      await pump(tester, fake);
      await type(tester, 'Ship it');
      expect(sendable(tester), isTrue);

      await tester.tap(key('swarm-field-clear'));
      await tester.pump();

      expect(field(tester).text, '');
      expect(key('swarm-field-clear'), findsNothing);
      expect(focused(tester), isTrue);
      expect(tester.testTextInput.isVisible, isTrue);
      expect(sendable(tester), isFalse);
      expect(fake.commands, isEmpty);
    });

    testWidgets('the reply and the files stay, and Send stays on for the '
        'files', (tester) async {
      final fake = backend([message('m1', 1)]);
      await pump(tester, fake, upload: uploaded);
      await tester.tap(find.text('Which name for the flag?'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-reply-m1'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-attach'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-attach-files'));
      await tester.pumpAndSettle();
      await type(tester, 'The log');

      await tester.tap(key('swarm-field-clear'));
      await tester.pumpAndSettle();

      expect(field(tester).text, '');
      expect(key('swarm-reply-bar'), findsOneWidget);
      expect(key('swarm-outgoing-crash.log'), findsOneWidget);
      expect(sendable(tester), isTrue);
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      expect(fake.commands.single['replyTo'], 'm1');
      expect(fake.commands.single['text'], '');
    });

    testWidgets('a mention cleared with the text goes to nobody', (
      tester,
    ) async {
      final fake = backend([message('m1', 1)]);
      await pump(tester, fake);
      await type(tester, 'ask @N');
      await tester.tap(key('swarm-pick-agent-builder'));
      await tester.pump();
      expect(field(tester).text, 'ask @Nova ');

      await tester.tap(key('swarm-field-clear'));
      await tester.pump();
      await type(tester, 'ship it');
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();

      expect(fake.commands.single['text'], 'ship it');
      expect(fake.commands.single['recipientIds'], anyOf(isNull, isEmpty));
    });

    testWidgets('clearing while a Telex word is still being composed leaves '
        'no stray characters', (tester) async {
      await pump(tester, backend([message('m1', 1)]));
      await tester.showKeyboard(key('swarm-field'));
      // The keyboard composing "Viêt": its marked text still open.
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Kiểm tra Viêt',
          selection: TextSelection.collapsed(offset: 13),
          composing: TextRange(start: 9, end: 13),
        ),
      );
      await tester.pump();

      await tester.tap(key('swarm-field-clear'));
      await tester.pump();

      expect(field(tester).value.text, '');
      expect(field(tester).value.composing, TextRange.empty);
      expect(tester.testTextInput.editingState?['text'], '');
    });

    testWidgets('stays pinned at the top right while the text scrolls', (
      tester,
    ) async {
      phone(tester);
      await pump(tester, backend([message('m1', 1)]));
      await type(tester, 'one');
      final field = tester.getRect(key('swarm-field'));
      final x = tester.getRect(key('swarm-field-clear'));
      expect(x.top - field.top, 1);
      expect(field.right - x.right, 0);

      await type(tester, List.generate(9, (i) => 'line $i').join('\n'));
      final tall = tester.getRect(key('swarm-field'));
      // Five lines of 22 and the field's 14 of padding, then it scrolls.
      expect(tall.height, 5 * 22 + 14);
      expect(tester.getRect(key('swarm-field-clear')).top - tall.top, 1);
      expect(tester.getRect(key('swarm-field-clear')).right, tall.right);
    });
  });

  group('@ on the chat', () {
    testWidgets('on an empty box: an @ that opens the picker, focus in the '
        'field; a second tap takes it back and closes it', (tester) async {
      await pump(tester, backend([message('m1', 1)]));
      expect(key('swarm-tag'), findsOneWidget);
      expect(
        tester.getSemantics(key('swarm-tag')).label,
        'Tag a member or agent',
      );

      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(field(tester).text, '@');
      expect(key('swarm-mention-picker'), findsOneWidget);
      expect(focused(tester), isTrue);
      expect(field(tester).selection, const TextSelection.collapsed(offset: 1));
      // In the accent while the picker is open.
      expect(
        tester
            .widget<Icon>(
              find.descendant(
                of: key('swarm-tag'),
                matching: find.byIcon(LucideIcons.atSign),
              ),
            )
            .color,
        AppPalette.accentOnSurface,
      );

      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(field(tester).text, '');
      expect(key('swarm-mention-picker'), findsNothing);
      expect(
        tester
            .widget<Icon>(
              find.descendant(
                of: key('swarm-tag'),
                matching: find.byIcon(LucideIcons.atSign),
              ),
            )
            .color,
        AppPalette.textSecondary,
      );
    });

    testWidgets('after words, a space before the @; after a space, none', (
      tester,
    ) async {
      await pump(tester, backend([message('m1', 1)]));
      await type(tester, 'ask');
      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(field(tester).text, 'ask @');

      await type(tester, 'ask ');
      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(field(tester).text, 'ask @');

      await type(tester, 'ask\n');
      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(field(tester).text, 'ask\n@');
    });

    testWidgets('a name being typed is left alone', (tester) async {
      await pump(tester, backend([message('m1', 1)]));
      await type(tester, 'ask @No');
      expect(key('swarm-mention-picker'), findsOneWidget);

      await tester.tap(key('swarm-tag'));
      await tester.pump();

      expect(field(tester).text, 'ask @No');
      expect(key('swarm-mention-picker'), findsOneWidget);
    });

    testWidgets('a pick fills the name in, and the post goes to them', (
      tester,
    ) async {
      final fake = backend([message('m1', 1)]);
      await pump(tester, fake);
      await type(tester, 'ask');
      await tester.tap(key('swarm-tag'));
      await tester.pump();
      await tester.tap(key('swarm-pick-agent-builder'));
      await tester.pump();
      expect(field(tester).text, 'ask @Nova ');
      expect(key('swarm-mention-picker'), findsNothing);

      await type(tester, 'ask @Nova to look');
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      expect(fake.commands.single['recipientIds'], ['agent-builder']);
    });

    testWidgets('typing an @ opens the same picker, and Tag then takes it '
        'back', (tester) async {
      await pump(tester, backend([message('m1', 1)]));
      await type(tester, 'ask @');
      expect(key('swarm-mention-picker'), findsOneWidget);

      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(field(tester).text, 'ask ');
      expect(key('swarm-mention-picker'), findsNothing);
    });

    testWidgets('the sign alone, no word (Tony, 11-03): a round 36pt face '
        'in a 44pt target, as + is', (tester) async {
      await pump(tester, backend([message('m1', 1)]));

      expect(find.text('Tag'), findsNothing);
      // Still a button a screen reader can press, as the chip was; + and
      // Send too.
      for (final (button, label) in [
        ('swarm-tag', 'Tag a member or agent'),
        ('swarm-attach', 'Attach files'),
      ]) {
        expect(
          tester.getSemantics(key(button)),
          matchesSemantics(
            label: label,
            isButton: true,
            hasEnabledState: true,
            isEnabled: true,
            hasTapAction: true,
          ),
          reason: button,
        );
      }
      await type(tester, 'hi');
      expect(
        tester.getSemantics(key('swarm-send')),
        matchesSemantics(
          label: 'Send',
          isButton: true,
          hasEnabledState: true,
          isEnabled: true,
          hasTapAction: true,
        ),
      );
      expect(tester.getSize(key('swarm-tag')), const Size(44, 44));
      final tag = tester.widget<SwarmRoundButton>(key('swarm-tag'));
      final attach = tester.widget<SwarmRoundButton>(
        find.descendant(
          of: key('swarm-attach'),
          matching: find.byType(SwarmRoundButton),
        ),
      );
      expect(tag.face, 36);
      expect(tag.face, attach.face);
      expect(tag.fill, attach.fill);
    });

    testWidgets('no chip when nobody can be tagged', (tester) async {
      await pump(tester, backend([message('m1', 1)], agentIds: const []));

      expect(key('swarm-field'), findsOneWidget);
      expect(key('swarm-tag'), findsNothing);
    });

    testWidgets('a person alone in the chat is enough for the chip', (
      tester,
    ) async {
      await pump(
        tester,
        backend(
          [message('m1', 1)],
          agentIds: const [],
          members: [
            person(me),
            person('dee', role: 'collaborator'),
          ],
        ),
      );

      expect(key('swarm-tag'), findsOneWidget);
    });
  });

  group('card layout', () {
    testWidgets('one line is a 98pt composer: an 86pt card, text over '
        '+, @, the mic and Send, all 44pt targets with 36pt faces', (
      tester,
    ) async {
      phone(tester);
      await pump(tester, backend([message('m1', 1)]));

      expect(tester.getSize(key('swarm-composer-card')).height, 86);
      expect(tester.getSize(key('swarm-field')).height, 36);
      for (final button in ['swarm-attach', 'swarm-tag', 'swarm-send']) {
        expect(tester.getSize(key(button)), const Size(44, 44));
      }
      final card = tester.getRect(key('swarm-composer-card'));
      final send = tester.getRect(key('swarm-send'));
      final attach = tester.getRect(key('swarm-attach'));
      final tag = tester.getRect(key('swarm-tag'));
      // The toolbar: + then @ at the left, Send at the right, 4 from the foot.
      expect(attach.left - card.left, 1 + 6);
      expect(tag.left, attach.right);
      expect(card.right - send.right, 1 + 6);
      expect(card.bottom - send.bottom, 1 + 4);
      // 8 at the sides, 6 above and below: no hairline, no band of its own.
      expect(card.left, 8);
      expect(tester.view.physicalSize.width / 3 - card.right, 8);
    });

    for (final shell in [false, true]) {
      testWidgets('with the keyboard up the card sits on it, the inset taken '
          'once${shell ? ' under the phone shell\'s Scaffold' : ''}', (
        tester,
      ) async {
        phone(tester, keyboard: 336);
        await pump(tester, backend([message('m1', 1)]), shell: shell);
        await tester.showKeyboard(key('swarm-field'));
        await tester.pump();

        final card = tester.getRect(key('swarm-composer-card'));
        expect(card.bottom, 852 - 336 - 6);
        expect(card.height, 86);
      });
    }

    testWidgets('a 320pt phone with the keyboard up: five lines, files, a '
        'reply and the toolbar fit', (tester) async {
      phone(tester, width: 320, height: 568, keyboard: 253);
      await pump(tester, backend([message('m1', 1)]), upload: uploaded);
      await tester.tap(find.text('Which name for the flag?'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-reply-m1'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-attach'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-attach-files'));
      await tester.pumpAndSettle();
      await type(tester, List.generate(6, (i) => 'line $i').join('\n'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final card = tester.getRect(key('swarm-composer-card'));
      expect(card.bottom, 568 - 253 - 6);
      expect(card.right, lessThanOrEqualTo(320 - 8));
      expect(tester.getRect(key('swarm-send')).right, lessThan(card.right));
      expect(
        tester.getRect(key('swarm-reply-bar')).bottom,
        lessThanOrEqualTo(card.top),
      );
    });
  });

  group('the thread\'s reply box', () {
    Future<void> openThread(WidgetTester tester, FakeSwarm fake) async {
      await pump(tester, fake, upload: uploaded);
      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();
    }

    FakeSwarm threaded() => backend([
      message('m1', 1, author: 'agent-lead', thread: 'm1'),
      message('m2', 2, text: 'Looks good.', thread: 'm1', replyTo: 'm1'),
    ], threads: true);

    testWidgets('the same card: + at the left, then Tag, the mic and Send; '
        'Reply options folded under the card, Also send in it, its label '
        'whole', (tester) async {
      phone(tester);
      await openThread(tester, threaded());

      expect(
        find.descendant(
          of: key('swarm-thread-box'),
          matching: key('swarm-composer-card'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('swarm-thread-box'),
          matching: key('swarm-tag'),
        ),
        findsOneWidget,
      );
      final attach = tester.getRect(key('swarm-thread-attach'));
      final tag = tester.getRect(key('swarm-tag'));
      final send = tester.getRect(key('swarm-thread-send'));
      final card = tester.getRect(key('swarm-composer-card'));
      expect(tag.left, attach.right);
      expect(tester.getSize(key('swarm-tag')).height, 44);
      expect(tag.right, lessThanOrEqualTo(send.left));
      // Folded: one line under the card, a thumb's target.
      expect(key('swarm-thread-also-send'), findsNothing);
      final options = tester.getRect(key('swarm-thread-options'));
      expect(options.top, card.bottom);
      expect(options.height, greaterThanOrEqualTo(44));
      expect(
        tester.widget<Text>(key('swarm-thread-options-label')).data,
        'Reply options',
      );
      await tester.tap(key('swarm-thread-options'));
      await tester.pump();
      final also = tester.getRect(key('swarm-thread-also-send'));
      // Its own line: under Reply options, not squeezed between Tag and Send.
      expect(also.top, tester.getRect(key('swarm-thread-options')).bottom);
      expect(also.height, greaterThanOrEqualTo(44), reason: 'a thumb target');
      final label = tester.renderObject<RenderParagraph>(
        key('swarm-thread-also-send-label'),
      );
      expect(label.didExceedMaxLines, isFalse);
      expect(
        tester.getSize(key('swarm-thread-also-send-label')).height,
        lessThan(30),
        reason: 'one line on a 393pt phone',
      );
      expect(
        (label.text as TextSpan).toPlainText(),
        startsWith('Also send to the'),
      );
    });

    /// A thread long enough to scroll with the keyboard up.
    FakeSwarm long() => backend([
      message('m1', 1, author: 'agent-lead', thread: 'm1'),
      for (var i = 2; i <= 24; i++)
        message('m$i', i, text: 'Reply $i.', thread: 'm1', replyTo: 'm1'),
    ], threads: true);

    testWidgets('a finger scrolling the thread puts the keyboard away; the '
        'draft stays', (tester) async {
      phone(tester, keyboard: 336);
      await openThread(tester, long());
      await type(tester, 'half a thought', 'swarm-thread-field');
      expect(focused(tester, 'swarm-thread-field'), isTrue);

      // Whichever end it opened at, one of the two moves it.
      await tester.drag(key('swarm-thread-messages'), const Offset(0, 200));
      await tester.drag(key('swarm-thread-messages'), const Offset(0, -200));
      await tester.pump();

      expect(focused(tester, 'swarm-thread-field'), isFalse);
      expect(field(tester, 'swarm-thread-field').text, 'half a thought');
    });

    testWidgets('the list moving by itself leaves the keyboard up', (
      tester,
    ) async {
      phone(tester, keyboard: 336);
      await openThread(tester, long());
      await type(tester, 'half a thought', 'swarm-thread-field');

      final list = tester.state<ScrollableState>(
        find.descendant(
          of: key('swarm-thread-messages'),
          matching: find.byType(Scrollable),
        ),
      );
      list.position.jumpTo(0);
      await tester.pump();
      list.position.jumpTo(list.position.maxScrollExtent);
      await tester.pump();

      expect(focused(tester, 'swarm-thread-field'), isTrue);
    });

    testWidgets('its X clears the text only: the files stay, Send stays on '
        'for them, focus stays', (tester) async {
      await openThread(tester, threaded());
      expect(key('swarm-thread-clear'), findsNothing);
      await tester.tap(key('swarm-thread-attach'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-attach-files'));
      await tester.pumpAndSettle();
      await type(tester, 'The log', 'swarm-thread-field');
      expect(key('swarm-thread-clear'), findsOneWidget);

      await tester.tap(key('swarm-thread-clear'));
      await tester.pump();

      expect(field(tester, 'swarm-thread-field').text, '');
      expect(key('swarm-thread-clear'), findsNothing);
      expect(key('swarm-outgoing-crash.log'), findsOneWidget);
      expect(focused(tester, 'swarm-thread-field'), isTrue);
      expect(sendable(tester, 'swarm-thread-send'), isTrue);
    });

    testWidgets('Tag opens the chat\'s picker over the box, focus in the '
        'field; a pick fills the name in and the reply goes to them', (
      tester,
    ) async {
      final fake = threaded();
      await openThread(tester, fake);

      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(field(tester, 'swarm-thread-field').text, '@');
      expect(focused(tester, 'swarm-thread-field'), isTrue);
      expect(
        find.descendant(
          of: key('swarm-thread-box'),
          matching: key('swarm-mention-picker'),
        ),
        findsOneWidget,
      );
      // The chat's agents, with the chat's look.
      expect(key('swarm-pick-agent-lead'), findsOneWidget);
      expect(key('swarm-pick-agent-builder'), findsOneWidget);

      await tester.tap(key('swarm-pick-agent-builder'));
      await tester.pump();
      expect(field(tester, 'swarm-thread-field').text, '@Nova ');
      expect(key('swarm-mention-picker'), findsNothing);

      await type(tester, '@Nova can you look', 'swarm-thread-field');
      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();
      final sent = fake.commands.single;
      expect(sent['replyTo'], 'm1');
      expect(sent['text'], '@Nova can you look');
      expect(sent['recipientIds'], ['agent-builder']);
      expect(sent.containsKey('mentions'), isFalse);
    });

    testWidgets('typing an @ narrows the same picker; a person picked is '
        'tagged', (tester) async {
      final fake = backend(
        [
          message('m1', 1, author: 'agent-lead', thread: 'm1'),
          message('m2', 2, text: 'Looks good.', thread: 'm1', replyTo: 'm1'),
        ],
        threads: true,
        members: [
          person(me),
          person('dee', role: 'collaborator'),
        ],
      );
      await openThread(tester, fake);

      await type(tester, 'thanks @de', 'swarm-thread-field');
      expect(key('swarm-pick-person-dee'), findsOneWidget);
      expect(key('swarm-pick-agent-lead'), findsNothing);
      await tester.tap(key('swarm-pick-person-dee'));
      await tester.pump();
      expect(field(tester, 'swarm-thread-field').text, 'thanks @dee ');

      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();
      expect(fake.commands.single['mentions'], ['dee']);
      expect(fake.commands.single['recipientIds'], isEmpty);
    });

    for (final shell in [false, true]) {
      testWidgets('with the keyboard up and the picker open, the card and '
          'Reply options under it sit on the keyboard and the picker over '
          'the card, the inset taken '
          'once${shell ? ' under the phone shell\'s Scaffold' : ''}', (
        tester,
      ) async {
        phone(tester, keyboard: 336);
        await pump(tester, threaded(), shell: shell, upload: uploaded);
        await tester.tap(key('swarm-thread-line-m1'));
        await tester.pumpAndSettle();
        await type(tester, '@', 'swarm-thread-field');

        expect(tester.takeException(), isNull);
        final card = tester.getRect(
          find.descendant(
            of: key('swarm-thread-box'),
            matching: key('swarm-composer-card'),
          ),
        );
        final picker = tester.getRect(key('swarm-mention-picker'));
        final options = tester.getRect(key('swarm-thread-options'));
        expect(options.bottom, 852 - 336 - 6);
        expect(card.bottom, options.top);
        expect(card.height, 86);
        expect(picker.bottom, lessThanOrEqualTo(card.top));
        expect(
          picker.top,
          greaterThanOrEqualTo(
            tester.getRect(key('swarm-thread-header')).bottom,
          ),
        );
      });
    }

    testWidgets('a 320pt phone with the keyboard up: the picker gives up room '
        'and scrolls, the card and Reply options stay whole on the keyboard', (
      tester,
    ) async {
      phone(tester, width: 320, height: 568, keyboard: 253);
      await openThread(tester, threaded());
      await type(tester, '@', 'swarm-thread-field');
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final card = tester.getRect(
        find.descendant(
          of: key('swarm-thread-box'),
          matching: key('swarm-composer-card'),
        ),
      );
      final picker = tester.getRect(key('swarm-mention-picker'));
      final options = tester.getRect(key('swarm-thread-options'));
      expect(options.bottom, 568 - 253 - 6);
      expect(card.bottom, options.top);
      expect(card.height, 86);
      expect(picker.bottom, lessThanOrEqualTo(card.top));
      expect(
        picker.top,
        greaterThanOrEqualTo(tester.getRect(key('swarm-thread-header')).bottom),
      );
      // Short of room for both agents' 52pt rows, its border and margin: it
      // still shows one whole row, and scrolls to the second.
      expect(picker.height, lessThan(2 * 52 + 2 + 8));
      expect(picker.height, greaterThanOrEqualTo(52 + 2));
      await tester.dragUntilVisible(
        key('swarm-pick-agent-builder'),
        key('swarm-mention-picker'),
        const Offset(0, -40),
      );
      await tester.ensureVisible(key('swarm-pick-agent-builder'));
      await tester.pumpAndSettle();
      final row = tester.getRect(key('swarm-pick-agent-builder'));
      expect(row.top, greaterThanOrEqualTo(picker.top));
      expect(row.bottom, lessThanOrEqualTo(picker.bottom));
      await tester.tap(key('swarm-pick-agent-builder'));
      await tester.pump();
      expect(field(tester, 'swarm-thread-field').text, '@Nova ');
    });

    for (final shell in [false, true]) {
      testWidgets('with the keyboard up, Reply options opened: the card, its '
          'line and Also send stack on the keyboard, the field keeps the '
          'keyboard, the inset taken '
          'once${shell ? ' under the phone shell\'s Scaffold' : ''}', (
        tester,
      ) async {
        phone(tester, keyboard: 336);
        await pump(tester, threaded(), shell: shell, upload: uploaded);
        await tester.tap(key('swarm-thread-line-m1'));
        await tester.pumpAndSettle();
        await type(tester, 'half a thought', 'swarm-thread-field');
        final folded = tester.getRect(
          find.descendant(
            of: key('swarm-thread-box'),
            matching: key('swarm-composer-card'),
          ),
        );

        await tester.tap(key('swarm-thread-options'));
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        expect(focused(tester, 'swarm-thread-field'), isTrue);
        final card = tester.getRect(
          find.descendant(
            of: key('swarm-thread-box'),
            matching: key('swarm-composer-card'),
          ),
        );
        final options = tester.getRect(key('swarm-thread-options'));
        final also = tester.getRect(key('swarm-thread-also-send'));
        expect(also.bottom, 852 - 336 - 6);
        expect(options.bottom, also.top);
        expect(card.bottom, options.top);
        // Opening it lifts the card by Also send's line, no more.
        expect(card.top, folded.top - also.height);
        expect(card.height, folded.height);

        await tester.tap(key('swarm-thread-options'));
        await tester.pumpAndSettle();
        expect(
          tester.getRect(
            find.descendant(
              of: key('swarm-thread-box'),
              matching: key('swarm-composer-card'),
            ),
          ),
          folded,
        );
      });
    }

    testWidgets('a 320pt phone with large text: the toolbar fits a long '
        'Also send label, and Reply options opened scrolls in what is left '
        'rather than overflow', (tester) async {
      phone(tester, width: 320, height: 568, keyboard: 253);
      tester.platformDispatcher.textScaleFactorTestValue = 1.3;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await openThread(tester, threaded());
      await type(tester, 'one more', 'swarm-thread-field');
      await tester.tap(key('swarm-thread-options'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final card = tester.getRect(key('swarm-composer-card'));
      expect(
        tester.getRect(key('swarm-thread-send')).right,
        lessThan(card.right),
      );
      // Large text wraps the label rather than cutting it short.
      expect(
        tester
            .renderObject<RenderParagraph>(key('swarm-thread-also-send-label'))
            .didExceedMaxLines,
        isFalse,
      );
      expect(
        tester.getRect(key('swarm-thread-also-send')).right,
        lessThanOrEqualTo(card.right),
      );
      // The box takes all of the room under the header, no more.
      expect(
        tester.getRect(key('swarm-thread-box')).bottom,
        lessThanOrEqualTo(568 - 253),
      );
      await tester.tap(key('swarm-thread-also-send'));
      await tester.pump();
      expect(
        tester
            .widget<Semantics>(key('swarm-thread-also-send'))
            .properties
            .checked,
        isTrue,
      );
    });

    testWidgets('Reply options opened steps aside while the @ picker is up, '
        'its line saying what is on, and is back after the pick', (
      tester,
    ) async {
      phone(tester, keyboard: 336);
      final fake = threaded();
      await openThread(tester, fake);
      await tester.tap(key('swarm-thread-options'));
      await tester.pump();
      await tester.tap(key('swarm-thread-also-send'));
      await tester.pump();

      await type(tester, '@', 'swarm-thread-field');
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(key('swarm-mention-picker'), findsOneWidget);
      expect(key('swarm-thread-also-send'), findsNothing);
      expect(
        tester.widget<Text>(key('swarm-thread-options-label')).data,
        'Reply options · Also send to the chat',
      );
      // Its line waits for the pick.
      await tester.tap(key('swarm-thread-options'), warnIfMissed: false);
      await tester.pump();
      expect(key('swarm-thread-also-send'), findsNothing);

      await tester.tap(key('swarm-pick-agent-builder'));
      await tester.pumpAndSettle();
      expect(key('swarm-mention-picker'), findsNothing);
      expect(
        tester
            .widget<Semantics>(key('swarm-thread-also-send'))
            .properties
            .checked,
        isTrue,
      );
      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();
      expect(fake.commands.single['alsoSend'], isTrue);
      expect(fake.commands.single['recipientIds'], ['agent-builder']);
    });
  });

  group('access lost on the chat', () {
    const refused = SuperTabFailure('FORBIDDEN', 'Not yours.', statusCode: 403);

    /// The Swarm read again: refused, or with the person a [role].
    Future<void> reread(
      WidgetTester tester,
      SwarmHost host,
      FakeSwarm fake, {
      bool lost = false,
      String? role,
    }) async {
      if (lost) {
        fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
        fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      } else {
        final parts = fake.routes['/api/super-tabs/$tab/parts']!;
        fake.routes['/api/super-tabs/$tab/parts'] = (body) => {
          ...(parts(body) as Map<String, dynamic>),
          'members': [part(me, 2, person(me, role: role!))],
        };
        // The changes say read it all again.
        fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      }
      await host.session!.inbox.reader(tab)!.refresh();
      for (var i = 0; i < 5; i++) {
        await tester.pump();
      }
    }

    testWidgets('signed out mid-take: the microphone closes, and nothing is '
        'transcribed or kept', (tester) async {
      await pump(tester, backend([message('m1', 1)]), voice: true);
      stt.replies.add('after sign out');
      await tester.tap(key('swarm-mic'));
      await tester.pump();
      await tester.pump();
      expect(recorder.recording, isTrue);

      account.value = null;
      for (var i = 0; i < 5; i++) {
        await tester.pump();
      }

      expect(recorder.recording, isFalse);
      expect(stt.calls, isEmpty);
      expect(find.text('after sign out'), findsNothing);
    });

    testWidgets('made read-only mid-take: the take goes with the composer', (
      tester,
    ) async {
      final fake = backend([message('m1', 1)]);
      final host = await pump(tester, fake, voice: true);
      await tester.tap(key('swarm-mic'));
      await tester.pump();
      await tester.pump();
      expect(recorder.recording, isTrue);

      await reread(tester, host, fake, role: 'viewer');

      expect(key('swarm-composer-card'), findsNothing);
      expect(key('swarm-read-only'), findsOneWidget);
      expect(recorder.recording, isFalse);
      expect(stt.calls, isEmpty);
    });

    testWidgets('words transcribed after the Swarm was lost land nowhere', (
      tester,
    ) async {
      final fake = backend([message('m1', 1)]);
      final host = await pump(tester, fake, voice: true);
      stt.pending = Completer<String>();
      await tester.tap(key('swarm-mic'));
      await tester.pump();
      await tester.pump();
      await tester.tap(key('swarm-voice-stop'));
      await tester.pump();
      expect(stt.calls, hasLength(1), reason: 'the take is being transcribed');

      await reread(tester, host, fake, lost: true);
      stt.pending!.complete('too late');
      await tester.pumpAndSettle();

      expect(find.text('too late'), findsNothing);
      expect(fake.commands, isEmpty);
    });

    testWidgets('the Swarm lost with the picker Tag opened: no picker, no '
        'chip, no name', (tester) async {
      final fake = backend(
        [message('m1', 1)],
        members: [
          person(me),
          person('dee', role: 'collaborator'),
        ],
      );
      final host = await pump(tester, fake);
      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(key('swarm-mention-picker'), findsOneWidget);

      await reread(tester, host, fake, lost: true);
      await tester.pumpAndSettle();

      expect(key('swarm-mention-picker'), findsNothing);
      expect(key('swarm-tag'), findsNothing);
      for (final name in ['dee', 'River', 'Nova']) {
        expect(find.textContaining(name), findsNothing, reason: name);
      }
    });

    testWidgets('signed out with the picker Tag opened: no picker, no chip', (
      tester,
    ) async {
      await pump(tester, backend([message('m1', 1)]));
      await tester.tap(key('swarm-tag'));
      await tester.pump();
      expect(key('swarm-mention-picker'), findsOneWidget);

      account.value = null;
      await tester.pumpAndSettle();

      expect(key('swarm-mention-picker'), findsNothing);
      expect(key('swarm-tag'), findsNothing);
      expect(find.textContaining('River'), findsNothing);
    });
  });
}
