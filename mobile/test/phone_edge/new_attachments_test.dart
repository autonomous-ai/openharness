import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/new_agent_attachments.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/attached_task_delivery.dart'
    show kAttachedTaskOpenTimeout;
import 'package:harness_mobile/state/harness_attachments.dart';

import 'edge_fixture.dart';

/// A picked file whose size and bytes are said separately — what the picker hands over for a file
/// it can measure without reading, or one it cannot read at all.
class _Picked extends XFile {
  _Picked(super.path, {this.size, this.content, this.unreadable = false});

  final int? size;
  final Uint8List? content;
  final bool unreadable;

  @override
  String get name => path;

  @override
  Future<int> length() async => size ?? content?.length ?? 0;

  @override
  Future<Uint8List> readAsBytes() async {
    if (unreadable) throw const _Unreadable();
    return content ?? Uint8List(0);
  }
}

class _Unreadable implements Exception {
  const _Unreadable();
}

_Picked _file(String name, [String text = 'contents']) =>
    _Picked(name, content: Uint8List.fromList(utf8.encode(text)));

/// Attaching files to a New harness from the phone — the desktop's 📎. What the picker hands over
/// is held under the task, and Start creates the harness without the task, which follows the files
/// into its terminal (`deliverAttachedTask`).
void main() {
  late Future<List<XFile>> Function() restore;
  setUp(() => restore = pickAttachmentFiles);
  tearDown(() {
    pickAttachmentFiles = restore;
    newAgentDraft = null;
  });

  group('what the picker hands over', () {
    test('is read in, one per name', () async {
      final attachments = HarnessAttachments();
      pickAttachmentFiles = () async => [_file('a.pdf'), _file('b.log')];

      expect(await addPickedAttachments(attachments), isNull);
      pickAttachmentFiles = () async => [_file('a.pdf', 'newer')];
      expect(await addPickedAttachments(attachments), isNull);

      expect(attachments.files.map((f) => f.name), ['b.log', 'a.pdf']);
      expect(utf8.decode(attachments.files.last.bytes), 'newer');
    });

    test('a file over the limit is named and never read', () async {
      final attachments = HarnessAttachments();
      pickAttachmentFiles = () async => [
        _Picked(
          'huge.zip',
          size: HarnessAttachments.maxBytes + 1,
          unreadable: true,
        ),
        _file('notes.md'),
      ];

      expect(
        await addPickedAttachments(attachments),
        'huge.zip is over 20 MB.',
      );
      expect(attachments.files.map((f) => f.name), ['notes.md']);
    });

    test('a file that cannot be read says which', () async {
      final attachments = HarnessAttachments();
      pickAttachmentFiles = () async => [
        _Picked('locked.key', size: 3, unreadable: true),
      ];

      expect(
        await addPickedAttachments(attachments),
        'Could not read locked.key',
      );
      expect(attachments.isEmpty, isTrue);
    });

    test(
      'backing out says nothing; a picker that cannot open says so',
      () async {
        final attachments = HarnessAttachments();
        pickAttachmentFiles = () async => [];
        expect(await addPickedAttachments(attachments), isNull);

        pickAttachmentFiles = () async => throw PlatformException(code: 'x');
        expect(
          await addPickedAttachments(attachments),
          'Could not open the picker.',
        );
      },
    );
  });

  group('the form', () {
    Map<String, dynamic>? created(String type, Map<String, dynamic> payload) =>
        type != 'agent_create'
        ? null
        : {
            'creationId': payload['creationId'],
            'state': 'created',
            'agent': {
              'id': 'new-agent',
              'name': 'new-agent',
              'engine': 'claude',
              'terminal': {'available': true},
            },
          };

    /// New on `m`, whose agent's folder is the project, on a machine that does or does not take
    /// files into a harness's prompt.
    Future<({AppNotifier app, EdgeConn conn})> openNew(
      WidgetTester tester, {
      bool takesFiles = true,
    }) async {
      setPhone(tester, largePhone);
      final conn = EdgeConn(const {}, created);
      conn.capabilities = {
        ...conn.capabilities,
        'features': {
          'projectFolder': true,
          'pasteRaw': true,
          'pasteFile': takesFiles,
        },
      };
      final app = edgeApp(conn: conn);
      await tester.pumpWidget(
        phoneApp(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => NewAgentPage(notifier: app, machineId: 'm'),
                ),
              ),
              child: const Text('focus'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('focus'));
      await frames(tester);
      // The machine's terminal features, read the way a connection reads them.
      app.stateOf('m')!
        ..terminalPasteFileAvailable = takesFiles
        ..terminalPasteRawAvailable = true;
      app.notifyListeners();
      await frames(tester);
      return (app: app, conn: conn);
    }

    Future<void> close(WidgetTester tester, AppNotifier app) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    }

    final attach = find.byKey(const ValueKey('new-agent-attach'));

    testWidgets('the 📎 picks files into a list under the task, and × takes '
        'one back off', (tester) async {
      pickAttachmentFiles = () async => [_file('report.pdf'), _file('a.log')];
      final (:app, conn: _) = await openNew(tester);

      await tapInView(tester, attach);
      await frames(tester);
      expect(find.text('report.pdf'), findsOneWidget);
      expect(find.text('a.log'), findsOneWidget);

      await tapInView(
        tester,
        find.byKey(const ValueKey('attachment-remove-a.log')),
      );
      await frames(tester);
      expect(find.text('a.log'), findsNothing);
      expect(find.text('report.pdf'), findsOneWidget);
      await close(tester, app);
    });

    testWidgets('no 📎 on a machine that cannot take files', (tester) async {
      final (:app, conn: _) = await openNew(tester, takesFiles: false);

      expect(attach, findsNothing);
      await close(tester, app);
    });

    testWidgets('Start with files creates the harness without its task, which '
        'follows the files, and opens it', (tester) async {
      pickAttachmentFiles = () async => [_file('report.pdf')];
      final (:app, :conn) = await openNew(tester);
      await tapInView(tester, attach);
      await frames(tester);
      await tester.enterText(
        find.widgetWithText(TextField, 'What should it do?'),
        'Summarise the report',
      );
      await frames(tester);

      await tapInView(tester, find.text('Start'));
      for (
        var i = 0;
        i < 120 && find.byType(AgentSwipeHost).evaluate().isEmpty;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 250));
      }

      final [sent] = conn.payloads['agent_create']!;
      expect(sent.containsKey('prompt'), isFalse, reason: 'the files go first');
      expect(sent['name'], isNotNull, reason: 'still named by its task');
      expect(find.byType(AgentSwipeHost), findsOneWidget);
      // This machine never hands the terminal over, so the files wait out their time and say so.
      await tester.pump(kAttachedTaskOpenTimeout);
      await frames(tester);
      expect(
        find.text(
          'The harness did not open in time. Attach the files in its pane.',
        ),
        findsOneWidget,
      );
      await close(tester, app);
    });

    testWidgets('Start without files sends the task at launch, as before', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(tester);
      await tester.enterText(
        find.widgetWithText(TextField, 'What should it do?'),
        'Summarise the report',
      );
      await frames(tester);

      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);

      final [sent] = conn.payloads['agent_create']!;
      expect(sent['prompt'], 'Summarise the report');
      await close(tester, app);
    });

    testWidgets('files left on a machine that can no longer take them are '
        'said, and nothing starts', (tester) async {
      pickAttachmentFiles = () async => [_file('report.pdf')];
      final (:app, :conn) = await openNew(tester);
      await tapInView(tester, attach);
      await frames(tester);
      app.stateOf('m')!.terminalPasteFileAvailable = false;
      app.notifyListeners();
      await frames(tester);
      expect(
        find.text('report.pdf'),
        findsOneWidget,
        reason: 'still removable',
      );

      await tapInView(tester, find.text('Start'));
      await frames(tester);

      expect(
        find.textContaining('to attach files, or remove them.'),
        findsOneWidget,
      );
      expect(conn.payloads['agent_create'], isNull);
      await close(tester, app);
    });

    // The task field raises the keyboard, and the list sits under it: on a small phone the form
    // still scrolls to Start rather than overflowing.
    testWidgets('with files and the keyboard up on a small phone, Start is '
        'still reached', (tester) async {
      pickAttachmentFiles = () async => [
        for (var i = 0; i < 6; i++) _file('file-$i.log'),
      ];
      final (:app, conn: _) = await openNew(tester);
      setPhone(tester, smallPhone);
      await frames(tester);
      await tapInView(tester, attach);
      await frames(tester);
      raiseKeyboard(tester);
      await frames(tester);

      expect(tester.takeException(), isNull, reason: 'no overflow');
      final start = find.text('Start');
      await tester.ensureVisible(start);
      await tester.pump();
      expect(
        tester.getRect(start).bottom,
        lessThanOrEqualTo(smallPhone.size.height - smallPhone.keyboard),
      );
      lowerKeyboard(tester);
      await frames(tester);
      await close(tester, app);
    });
  });
}
