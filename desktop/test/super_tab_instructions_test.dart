import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/detail_dialog.dart';
import 'package:harness/super_tabs/instructions_panel.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _document =
    '## Roles\n\n### PM\n'
    '- Talks with people in the project chat and finds out what they want.\n';
const _editor = ValueKey('super-instructions-editor');
const _summary = ValueKey('super-instructions-summary');
const _save = ValueKey('super-instructions-save');
const _theirs = ValueKey('super-instructions-theirs');
const _mergeLine =
    'Revision 4 was saved while you edited. Merge what it says into your '
    'text, then save again.';

void main() {
  Future<(ConversationServer, SuperTabController)> mount(
    WidgetTester tester, {
    String account = 'owner',
    bool instructions = true,
  }) async {
    final server = ConversationServer();
    server.state['projects'] = [
      {
        ...projectFixture('lead', 'Pilot', 'lead'),
        if (instructions) ...{
          'coordinatorName': 'Product Manager',
          'instructionsRevision': 3,
        },
      },
    ];
    (server.state['people'] as List).addAll([
      {'id': 'peer', 'email': 'peer@example.com', 'role': 'collaborator'},
      {'id': 'viewer', 'email': 'viewer@example.com', 'role': 'viewer'},
    ]);
    server.instructions['lead'] = {
      'projectId': 'lead',
      'revision': 3,
      'hash': 'hash-lead-3',
      'text': _document,
      'template': false,
      'coordinatorName': 'Product Manager',
      'notesRevision': 0,
      'notes': <dynamic>[],
    };
    final controller = server.controller(account: account);
    await controller.refresh();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (server, controller);
  }

  Finder menuItem(String label) => find.widgetWithText(MenuItemButton, label);

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
  }

  Future<void> openInstructions(WidgetTester tester) async {
    await openMenu(tester);
    await tester.tap(menuItem('Instructions'));
    await tester.pumpAndSettle();
  }

  String editorText(WidgetTester tester) =>
      tester.widget<TextField>(find.byKey(_editor)).controller!.text;

  bool saveEnabled(WidgetTester tester) =>
      tester.widget<FilledButton>(find.byKey(_save)).onPressed != null;

  /// The project's owner saves [text] from their own Desktop.
  Future<void> saveElsewhere(ConversationServer server, String text) async {
    final owner = server.controller();
    addTearDown(owner.dispose);
    await owner.refresh();
    final result = await owner.command({
      'type': 'instructions.save',
      'projectId': 'lead',
      'baseRevision': 3,
      'text': text,
      'summary': 'Their change',
    });
    expect(result, isNotNull, reason: '${owner.operationError}');
  }

  testWidgets('shows Instructions to every member and opens the document', (
    tester,
  ) async {
    for (final account in ['peer', 'viewer']) {
      final (server, _) = await mount(tester, account: account);
      await openMenu(tester);
      expect(menuItem('Instructions'), findsOneWidget, reason: account);
      await tester.tap(menuItem('Instructions'));
      await tester.pumpAndSettle();
      expect(server.instructionReads, [
        '/api/super-tabs/tab/projects/lead/instructions',
      ], reason: account);
      expect(editorText(tester), _document, reason: account);
      expect(find.text('Revision 3'), findsOneWidget, reason: account);
      await tester.tap(
        find.widgetWithText(
          TextButton,
          account == 'viewer' ? 'Close' : 'Cancel',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(_editor), findsNothing, reason: account);
    }
  });

  testWidgets('the project menu has no Swarm routing', (tester) async {
    for (final account in ['owner', 'peer']) {
      await mount(tester, account: account);
      await openMenu(tester);
      expect(menuItem('Instructions'), findsOneWidget, reason: account);
      expect(menuItem('Swarm routing'), findsNothing, reason: account);
      await tester.tapAt(const Offset(1, 1));
      await tester.pumpAndSettle();
    }
  });

  testWidgets('a member who is not the owner saves a change with its summary', (
    tester,
  ) async {
    final (server, controller) = await mount(tester, account: 'peer');
    await openInstructions(tester);
    const edited = '$_document- Reviews run on Opus.\n';
    await tester.enterText(find.byKey(_editor), edited);
    await tester.enterText(find.byKey(_summary), 'Reviews run on Opus');
    await tester.pump();
    await tester.tap(find.byKey(_save));
    await tester.pumpAndSettle();
    expect(server.posts.last['command'], {
      'type': 'instructions.save',
      'projectId': 'lead',
      'baseRevision': 3,
      'text': edited,
      'summary': 'Reviews run on Opus',
    });
    expect(find.text('Revision 4'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byKey(_summary)).controller!.text,
      isEmpty,
    );
    expect(editorText(tester), edited);
    expect(saveEnabled(tester), isFalse);
    expect(controller.snapshot!.projectById('lead')!.instructionsRevision, 4);
    // Its own save moved the revision: nothing to read again.
    expect(server.instructionReads, hasLength(1));
  });

  testWidgets('Save waits for a change, a summary and the 64 KB limit', (
    tester,
  ) async {
    await mount(tester, account: 'peer');
    await openInstructions(tester);
    expect(saveEnabled(tester), isFalse);
    await tester.enterText(find.byKey(_editor), '$_document- More.\n');
    await tester.pump();
    expect(saveEnabled(tester), isFalse);
    await tester.enterText(find.byKey(_summary), 'More');
    await tester.pump();
    expect(saveEnabled(tester), isTrue);
    await tester.enterText(find.byKey(_editor), 'a' * 65536);
    await tester.pump();
    expect(saveEnabled(tester), isTrue);
    expect(find.text('Instructions are limited to 64 KB.'), findsNothing);
    await tester.enterText(find.byKey(_editor), 'a' * 65537);
    await tester.pump();
    expect(saveEnabled(tester), isFalse);
    expect(find.text('Instructions are limited to 64 KB.'), findsOneWidget);
    // Bytes, not characters: 32,768 two-byte letters fill it.
    await tester.enterText(find.byKey(_editor), 'é' * 32768);
    await tester.pump();
    expect(saveEnabled(tester), isTrue);
    await tester.enterText(find.byKey(_editor), '${'é' * 32768}a');
    await tester.pump();
    expect(saveEnabled(tester), isFalse);
    expect(find.text('Instructions are limited to 64 KB.'), findsOneWidget);
  });

  testWidgets(
    'a stale save keeps the draft and shows the newer text to merge',
    (tester) async {
      final (server, _) = await mount(tester, account: 'peer');
      await openInstructions(tester);
      await tester.enterText(find.byKey(_editor), 'Draft line');
      await tester.enterText(find.byKey(_summary), 'Mine');
      await tester.pump();
      await saveElsewhere(server, 'Their line');
      await tester.tap(find.byKey(_save));
      await tester.pumpAndSettle();
      expect(server.posts.last['command'], containsPair('baseRevision', 3));
      expect(find.text(_mergeLine), findsOneWidget);
      expect(find.text('Revision 4, as saved'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(_theirs),
          matching: find.text('Their line'),
        ),
        findsOneWidget,
      );
      expect(
        tester.widget<TextField>(find.byKey(_theirs)).readOnly,
        isTrue,
        reason: 'their text is read only',
      );
      expect(editorText(tester), 'Draft line');
      expect(
        tester.widget<TextField>(find.byKey(_summary)).controller!.text,
        'Mine',
      );
      expect(saveEnabled(tester), isTrue);
      await tester.tap(find.byKey(_save));
      await tester.pumpAndSettle();
      expect(server.posts.last['command'], {
        'type': 'instructions.save',
        'projectId': 'lead',
        'baseRevision': 4,
        'text': 'Draft line',
        'summary': 'Mine',
      });
      expect(find.text('Revision 5'), findsOneWidget);
      expect(find.text(_mergeLine), findsNothing);
      expect(find.byKey(_theirs), findsNothing);
      expect(server.instructions['lead']!['text'], 'Draft line');
    },
  );

  testWidgets('a revision saved elsewhere replaces an unchanged draft', (
    tester,
  ) async {
    final (server, controller) = await mount(tester, account: 'peer');
    await openInstructions(tester);
    await saveElsewhere(server, 'Their line');
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(editorText(tester), 'Their line');
    expect(find.text('Revision 4'), findsOneWidget);
    expect(find.text(_mergeLine), findsNothing);
    expect(find.byKey(_theirs), findsNothing);
    expect(server.instructionReads, hasLength(2));
    // Nothing moved: no read on a refresh.
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(server.instructionReads, hasLength(2));
  });

  testWidgets('a viewer reads and cannot save', (tester) async {
    await mount(tester, account: 'viewer');
    await openInstructions(tester);
    expect(tester.widget<TextField>(find.byKey(_editor)).readOnly, isTrue);
    expect(find.byKey(_save), findsNothing);
    expect(find.byKey(_summary), findsNothing);
    expect(find.widgetWithText(TextButton, 'Close'), findsOneWidget);
  });

  testWidgets('an older Swarm shows no Instructions', (tester) async {
    final (server, controller) = await mount(tester, instructions: false);
    await openMenu(tester);
    expect(menuItem('Project details'), findsOneWidget);
    expect(menuItem('Instructions'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    server.instructionsRoute = false;
    unawaited(
      showSuperTabInstructions(
        tester.element(find.byType(SuperTabView)),
        controller,
        'lead',
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('This Swarm has no project instructions yet.'),
      findsOneWidget,
    );
    expect(find.byKey(_editor), findsNothing);
    expect(find.text('Try again'), findsNothing);
  });

  testWidgets('a failed read says why and tries again', (tester) async {
    final (server, _) = await mount(tester, account: 'peer');
    server.failReads = true;
    await openInstructions(tester);
    expect(find.text('The instructions could not be read.'), findsOneWidget);
    expect(find.byKey(_editor), findsNothing);
    server.failReads = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(editorText(tester), _document);
  });

  testWidgets('a save whose answer was lost says so and is checked again', (
    tester,
  ) async {
    final (server, _) = await mount(tester, account: 'peer');
    await openInstructions(tester);
    await tester.enterText(find.byKey(_editor), 'Draft line');
    await tester.enterText(find.byKey(_summary), 'Mine');
    await tester.pump();
    server.loseReply = true;
    await tester.tap(find.byKey(_save));
    await tester.pumpAndSettle();
    // The composer behind the panel says it too.
    final unconfirmed = find.descendant(
      of: find.byType(SuperTabDetailDialog),
      matching: find.text('The action is not confirmed. Retry to check it.'),
    );
    expect(unconfirmed, findsOneWidget);
    expect(saveEnabled(tester), isFalse);
    final retry = find.descendant(
      of: find.byType(SuperTabDetailDialog),
      matching: find.widgetWithText(TextButton, 'Retry'),
    );
    await tester.tap(retry);
    await tester.pumpAndSettle();
    expect(server.posts, hasLength(2));
    expect(server.posts.last['operationId'], server.posts.first['operationId']);
    expect(find.text('Revision 4'), findsOneWidget);
    expect(retry, findsNothing);
    expect(unconfirmed, findsNothing);
  });

  testWidgets('closing with unsaved changes asks first', (tester) async {
    await mount(tester, account: 'peer');
    await openInstructions(tester);
    await tester.enterText(find.byKey(_editor), 'Draft line');
    await tester.pump();
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(
      find.text('Discard your changes to the instructions?'),
      findsOneWidget,
    );
    await tester.tap(find.text('Keep editing'));
    await tester.pumpAndSettle();
    expect(
      find.text('Discard your changes to the instructions?'),
      findsNothing,
    );
    expect(editorText(tester), 'Draft line');
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(find.byKey(_editor), findsNothing);
  });

  testWidgets('the skill set picker and the roles editor are gone', (
    tester,
  ) async {
    await mount(tester);
    await openInstructions(tester);
    expect(find.byKey(_editor), findsOneWidget);
    expect(find.textContaining('Default — the team process'), findsNothing);
    expect(find.text('Create custom set'), findsNothing);
    expect(find.text('Edit custom roles'), findsNothing);
    expect(find.text('Instructions for this project'), findsNothing);
  });

  group('history and notes', () {
    final now = DateTime.now().toUtc();
    String ago(Duration d) => now.subtract(d).toIso8601String();
    Map<String, dynamic> revision(
      int n,
      String kind,
      String id,
      String summary,
      Duration age, {
      String? askedBy,
    }) => {
      'revision': n,
      'hash': 'hash-lead-$n',
      'summary': summary,
      'writtenBy': {'kind': kind, 'id': id},
      'askedBy': askedBy,
      'at': ago(age),
      'text': 'Text of revision $n',
    };
    Map<String, dynamic> note(
      String id,
      String text,
      String askedBy,
      Duration age, {
      Duration? lasts,
    }) => {
      'id': id,
      'text': text,
      'askedBy': askedBy,
      'at': ago(age),
      'expiresAt': lasts == null ? null : now.add(lasts).toIso8601String(),
    };
    void seed(ConversationServer server) {
      server.instructionRevisions['lead'] = [
        revision(
          8,
          'person',
          'owner',
          'Reviews run on Opus.',
          const Duration(hours: 2),
        ),
        revision(
          7,
          'agent',
          'gone',
          'Tester runs on the Mac.',
          const Duration(hours: 30),
          askedBy: 'peer',
        ),
        revision(
          1,
          'system',
          'harness',
          "From the project's roles and rules.",
          const Duration(days: 3),
        ),
      ];
    }

    Future<void> openHistory(WidgetTester tester) async {
      await tester.tap(
        find.byKey(const ValueKey('super-instructions-history')),
      );
      await tester.pumpAndSettle();
    }

    double top(WidgetTester tester, Finder f) => tester.getTopLeft(f).dy;

    testWidgets(
      'History lists revisions newest first with who, when and what changed',
      (tester) async {
        final (server, _) = await mount(tester, account: 'peer');
        seed(server);
        await openInstructions(tester);
        await openHistory(tester);
        expect(
          server.instructionReads.where(
            (r) => r.endsWith('/instructions/revisions'),
          ),
          hasLength(1),
        );
        expect(find.text('Instructions › History'), findsOneWidget);
        Finder row(int n) => find.byKey(ValueKey('super-revision-$n'));
        expect(top(tester, row(8)) < top(tester, row(7)), isTrue);
        expect(top(tester, row(7)) < top(tester, row(1)), isTrue);
        String rowText(int n) => tester
            .widgetList<Text>(
              find.descendant(of: row(n), matching: find.byType(Text)),
            )
            .map((t) => t.data)
            .join(' | ');
        expect(
          rowText(8),
          'Revision 8 | owner · 2 hours ago · Reviews run on Opus.',
        );
        expect(
          rowText(7),
          'Revision 7 | Product Manager for peer · yesterday · '
          'Tester runs on the Mac.',
        );
        expect(
          rowText(1),
          "Revision 1 | Harness · 3 days ago · From the project's roles "
          'and rules.',
        );
      },
    );

    testWidgets(
      'a past revision opens read only, and Restore puts it in the editor',
      (tester) async {
        final (server, _) = await mount(tester, account: 'peer');
        seed(server);
        await openInstructions(tester);
        await openHistory(tester);
        await tester.tap(find.byKey(const ValueKey('super-revision-7')));
        await tester.pumpAndSettle();
        expect(
          server.instructionReads.where((r) => r.endsWith('/revisions/7')),
          hasLength(1),
        );
        final text = tester.widget<TextField>(
          find.byKey(const ValueKey('super-revision-text')),
        );
        expect(text.readOnly, isTrue);
        expect(text.controller!.text, 'Text of revision 7');
        final posts = server.posts.length;
        await tester.tap(find.byKey(const ValueKey('super-restore')));
        await tester.pumpAndSettle();
        expect(editorText(tester), 'Text of revision 7');
        expect(
          tester.widget<TextField>(find.byKey(_summary)).controller!.text,
          'Restored revision 7.',
        );
        expect(
          server.posts,
          hasLength(posts),
          reason: 'nothing is written until Save',
        );
        await tester.tap(find.byKey(_save));
        await tester.pumpAndSettle();
        expect(server.posts.last['command'], {
          'type': 'instructions.save',
          'projectId': 'lead',
          'baseRevision': 3,
          'text': 'Text of revision 7',
          'summary': 'Restored revision 7.',
        });
      },
    );

    testWidgets('Restore asks before it replaces an unsaved draft', (
      tester,
    ) async {
      final (server, _) = await mount(tester, account: 'peer');
      seed(server);
      await openInstructions(tester);
      await tester.enterText(find.byKey(_editor), 'Draft line');
      await tester.pump();
      await openHistory(tester);
      await tester.tap(find.byKey(const ValueKey('super-revision-7')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-restore')));
      await tester.pumpAndSettle();
      expect(
        find.text('Replace your changes with revision 7?'),
        findsOneWidget,
      );
      // Keeping the draft leaves the history open and the draft intact.
      await tester.tap(find.text('Keep my changes'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-restore')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('super-restore')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Replace'));
      await tester.pumpAndSettle();
      expect(editorText(tester), 'Text of revision 7');
    });

    testWidgets('a viewer has no Restore', (tester) async {
      final (server, _) = await mount(tester, account: 'viewer');
      seed(server);
      await openInstructions(tester);
      await openHistory(tester);
      await tester.tap(find.byKey(const ValueKey('super-revision-7')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-revision-text')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-restore')), findsNothing);
    });

    testWidgets('a failed history read says so and reads again', (
      tester,
    ) async {
      final (server, _) = await mount(tester, account: 'peer');
      seed(server);
      await openInstructions(tester);
      server.failReads = true;
      await openHistory(tester);
      expect(find.text('Could not read the history.'), findsOneWidget);
      server.failReads = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-revision-8')), findsOneWidget);
      expect(find.text('Could not read the history.'), findsNothing);
    });

    testWidgets('notes show under the document with who asked and when', (
      tester,
    ) async {
      final (server, _) = await mount(tester, account: 'peer');
      server.instructions['lead']!['notes'] = [
        note('n2', 'Prefer Kimi K3 for docs', 'owner', const Duration(days: 1)),
        note(
          'n1',
          "Don't use Codex on machine A",
          'peer',
          const Duration(hours: 3),
          lasts: const Duration(days: 5),
        ),
      ];
      await openInstructions(tester);
      expect(find.text("Product Manager's notes"), findsOneWidget);
      expect(
        top(tester, find.text("Don't use Codex on machine A")) <
            top(tester, find.text('Prefer Kimi K3 for docs')),
        isTrue,
        reason: 'newest first',
      );
      expect(find.text('asked by owner · yesterday'), findsOneWidget);
      expect(
        find.textContaining('asked by peer · 3 hours ago · until '),
        findsOneWidget,
      );
    });

    testWidgets('no notes, and a renamed coordinator', (tester) async {
      final (server, _) = await mount(tester, account: 'peer');
      server.instructions['lead']!['coordinatorName'] = 'Coordinator';
      await openInstructions(tester);
      expect(find.text("Coordinator's notes"), findsOneWidget);
      expect(find.text('No notes.'), findsOneWidget);
    });

    testWidgets('a member deletes a note, a viewer cannot', (tester) async {
      final (server, _) = await mount(tester, account: 'peer');
      server.instructions['lead']!['notes'] = [
        note('n1', 'Keep it short', 'owner', const Duration(hours: 1)),
        note('n2', 'Other note', 'owner', const Duration(hours: 2)),
      ];
      await openInstructions(tester);
      await tester.enterText(find.byKey(_editor), 'Draft stays');
      await tester.pump();
      await tester.ensureVisible(
        find.byKey(const ValueKey('super-note-delete-n1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-note-delete-n1')));
      await tester.pumpAndSettle();
      expect(server.posts.last['command'], {
        'type': 'note.remove',
        'projectId': 'lead',
        'noteId': 'n1',
      });
      expect(find.byKey(const ValueKey('super-note-n1')), findsNothing);
      expect(find.byKey(const ValueKey('super-note-n2')), findsOneWidget);
      expect(editorText(tester), 'Draft stays');
    });

    testWidgets('a viewer has no Delete', (tester) async {
      final (viewerServer, _) = await mount(tester, account: 'viewer');
      viewerServer.instructions['lead']!['notes'] = [
        note('n1', 'Keep it short', 'owner', const Duration(hours: 1)),
      ];
      await tester.pumpAndSettle();
      await openInstructions(tester);
      expect(find.text('Keep it short'), findsOneWidget);
      expect(find.byKey(const ValueKey('super-note-delete-n1')), findsNothing);
    });

    testWidgets(
      'an unsaved draft and a revision move show the merge line without Save',
      (tester) async {
        final (server, controller) = await mount(tester, account: 'peer');
        await openInstructions(tester);
        await tester.enterText(find.byKey(_editor), 'Draft line');
        await tester.enterText(find.byKey(_summary), 'Mine');
        await tester.pump();
        await saveElsewhere(server, 'Their line');
        final posts = server.posts.length;
        await controller.refresh();
        await tester.pumpAndSettle();
        expect(find.text(_mergeLine), findsOneWidget);
        expect(editorText(tester), 'Draft line');
        expect(find.text('Revision 4'), findsOneWidget);
        expect(server.posts, hasLength(posts), reason: 'no Save was pressed');
        await tester.tap(find.byKey(_save));
        await tester.pumpAndSettle();
        expect(server.posts.last['command'], containsPair('baseRevision', 4));
      },
    );
  });

  testWidgets('the fixture refuses what the backend refuses', (tester) async {
    final (server, _) = await mount(tester);
    var n = 0;
    // Straight to the server as the account, past the controller's own guards.
    Future<Object?> save(String account, Map<String, dynamic> over) async {
      final c = server.controller(account: account);
      addTearDown(c.dispose);
      try {
        return await c.request(
          'POST',
          '/api/super-tabs/tab/commands',
          body: {
            'operationId': 'fixture-check-${n++}',
            'command': {
              'type': 'instructions.save',
              'projectId': 'lead',
              'baseRevision': 3,
              'text': 'New text',
              'summary': 'Why',
              ...over,
            },
          },
        );
      } on SuperTabFailure catch (failure) {
        return failure.code;
      }
    }

    expect(await save('viewer', {}), 'READ_ONLY');
    for (final over in [
      {'text': ''},
      {'text': 'a' * 65537},
      {'text': 'é' * 32769},
      {'summary': ''},
      {'summary': 'a\nb'},
      {'summary': 'a' * 201},
    ]) {
      expect(await save('owner', over), 'VALIDATION_ERROR', reason: '$over');
    }
    expect(server.instructions['lead']!['revision'], 3);
    final same = await save('owner', {'text': _document}) as Map;
    expect((same['result'] as Map)['unchanged'], isTrue);
    expect(server.instructions['lead']!['revision'], 3);
    await save('owner', {'text': 'a' * 65536});
    expect(server.instructions['lead']!['revision'], 4);
  });
}
