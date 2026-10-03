import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/coding_memory_library.dart';
import 'package:harness/companions/coding_memory_connection.dart';
import 'package:harness/companions/coding_memory_view.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shared/widgets/skeleton.dart';

import 'support/coding_memory_fixture.dart';
import 'support/real_fonts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });
  late MemoryFixture transport;
  late CodingMemoryLibrary library;
  late GlobalKey boundary;
  setUp(() {
    transport = MemoryFixture();
    library = CodingMemoryLibrary(transport);
    boundary = GlobalKey();
  });
  tearDown(() => library.dispose());

  Future<void> mount(
    WidgetTester tester, {
    Brightness brightness = Brightness.dark,
    double scale = 1,
    Size size = const Size(850, 850),
    VoidCallback? onOpenCompanion,
    bool openingCompanion = false,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final oldPalette = AppTheme.palette.value,
        oldBrightness = AppTheme.brightness.value;
    AppTheme.palette.value = brightness == Brightness.dark
        ? HarnessPalette.graphite
        : HarnessPalette.paper;
    AppTheme.brightness.value = brightness;
    addTearDown(() {
      AppTheme.palette.value = oldPalette;
      AppTheme.brightness.value = oldBrightness;
    });
    await library.refresh();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: Scaffold(
            body: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: CodingMemoryView(
                library: library,
                onOpenCompanion: onOpenCompanion,
                openingCompanion: openingCompanion,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> tap(WidgetTester tester, String label) async {
    final button = find.text(label).last;
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pumpAndSettle();
  }

  Future<void> capture(WidgetTester tester, String name) async {
    final output = Platform.environment['HARNESS_MEMORY_CAPTURE_DIR'];
    if (output == null) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 1);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(output).create(recursive: true);
      await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  testWidgets(
    'Helping now explains a selection and preserves rating focus and source controls',
    (tester) async {
      transport.recalls.add(syntheticRecall());
      await mount(tester);
      await tap(tester, 'Helping now');
      expect(
        find.text('Sent by Harness · Delivery not confirmed'),
        findsOneWidget,
      );
      expect(find.text('Applies when task: bug fix.'), findsOneWidget);
      await tap(tester, 'Helpful');
      final helpful = tester
          .widgetList<DesktopPill>(find.byType(DesktopPill))
          .singleWhere((p) => p.label == 'Helpful');
      expect(helpful.selected, isTrue);
      expect(helpful.focusNode!.hasFocus, isTrue);
      expect(transport.previewed!['receiptId'], 'synthetic-receipt');
      await tap(tester, 'Clear feedback');
      expect(
        transport.calls.where((p) => p['action'] == 'apply'),
        hasLength(2),
      );
      await tap(tester, 'Read memory');
      expect(find.text('Correct memory'), findsOneWidget);
      expect(find.text('Forget…'), findsOneWidget);
    },
  );

  testWidgets(
    'Helping now shows an empty latest recall without an earlier positive memory',
    (tester) async {
      transport.handle = (p) async => p['action'] == 'activity'
          ? syntheticActivity(transport.record, empty: true)
          : transport.respond(p);
      await mount(tester);
      await tap(tester, 'Helping now');
      expect(
        find.text('No memories were selected for the last recorded request.'),
        findsOneWidget,
      );
      expect(find.text(transport.record['claim'] as String), findsNothing);
      expect(find.text('Helpful'), findsNothing);
    },
  );

  testWidgets(
    'Helping now distinguishes loading, empty activity and lost identity',
    (tester) async {
      final pending = Completer<Map<String, dynamic>>();
      transport.handle = (p) => p['action'] == 'activity'
          ? pending.future
          : Future.value(transport.respond(p));
      await mount(tester);
      await tap(tester, 'Helping now');
      expect(find.byType(SkeletonText), findsNWidgets(2));
      expect(find.textContaining('No recall activity'), findsNothing);
      pending.complete({
        'ok': true,
        'sessions': [],
        'items': [],
        'selectedAgentId': null,
      });
      await tester.pumpAndSettle();
      expect(find.textContaining('No recall activity'), findsOneWidget);
      transport.invalidate();
      await tester.pumpAndSettle();
      expect(find.textContaining('No recall activity'), findsNothing);
    },
  );

  testWidgets(
    'Helping now session picker switches the inspected task without writing or sending input',
    (tester) async {
      transport.handle = (p) async {
        if (p['action'] != 'activity') return transport.respond(p);
        final selected =
            (p['query'] as Map)['agentId'] as String? ?? 'synthetic-agent';
        final result = syntheticActivity(
          transport.record,
          agentId: selected,
          empty: selected == 'second',
        );
        final session = (result['sessions'] as List).single as Map;
        return {
          ...result,
          'sessions': [
            {
              ...session,
              'agentId': 'synthetic-agent',
              'name': 'First coding task',
              'selectedCount': 1,
            },
            {
              ...session,
              'agentId': 'second',
              'name': 'Second coding task',
              'selectedCount': 0,
            },
          ],
        };
      };
      await mount(tester);
      await tap(tester, 'Helping now');
      await tester.tap(find.byKey(const ValueKey('memory-activity-session')));
      await tester.pumpAndSettle();
      await tap(tester, 'Second coding task');
      expect(
        find.text('No memories were selected for the last recorded request.'),
        findsOneWidget,
      );
      expect(
        transport.calls.where((p) => p['action'] == 'activity').last['query'],
        {'agentId': 'second'},
      );
      expect(
        transport.calls.any((p) => ['preview', 'apply'].contains(p['action'])),
        isFalse,
      );
    },
  );

  for (final brightness in [Brightness.dark, Brightness.light]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'Helping now fits ${brightness.name} at ${scale}x with a long session name',
        (tester) async {
          transport.recalls.add(syntheticRecall());
          transport.handle = (p) async {
            final result = transport.respond(p);
            if (p['action'] == 'activity') {
              ((result['sessions'] as List).first as Map)['name'] = 'Fix the editor regression while preserving keyboard navigation and project context';
            }
            return result;
          };
          await mount(
            tester,
            brightness: brightness,
            scale: scale,
            size: Size(scale == 1 ? 760 : 480, 920),
          );
          await tap(tester, 'Helping now');
          expect(tester.takeException(), isNull);
          await capture(tester, 'activity-${brightness.name}-${scale}x');
          await tap(tester, 'Helpful');
          expect(tester.takeException(), isNull);
          await capture(
            tester,
            'activity-feedback-${brightness.name}-${scale}x',
          );
        },
      );
    }
  }

  testWidgets(
    'project notebooks preserve source conditions, scope and source controls',
    (tester) async {
      transport.record = syntheticMemory(project: true);
      transport.record['scope'] = {
        ...transport.record['scope'] as Map,
        'taskId': 'task-review',
        'branchId': 'branch-tests',
      };
      transport.notebookPages.add(syntheticNotebook(transport.record));
      await mount(tester);
      await tap(tester, 'Project knowledge');
      expect(find.text('Task reference: task-review'), findsOneWidget);
      expect(find.text('Branch reference: branch-tests'), findsOneWidget);
      await tap(tester, 'Open notebook');
      expect(
        find.textContaining('begin with a small failing test'),
        findsOneWidget,
      );
      expect(find.text('Source 1 applies when task: bug_fix.'), findsOneWidget);
      expect(
        find.textContaining('Prose changes need a reading check.'),
        findsOneWidget,
      );
      expect(
        find.text('Recheck source 1: The test framework changes.'),
        findsOneWidget,
      );
      expect(find.textContaining('may cover only part'), findsOneWidget);
      expect(find.textContaining('1 needing review'), findsOneWidget);
      await tap(tester, 'Read source 1 · revision 1');
      expect(
        transport.calls.lastWhere((c) => c['action'] == 'show')['id'],
        'synthetic-memory',
      );
      expect(find.text('Correct memory'), findsOneWidget);
      await tap(tester, 'Close');
      expect(
        find.textContaining('begin with a small failing test'),
        findsOneWidget,
      );
      await tap(tester, 'Back to notebooks');
      expect(
        find.textContaining('begin with a small failing test'),
        findsNothing,
      );
      final open = tester.widget<TextButton>(
        find.widgetWithText(TextButton, 'Open notebook'),
      );
      expect(open.focusNode!.hasFocus, isTrue);
      expect(
        transport.calls.where(
          (c) => ![
            'status',
            'list',
            'notebooks',
            'notebook',
            'show',
          ].contains(c['action']),
        ),
        isEmpty,
      );
    },
  );

  testWidgets(
    'a source revision removes the explanation before a new page arrives',
    (tester) async {
      transport.record = syntheticMemory(project: true);
      final page = syntheticNotebook(transport.record);
      transport.notebookPages.add(page);
      await mount(tester);
      await tap(tester, 'Project knowledge');
      await tap(tester, 'Open notebook');
      final pending = Completer<Map<String, dynamic>>();
      transport.handle = (p) async =>
          p['action'] == 'notebook' ? pending.future : transport.respond(p);
      transport.record = syntheticMemory(project: true, revision: 2);
      await library.refresh();
      await tester.pump();
      expect(
        find.textContaining('begin with a small failing test'),
        findsNothing,
      );
      expect(find.text('Back to notebooks'), findsOneWidget);
      transport.invalidate();
      pending.complete(page);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('begin with a small failing test'),
        findsNothing,
      );
      expect(find.text('Read source 1 · revision 1'), findsNothing);
    },
  );

  testWidgets(
    'Back restores index position and focus after a delayed changed-index read',
    (tester) async {
      transport.record = syntheticMemory(project: true);
      for (var index = 0; index < 6; index++) {
        final page = syntheticNotebook(transport.record);
        (page['summary'] as Map)['id'] = 'notebook:testing_$index';
        transport.notebookPages.add(page);
      }
      await mount(tester);
      await tap(tester, 'Project knowledge');
      await tester.ensureVisible(find.text('Open notebook').last);
      await tester.pumpAndSettle();
      final position = tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position;
      final before = position.pixels;
      expect(before, greaterThan(0));
      await tap(tester, 'Open notebook');
      transport.record = syntheticMemory(project: true, revision: 2);
      await library.refresh();
      await tester.pumpAndSettle();
      final hold = Completer<Map<String, dynamic>>();
      transport.handle = (p) async =>
          p['action'] == 'notebooks' ? hold.future : transport.respond(p);
      await tester.ensureVisible(find.text('Back to notebooks'));
      await tester.tap(find.text('Back to notebooks'));
      await tester.pump();
      expect(find.text('Open notebook'), findsNothing);
      hold.complete(transport.respond({'action': 'notebooks'}));
      await tester.pumpAndSettle();
      expect(position.pixels, closeTo(before, 1));
      final open = tester.widget<TextButton>(
        find.widgetWithText(TextButton, 'Open notebook').last,
      );
      expect(open.focusNode!.hasFocus, isTrue);
    },
  );

  testWidgets(
    'queued and older-service notebooks retain individual memory browsing',
    (tester) async {
      transport.record = syntheticMemory(project: true);
      transport.notebookPages.add(
        syntheticNotebook(transport.record, ready: false),
      );
      await mount(tester);
      await tap(tester, 'Project knowledge');
      await tap(tester, 'Open notebook');
      expect(find.textContaining('will be prepared'), findsOneWidget);
      expect(find.text('Needs review · This project'), findsOneWidget);
      await tap(tester, 'Individual memories');
      await tap(tester, 'Read memory');
      await tap(tester, 'Close');
      transport.handle = (p) async =>
          ['notebooks', 'notebook'].contains(p['action'])
          ? {'ok': false, 'error': 'UNSUPPORTED'}
          : transport.respond(p);
      await library.refresh();
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Notebook explanations are not available'),
        findsOneWidget,
      );
      expect(find.text('Read memory'), findsOneWidget);
    },
  );

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'notebook ${brightness.name} $scale text keeps conditions and controls readable',
        (tester) async {
          transport.record = syntheticMemory(project: true);
          final page = syntheticNotebook(transport.record);
          (page['summary'] as Map)['project'] = {
            'name': 'A deliberately long project name for the desktop editor',
            'location': '/synthetic/work/a-long-project-folder/desktop-editor',
          };
          transport.notebookPages.add(page);
          await mount(
            tester,
            brightness: brightness,
            scale: scale,
            size: Size(scale == 1 ? 850 : 480, 900),
          );
          await tap(tester, 'Project knowledge');
          await capture(tester, 'notebooks-${brightness.name}-${scale}x');
          await tap(tester, 'Open notebook');
          expect(tester.takeException(), isNull);
          await capture(tester, 'notebook-${brightness.name}-${scale}x');
          await tester.ensureVisible(
            find.text('Source 1 applies when task: bug_fix.'),
          );
          await tester.pumpAndSettle();
          await capture(
            tester,
            'notebook-sources-${brightness.name}-${scale}x',
          );
          expect(tester.takeException(), isNull);
          await tap(tester, 'Read source 1 · revision 1');
          expect(find.text('Your coding memory'), findsNWidgets(2));
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  testWidgets(
    'feedback rates the exact recall, preserves the open detail and can be changed or cleared',
    (tester) async {
      transport.recalls.add(syntheticRecall());
      await mount(tester);
      await tap(tester, 'Read memory');
      expect(find.textContaining('Delivery not confirmed'), findsOneWidget);
      expect(find.textContaining('matching conditions'), findsOneWidget);
      expect(transport.calls.where((c) => c['action'] == 'apply'), isEmpty);
      final revision = transport.record['revision'];
      final evidence = transport.record['evidence'];
      final changes = library.changes;
      await tap(tester, 'Helpful');
      expect(transport.previewed, {
        'kind': 'feedback',
        'id': 'synthetic-memory',
        'revision': 1,
        'receiptId': 'synthetic-receipt',
        'value': 'helpful',
        'expected': 0,
      });
      expect(find.text('Your coding memory'), findsNWidgets(2));
      expect(find.text('Clear feedback'), findsOneWidget);
      expect(find.textContaining('Delivery not confirmed'), findsOneWidget);
      final helpful = tester.widget<DesktopPill>(
        find.widgetWithText(DesktopPill, 'Helpful'),
      );
      expect(helpful.selected, isTrue);
      expect(helpful.focusNode!.hasFocus, isTrue);
      expect(library.changes, changes);
      await tap(tester, 'Not helpful');
      expect(transport.previewed!['expected'], 1);
      expect(transport.recalls.single['feedback']['value'], 'unhelpful');
      await tap(tester, 'Clear feedback');
      expect(transport.previewed!['expected'], 2);
      expect(transport.recalls.single['feedback']['value'], isNull);
      expect(find.text('Clear feedback'), findsNothing);
      expect(transport.record['revision'], revision);
      expect(transport.record['evidence'], evidence);
      expect(library.items, hasLength(1));
    },
  );

  testWidgets('legacy feedback stays visibly separate from recall guidance', (
    tester,
  ) async {
    transport.recalls.add({
      ...syntheticRecall(value: 'helpful'),
      'canGuideRecall': false,
    });
    await mount(tester);
    await tap(tester, 'Read memory');
    expect(
      find.textContaining('earlier rating does not affect'),
      findsOneWidget,
    );
    expect(find.textContaining('matching conditions'), findsNothing);
    await tap(tester, 'Clear feedback');
    expect(find.textContaining('earlier rating does not affect'), findsNothing);
    expect(find.textContaining('Delivery not confirmed'), findsOneWidget);
  });

  testWidgets(
    'pending feedback disables controls and a changed owner prevents apply',
    (tester) async {
      transport.recalls.add(syntheticRecall());
      await mount(tester);
      await tap(tester, 'Read memory');
      final pending = Completer<Map<String, dynamic>>();
      transport.handle = (p) async =>
          p['action'] == 'preview' ? pending.future : transport.respond(p);
      await tester.ensureVisible(find.text('Helpful'));
      await tester.tap(find.text('Helpful'));
      await tester.pump();
      expect(
        tester
            .widget<DesktopPill>(
              find.widgetWithText(DesktopPill, 'Not helpful'),
            )
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Close'))
            .onPressed,
        isNull,
      );
      transport.invalidate();
      pending.complete({
        'ok': true,
        'capability': 'a' * 32,
        'expiresInMs': 120000,
        'preview': {},
      });
      await tester.pumpAndSettle();
      expect(find.textContaining('Delivery not confirmed'), findsNothing);
      expect(find.text('Helpful'), findsNothing);
      expect(transport.calls.where((c) => c['action'] == 'apply'), isEmpty);
    },
  );

  testWidgets(
    'a lost save reply is checked by refreshing without retrying the rating',
    (tester) async {
      transport.recalls.add(syntheticRecall());
      await mount(tester);
      await tap(tester, 'Read memory');
      transport.handle = (p) async {
        final result = transport.respond(p);
        if (p['action'] == 'apply') throw const CodingMemoryFailure('TIMEOUT');
        return result;
      };
      await tap(tester, 'Helpful');
      expect(
        find.textContaining('refresh to check whether it finished'),
        findsOneWidget,
      );
      expect(
        transport.calls.where((c) => c['action'] == 'apply'),
        hasLength(1),
      );
      transport.handle = null;
      await tap(tester, 'Refresh recent recall');
      expect(
        tester
            .widget<DesktopPill>(find.widgetWithText(DesktopPill, 'Helpful'))
            .selected,
        isTrue,
      );
      expect(
        transport.calls.where((c) => c['action'] == 'apply'),
        hasLength(1),
      );
    },
  );

  testWidgets(
    'stale feedback is refreshed explicitly and a reconnect during preview cannot apply',
    (tester) async {
      transport.recalls.add(syntheticRecall());
      await mount(tester);
      await tap(tester, 'Read memory');
      transport.refuseApply = 'FEEDBACK_CHANGED';
      await tap(tester, 'Helpful');
      expect(find.textContaining('feedback changed elsewhere'), findsOneWidget);
      transport.refuseApply = null;
      transport.recalls.single['feedback'] = {
        'value': 'unhelpful',
        'version': 5,
        'updatedAt': 1790762402000,
      };
      await tap(tester, 'Refresh recent recall');
      expect(
        tester
            .widget<DesktopPill>(
              find.widgetWithText(DesktopPill, 'Not helpful'),
            )
            .selected,
        isTrue,
      );
      final count = transport.calls.where((c) => c['action'] == 'apply').length;
      transport.handle = (p) async {
        final result = transport.respond(p);
        if (p['action'] == 'preview') transport.reconnect();
        return result;
      };
      await tap(tester, 'Helpful');
      expect(find.textContaining('connection changed'), findsOneWidget);
      expect(
        transport.calls.where((c) => c['action'] == 'apply'),
        hasLength(count),
      );
    },
  );

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'recall feedback wraps long projects in ${brightness.name} at $scale text',
        (tester) async {
          transport.recalls.add({
            ...syntheticRecall(value: 'helpful'),
            'project': {
              'name': 'Editor accessibility and collaboration research',
              'location': '/synthetic/workspaces/very-long-project-directory/desktop-editor',
            },
          });
          await mount(
            tester,
            brightness: brightness,
            scale: scale,
            size: const Size(620, 850),
          );
          await tap(tester, 'Read memory');
          await tester.ensureVisible(find.text('Recent recall'));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await capture(tester, 'feedback-${brightness.name}-${scale}x');
          await tap(tester, 'Not helpful');
          expect(transport.recalls.single['feedback']['value'], 'unhelpful');
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  testWidgets(
    'detail exposes retained evidence; forgetting requires a concrete preview and defaults to cancel',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      expect(
        find.text('When fixing a bug, write a small failing test first.'),
        findsOneWidget,
      );
      await tap(tester, 'Forget…');
      expect(find.textContaining('removes 2 memories'), findsOneWidget);
      expect(
        find.textContaining('Original conversations and context already sent'),
        findsOneWidget,
      );
      expect(transport.calls.where((c) => c['action'] == 'apply'), isEmpty);
      final cancel = tester.widget<TextButton>(
        find.widgetWithText(TextButton, 'Cancel'),
      );
      expect(cancel.focusNode!.hasFocus, isTrue);
      await tap(tester, 'Cancel');
      expect(transport.present, isTrue);
      await tap(tester, 'Read memory');
      await tap(tester, 'Forget…');
      await tap(tester, 'Forget memory');
      expect(transport.present, isFalse);
      expect(find.text('Read memory'), findsNothing);
    },
  );

  testWidgets(
    'stale correction preserves the draft and shows the current version before retry',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      await tap(tester, 'Correct memory');
      await tester.enterText(
        find.byType(TextFormField).first,
        'Prefer one focused regression test per bug.',
      );
      await tap(tester, 'Review correction');
      transport.refuseApply = 'PREVIEW_CHANGED';
      await tap(tester, 'Save correction');
      expect(
        find.text('Prefer one focused regression test per bug.'),
        findsOneWidget,
      );
      expect(find.textContaining('Your edit is still here'), findsOneWidget);
      transport.record = syntheticMemory(
        revision: 2,
        claim: 'Use integration tests at service boundaries.',
      );
      transport.refuseApply = null;
      await tap(tester, 'Refresh current version');
      expect(
        find.text('Use integration tests at service boundaries.'),
        findsOneWidget,
      );
      expect(
        find.text('Prefer one focused regression test per bug.'),
        findsOneWidget,
      );
      await tap(tester, 'Review correction');
      expect(transport.previewed!['revision'], 2);
      expect((transport.previewed!['fields'] as Map)['applicability'], {
        'task': 'bug_fix',
      });
      await tap(tester, 'Save correction');
      expect(
        transport.record['claim'],
        'Prefer one focused regression test per bug.',
      );
    },
  );

  testWidgets('account change clears open evidence and disables saving', (
    tester,
  ) async {
    await mount(tester);
    await tap(tester, 'Read memory');
    transport.invalidate();
    await tester.pumpAndSettle();
    expect(
      find.text('When fixing a bug, write a small failing test first.'),
      findsNothing,
    );
    expect(find.text('Correct memory'), findsNothing);
    expect(find.text('Memory unavailable'), findsOneWidget);
  });

  testWidgets(
    'project search is read-only; narrowing previews the selected folder and preserves evidence',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      await tap(tester, 'Limit to a project…');
      expect(find.text('/synthetic/work/editor'), findsOneWidget);
      expect(find.text('/synthetic/research/editor'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'research');
      await tester.pump(const Duration(milliseconds: 250));
      await tester.pumpAndSettle();
      expect(find.text('/synthetic/work/editor'), findsNothing);
      expect(
        transport.calls.where(
          (c) => ['preview', 'apply'].contains(c['action']),
        ),
        isEmpty,
      );
      await tap(tester, '/synthetic/research/editor');
      expect(transport.previewed, {
        'kind': 'narrow',
        'id': 'synthetic-memory',
        'revision': 1,
        'projectId': 'second-project',
      });
      expect(find.text('Limit this memory to a project?'), findsOneWidget);
      expect(
        find.textContaining('Limiting a memory does not confirm it'),
        findsOneWidget,
      );
      expect((transport.record['scope'] as Map)['projectId'], isNull);
      await tap(tester, 'Back');
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'research',
      );
      await tap(tester, '/synthetic/research/editor');
      final before = syntheticMemory();
      final pending = Completer<Map<String, dynamic>>();
      transport.handle = (p) async =>
          p['action'] == 'apply' ? pending.future : transport.respond(p);
      await tester.tap(find.text('Limit to project'));
      await tester.pump();
      expect(find.text('Limit to project'), findsNothing);
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Close'))
            .onPressed,
        isNull,
      );
      pending.complete(transport.respond({'action': 'apply'}));
      await tester.pumpAndSettle();
      expect(
        transport.calls.where((c) => c['action'] == 'apply'),
        hasLength(1),
      );
      for (final key in [
        'claim',
        'evidence',
        'evidenceClass',
        'state',
        'applicability',
        'exceptions',
      ]) {
        expect(transport.record[key], before[key]);
      }
      await tap(tester, 'Read memory');
      expect(find.text('/synthetic/research/editor'), findsOneWidget);
      expect(find.textContaining('Its evidence is unchanged'), findsOneWidget);
      expect(find.text('Limit to a project…'), findsNothing);
    },
  );

  testWidgets(
    'a changed revision must be reviewed before another project preview',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      await tap(tester, 'Limit to a project…');
      transport.record = syntheticMemory(
        revision: 2,
        claim: 'A newer preference to review.',
      );
      await library.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Choose a project'), findsNothing);
      expect(find.textContaining('Review its current details'), findsOneWidget);
      expect(transport.calls.where((c) => c['action'] == 'preview'), isEmpty);
      await tap(tester, 'Limit to a project…');
      await tap(tester, '/synthetic/work/editor');
      expect(transport.previewed!['revision'], 2);
      await tap(tester, 'Cancel');
      expect(transport.calls.where((c) => c['action'] == 'apply'), isEmpty);
    },
  );

  testWidgets(
    'late project searches and account changes cannot restore old choices',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      final older = Completer<Map<String, dynamic>>(),
          newer = Completer<Map<String, dynamic>>();
      transport.handle = (p) async {
        if (p['action'] != 'projects') return transport.respond(p);
        return (p['query'] as Map)['search'] == ''
            ? older.future
            : newer.future;
      };
      await tester.ensureVisible(find.text('Limit to a project…'));
      await tester.tap(find.text('Limit to a project…'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'research');
      await tester.pump(const Duration(milliseconds: 250));
      newer.complete({
        'ok': true,
        'items': [transport.projects.last],
        'nextBefore': null,
      });
      await tester.pumpAndSettle();
      expect(find.text('/synthetic/research/editor'), findsOneWidget);
      older.complete({
        'ok': true,
        'items': [transport.projects.first],
        'nextBefore': null,
      });
      await tester.pumpAndSettle();
      expect(find.text('/synthetic/work/editor'), findsNothing);
      final late = Completer<Map<String, dynamic>>();
      transport.handle = (p) async => late.future;
      await tester.enterText(find.byType(TextField), 'work');
      await tester.pump(const Duration(milliseconds: 250));
      transport.invalidate();
      await tester.pumpAndSettle();
      late.complete({
        'ok': true,
        'items': transport.projects,
        'nextBefore': null,
      });
      await tester.pumpAndSettle();
      expect(find.text('Memory unavailable'), findsOneWidget);
      expect(find.text('/synthetic/work/editor'), findsNothing);
      expect(find.text('/synthetic/research/editor'), findsNothing);
      expect(
        transport.calls.where(
          (c) => ['preview', 'apply'].contains(c['action']),
        ),
        isEmpty,
      );
    },
  );

  testWidgets(
    'privacy refresh removes excluded project rows from an open picker',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      await tap(tester, 'Limit to a project…');
      transport.projects.removeLast();
      transport.learn = false; // A changed library policy snapshot.
      await library.refresh();
      await tester.pumpAndSettle();
      expect(find.text('/synthetic/research/editor'), findsNothing);
      expect(find.text('/synthetic/work/editor'), findsOneWidget);
      expect(
        transport.calls.where(
          (c) => ['preview', 'apply'].contains(c['action']),
        ),
        isEmpty,
      );
    },
  );

  testWidgets(
    'an unavailable destination refreshes choices without substituting another project',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      await tap(tester, 'Limit to a project…');
      transport.handle = (p) async {
        if (p['action'] == 'preview') {
          transport.projects.removeLast();
          return {'ok': false, 'error': 'PROJECT_UNAVAILABLE'};
        }
        return transport.respond(p);
      };
      await tap(tester, '/synthetic/research/editor');
      expect(find.textContaining('Choose another project'), findsOneWidget);
      expect(find.text('/synthetic/research/editor'), findsNothing);
      expect(find.text('/synthetic/work/editor'), findsOneWidget);
      expect(
        transport.calls.where((c) => c['action'] == 'preview'),
        hasLength(1),
      );
      expect(transport.calls.where((c) => c['action'] == 'apply'), isEmpty);
    },
  );

  testWidgets(
    'search Return and paging only browse; Escape backs out one level',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      transport.handle = (p) async {
        if (p['action'] == 'projects') {
          final query = p['query'] as Map;
          return {
            'ok': true,
            'items': [
              query['before'] == null
                  ? transport.projects.first
                  : transport.projects.last,
            ],
            'nextBefore': query['before'] == null ? 9 : null,
          };
        }
        return transport.respond(p);
      };
      await tap(tester, 'Limit to a project…');
      await tester.showKeyboard(find.byType(TextField));
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(transport.calls.where((c) => c['action'] == 'preview'), isEmpty);
      await tap(tester, 'More projects');
      expect((transport.calls.last['query'] as Map)['before'], 9);
      await tap(tester, '/synthetic/research/editor');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Choose a project'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Your coding memory'), findsNWidgets(2));
      expect(find.text('Choose a project'), findsNothing);
      expect(transport.calls.where((c) => c['action'] == 'apply'), isEmpty);
    },
  );

  testWidgets(
    'refresh removes forgotten evidence from an already open detail view',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      transport.present = false;
      transport.record = syntheticMemory(revision: 2);
      await library.refresh();
      await tester.pumpAndSettle();
      expect(
        find.text('When fixing a bug, write a small failing test first.'),
        findsNothing,
      );
      expect(find.text('Correct memory'), findsNothing);
      expect(
        find.textContaining('removed or is no longer available'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'privacy refresh during editing preserves the draft without keeping source evidence',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Read memory');
      await tap(tester, 'Correct memory');
      await tester.enterText(
        find.byType(TextFormField).first,
        'My unsaved correction.',
      );
      transport.record = syntheticMemory(
        revision: 2,
        claim: 'A changed preference.',
      );
      await library.refresh();
      await tester.pumpAndSettle();
      expect(find.text('My unsaved correction.'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(Dialog),
          matching: find.text('A changed preference.'),
        ),
        findsOneWidget,
      );
      expect(
        find.text('When fixing a bug, write a small failing test first.'),
        findsNothing,
      );
    },
  );

  testWidgets(
    'stalled learning is visible from the library and review only navigates',
    (tester) async {
      transport.runtime = {
        'state': 'ready',
        'learning': {'state': 'waiting_for_model'},
        'capture': {'state': 'unavailable', 'reason': 'memory_backlog_full'},
      };
      await mount(tester);
      expect(find.text('Learning needs attention'), findsOneWidget);
      expect(find.textContaining('queue is full'), findsOneWidget);
      expect(
        find.textContaining('terminal beside this viewer'),
        findsOneWidget,
      );
      await tap(tester, 'Review learning');
      expect(find.text('Learn from coding sessions'), findsOneWidget);
      expect(find.textContaining('queue is full'), findsOneWidget);
      expect(
        transport.calls.every(
          (p) => p['action'] != 'preview' && p['action'] != 'apply',
        ),
        isTrue,
      );
      expect(transport.learn, isTrue);
      expect(transport.recall, isTrue);

      transport.runtime = {
        'state': 'ready',
        'learning': {'state': 'idle'},
        'capture': {'state': 'idle', 'sources': 0},
      };
      await library.refresh();
      await tester.pumpAndSettle();
      expect(find.textContaining('queue is full'), findsNothing);
      expect(find.textContaining('No work is ready'), findsOneWidget);
      await tap(tester, 'How you work');
      expect(find.text('Learning needs attention'), findsNothing);
    },
  );

  testWidgets('pausing learning hides stale failures and preserves recall', (
    tester,
  ) async {
    transport.learn = false;
    transport.runtime = {
      'state': 'off',
      'learning': {'state': 'failed'},
      'capture': {'state': 'unavailable', 'reason': 'memory_backlog_full'},
    };
    await mount(tester);
    expect(find.text('Learning needs attention'), findsNothing);
    await tap(tester, 'Learning');
    expect(find.textContaining('Learning is paused'), findsOneWidget);
    expect(find.textContaining('queue is full'), findsNothing);
    expect(tester.widgetList<Switch>(find.byType(Switch)).map((s) => s.value), [
      false,
      true,
    ]);
  });

  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'provider refusal explains recovery without changing settings at ${scale}x',
      (tester) async {
        transport.runtime = {
          'state': 'ready',
          'learning': {
            'state': 'waiting_for_model',
            'reason': 'inference_provider_restricted',
          },
        };
        await mount(
          tester,
          scale: scale,
          size: Size(scale == 1 ? 850 : 440, 900),
        );
        expect(find.text('Learning needs attention'), findsOneWidget);
        expect(
          find.textContaining('provider declined background learning'),
          findsOneWidget,
        );
        await capture(tester, 'provider-refusal-${scale}x');
        await tap(tester, 'Review learning');
        expect(find.textContaining('Choose another model'), findsOneWidget);
        expect(find.textContaining('complete any setup'), findsNothing);
        expect(transport.learn, isTrue);
        expect(transport.recall, isTrue);
        expect(
          transport.calls.every(
            (p) => p['action'] != 'preview' && p['action'] != 'apply',
          ),
          isTrue,
        );
        expect(tester.takeException(), isNull);
        transport.runtime = {
          'state': 'ready',
          'learning': {'state': 'learned', 'learned': 1},
        };
        await library.refresh();
        await tester.pumpAndSettle();
        expect(find.textContaining('provider declined'), findsNothing);
        expect(find.textContaining('saved new memories'), findsOneWidget);
      },
    );
  }

  for (final state in [
    ('off', null, 'Resume it', true),
    ('unavailable', null, 'memory service', true),
    ('ready', 'failed', 'could not finish', true),
    ('ready', 'source_incomplete', 'incomplete source evidence', true),
    ('ready', 'no_useful_memory', 'no useful memory to save', false),
    ('ready', 'foreground_busy', 'until it is free', false),
    ('ready', 'budget_deferred', 'next learning allowance', false),
    ('ready', 'future_state', 'Learning is on.', false),
  ]) {
    testWidgets('learning distinguishes ${state.$1}/${state.$2}', (
      tester,
    ) async {
      transport.runtime = {
        'state': state.$1,
        'learning': {'state': state.$2},
      };
      await mount(tester);
      expect(
        find.text('Learning needs attention'),
        state.$4 ? findsOneWidget : findsNothing,
      );
      await tap(tester, 'Learning');
      expect(find.textContaining(state.$3), findsOneWidget);
      expect(
        find.textContaining('Learning from completed coding work.'),
        findsNothing,
      );
    });
  }

  for (final reason in [
    'companion_unopened',
    'companion_stopped',
    'inference_provider_restricted',
  ]) {
    testWidgets('memory recovery explicitly opens the companion for $reason', (
      tester,
    ) async {
      var opened = 0;
      transport.runtime = {
        'state': 'ready',
        'learning': {'state': 'waiting_for_model', 'reason': reason},
      };
      await mount(tester, onOpenCompanion: () => opened++);
      expect(opened, 0, reason: 'Reading memories cannot launch an agent.');
      await tap(tester, 'Open companion terminal');
      expect(opened, 1);
      await tap(tester, 'Review learning');
      await tap(tester, 'Open companion terminal');
      expect(opened, 2);
      expect(transport.learn, isTrue);
      expect(transport.recall, isTrue);
      expect(
        transport.calls.where(
          (p) => ['preview', 'apply'].contains(p['action']),
        ),
        isEmpty,
      );
      transport.runtime = {
        'state': 'ready',
        'learning': {'state': 'learned', 'learned': 1},
      };
      await library.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Open companion terminal'), findsNothing);
    });
  }

  testWidgets(
    'pending recovery is disabled, while a paused or stale owner cannot open it',
    (tester) async {
      var opened = 0;
      transport.runtime = {
        'state': 'ready',
        'learning': {
          'state': 'waiting_for_model',
          'reason': 'companion_stopped',
        },
      };
      await mount(
        tester,
        onOpenCompanion: () => opened++,
        openingCompanion: true,
      );
      expect(
        tester
            .widget<TextButton>(
              find.byKey(const ValueKey('memory-open-companion')),
            )
            .onPressed,
        isNull,
      );
      expect(find.text('Opening terminal…'), findsOneWidget);
      expect(opened, 0);

      await mount(tester, onOpenCompanion: () => opened++);
      final stale = tester
          .widget<TextButton>(
            find.byKey(const ValueKey('memory-open-companion')),
          )
          .onPressed!;
      transport.learn = false;
      await library.refresh();
      stale();
      await tester.pumpAndSettle();
      expect(opened, 0);
      expect(find.text('Open companion terminal'), findsNothing);
      transport.learn = true;
      await library.refresh();
      await tester.pumpAndSettle();
      final oldOwner = tester
          .widget<TextButton>(
            find.byKey(const ValueKey('memory-open-companion')),
          )
          .onPressed!;
      transport.invalidate();
      oldOwner();
      expect(opened, 0);
      await tester.pumpAndSettle();
      expect(find.text('Open companion terminal'), findsNothing);
    },
  );

  for (final reason in [
    ('companion_unopened', 'Start your companion'),
    ('companion_stopped', 'Reopen its conversation'),
    ('companion_starting', 'finish starting'),
    ('companion_model_unavailable', 'Choose a model'),
    ('companion_connection_unavailable', 'current model connection'),
    ('companion_account_unavailable', 'could not verify'),
    ('companion_configuration_unsupported', 'agent or provider configuration'),
    ('claude_version_uncertified', 'this version of your selected agent'),
    ('codex_version_uncertified', 'this version of your selected agent'),
    ('opencode_version_uncertified', 'this version of your selected agent'),
    ('inference_context_changed', 'will check the new selection'),
    (
      'unknown-private-provider-text',
      'Check that its terminal beside this viewer',
    ),
  ]) {
    testWidgets('learning shows a recovery step for ${reason.$1}', (
      tester,
    ) async {
      transport.runtime = {
        'state': 'ready',
        'learning': {'state': 'waiting_for_model', 'reason': reason.$1},
      };
      await mount(tester);
      expect(find.textContaining(reason.$2), findsOneWidget);
      expect(
        find.textContaining('unknown-private-provider-text'),
        findsNothing,
      );
      await tap(tester, 'Review learning');
      expect(find.textContaining(reason.$2), findsOneWidget);
      expect(transport.learn, isTrue);
      expect(transport.recall, isTrue);
      expect(
        transport.calls.any((p) => ['preview', 'apply'].contains(p['action'])),
        isFalse,
      );
      expect(tester.takeException(), isNull);

      transport.runtime = {
        'state': 'ready',
        'learning': {'state': 'learned', 'learned': 1},
      };
      await library.refresh();
      await tester.pumpAndSettle();
      expect(find.textContaining(reason.$2), findsNothing);
      expect(find.textContaining('saved new memories'), findsOneWidget);
    });
  }

  for (final brightness in [Brightness.dark, Brightness.light]) {
    testWidgets(
      'stopped companion and backlog fit ${brightness.name} at large text',
      (tester) async {
        transport.runtime = {
          'state': 'ready',
          'learning': {
            'state': 'waiting_for_model',
            'reason': 'companion_stopped',
          },
          'capture': {'state': 'unavailable', 'reason': 'memory_backlog_full'},
        };
        await mount(
          tester,
          brightness: brightness,
          scale: 2,
          size: const Size(440, 1100),
          onOpenCompanion: () {},
        );
        expect(find.textContaining('Reopen its conversation'), findsOneWidget);
        expect(find.textContaining('queue is full'), findsOneWidget);
        await capture(
          tester,
          'companion-stopped-${brightness.name}-large-text',
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  for (final brightness in [Brightness.dark, Brightness.light]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'learning backlog ${brightness.name} ${scale}x stays readable',
        (tester) async {
          transport.runtime = {
            'state': 'ready',
            'learning': {'state': 'waiting_for_model'},
            'capture': {
              'state': 'unavailable',
              'reason': 'memory_backlog_full',
            },
          };
          await mount(
            tester,
            brightness: brightness,
            scale: scale,
            size: Size(scale == 1 ? 850 : 440, 900),
          );
          await capture(tester, 'learning-notice-${brightness.name}-${scale}x');
          await tap(tester, 'Review learning');
          await capture(tester, 'learning-status-${brightness.name}-${scale}x');
          await tester.ensureVisible(find.text('Recall useful memories'));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  testWidgets(
    'learning and recall remain independent and do not change until settings are applied',
    (tester) async {
      await mount(tester);
      await tap(tester, 'Learning');
      expect(find.textContaining('4 session segments'), findsOneWidget);
      expect(find.textContaining('1 segment expired'), findsOneWidget);
      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();
      expect(transport.learn, isTrue);
      expect(find.text('Learning: Paused'), findsOneWidget);
      expect(find.text('Recall: On'), findsOneWidget);
      await tap(tester, 'Apply settings');
      expect(transport.learn, isFalse);
      expect(transport.recall, isTrue);
    },
  );

  testWidgets('a pending apply disables close and cannot submit twice', (
    tester,
  ) async {
    await mount(tester);
    await tap(tester, 'Read memory');
    await tap(tester, 'Forget…');
    final pending = Completer<Map<String, dynamic>>();
    transport.handle = (p) async =>
        p['action'] == 'apply' ? pending.future : transport.respond(p);
    await tester.tap(find.text('Forget memory'));
    await tester.pump();
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Close'))
          .onPressed,
      isNull,
    );
    expect(find.text('Forget memory'), findsNothing);
    pending.complete({'ok': true});
    await tester.pumpAndSettle();
    expect(transport.calls.where((c) => c['action'] == 'apply'), hasLength(1));
  });

  for (final brightness in [Brightness.light, Brightness.dark]) {
    for (final scale in [1.0, 1.6, 2.0]) {
      testWidgets(
        'project choices and preview fit ${brightness.name} at ${scale}x in a short window',
        (tester) async {
          const name = 'editor-with-a-very-long-but-recognizable-project-name';
          const location =
              '/synthetic/development/a-very-long-path-that-distinguishes-this-checkout/editor';
          transport.projects.first.addAll({'name': name, 'location': location});
          await mount(
            tester,
            brightness: brightness,
            scale: scale,
            size: Size(scale == 1 ? 760 : 480, 620),
          );
          await tap(tester, 'Read memory');
          await tap(tester, 'Limit to a project…');
          expect(tester.takeException(), isNull);
          await capture(tester, 'project-picker-${brightness.name}-${scale}x');
          await tap(tester, name);
          expect(tester.takeException(), isNull);
          await capture(tester, 'scope-preview-${brightness.name}-${scale}x');
          await tap(tester, 'Cancel');
          expect(transport.calls.where((c) => c['action'] == 'apply'), isEmpty);
        },
      );
    }
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'memory review fits ${brightness.name} at ${scale}x and narrow width',
        (tester) async {
          await mount(
            tester,
            brightness: brightness,
            scale: scale,
            size: Size(scale == 1 ? 760 : 480, 820),
          );
          await tap(tester, 'Read memory');
          expect(tester.takeException(), isNull);
          await capture(tester, 'memory-${brightness.name}-${scale}x');
          await tap(tester, 'Correct memory');
          expect(tester.takeException(), isNull);
          await tap(tester, 'Review correction');
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
}
