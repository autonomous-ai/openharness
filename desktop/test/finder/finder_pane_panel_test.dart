import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/widgets/finder_pane_panel.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'fakes.dart';

void main() {
  late FakeFinderFiles files;
  late FakeFinderGit git;
  late List<double?> widths;

  Future<void> pumpPanel(WidgetTester tester) async {
    files = FakeFinderFiles();
    git = FakeFinderGit();
    widths = [];
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Builder(
          builder: (context) {
            grid.AppTheme.brightness.value = Theme.of(context).brightness;
            return grid.BrightnessScope(
              child: Scaffold(
                body: FinderPanePanel(
                  root: '/r',
                  files: files,
                  git: git,
                  onFixedWidth: widths.add,
                ),
              ),
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// Types [text] the way the system sends it to re_editor: as a delta on
  /// the text input channel, to the client the editor registered.
  Future<void> type(WidgetTester tester, String text) async {
    final setClient = tester.testTextInput.log.lastWhere(
      (call) => call.method == 'TextInput.setClient',
    );
    final id = (setClient.arguments as List)[0] as int;
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      SystemChannels.textInput.name,
      SystemChannels.textInput.codec.encodeMethodCall(
        MethodCall('TextInputClient.updateEditingStateWithDeltas', [
          id,
          {
            'deltas': [
              {
                'oldText': '',
                'deltaText': text,
                'deltaStart': 0,
                'deltaEnd': 0,
                'selectionBase': text.length,
                'selectionExtent': text.length,
                'selectionAffinity': 'TextAffinity.downstream',
                'selectionIsDirectional': false,
                'composingBase': -1,
                'composingExtent': -1,
              },
            ],
          },
        ]),
      ),
      (_) {},
    );
    await tester.pump();
  }

  Finder tab(String path) => find.byKey(ValueKey('finder-tab-file:$path'));

  testWidgets('a click previews a file; a second click keeps it', (
    tester,
  ) async {
    await pumpPanel(tester);
    expect(find.byKey(const ValueKey('finder-code-editor')), findsNothing);

    await tester.tap(find.text('lib'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('main.dart'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('finder-code-editor')), findsOneWidget);
    final title = find.descendant(
      of: tab('/r/lib/main.dart'),
      matching: find.text('main.dart'),
    );
    expect(tester.widget<Text>(title).style?.fontStyle, FontStyle.italic);

    // A double click: the second click within the window, on the clock the
    // test moves, so a slow runner cannot split it into two single clicks.
    await tester.tap(find.text('main.dart').first);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.text('main.dart').first);
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(title).style?.fontStyle,
      isNot(FontStyle.italic),
    );
  });

  testWidgets('typing marks the tab unsaved and ⌘S saves it', (tester) async {
    await pumpPanel(tester);
    await tester.tap(find.text('lib'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('main.dart'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('finder-code-editor')));
    await tester.pump();
    await type(tester, 'x');
    expect(find.byKey(const ValueKey('finder-tab-dirty')), findsOneWidget);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyS);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pumpAndSettle();
    expect(files.writes['/r/lib/main.dart'], contains('x'));
    expect(find.byKey(const ValueKey('finder-tab-dirty')), findsNothing);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('closing an unsaved tab asks; Don’t Save drops the edits', (
    tester,
  ) async {
    await pumpPanel(tester);
    await tester.tap(find.text('README.md'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('finder-markdown-source')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('finder-code-editor')));
    await tester.pump();
    await type(tester, 'y');
    expect(find.byKey(const ValueKey('finder-tab-dirty')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('finder-tab-close')));
    await tester.pumpAndSettle();
    expect(find.text('Unsaved changes'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('finder-dialog-Don’t Save')));
    await tester.pumpAndSettle();
    expect(tab('/r/README.md'), findsNothing);
    expect(files.writes, isEmpty);
  });

  testWidgets('Markdown opens rendered and switches to its source', (
    tester,
  ) async {
    await pumpPanel(tester);
    await tester.tap(find.text('README.md'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('finder-markdown')), findsOneWidget);
    expect(find.text('Hello'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('finder-markdown-source')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('finder-code-editor')), findsOneWidget);
  });

  testWidgets('a change opens its diff, inline or side by side', (
    tester,
  ) async {
    await pumpPanel(tester);
    await tester.tap(find.byKey(const ValueKey('finder-mode-changes')));
    await tester.pumpAndSettle();
    expect(find.text('Changes  1'), findsWidgets);
    expect(find.text('+1 '), findsOneWidget);

    await tester.tap(find.text('main.dart'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('finder-diff')), findsOneWidget);
    expect(find.textContaining('old line', findRichText: true), findsOneWidget);
    expect(find.textContaining('new line', findRichText: true), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('finder-diff-layout')));
    await tester.pumpAndSettle();
    expect(find.byType(VerticalDivider), findsWidgets);
  });

  testWidgets('a change stages from under the pointer', (tester) async {
    await pumpPanel(tester);
    await tester.tap(find.byKey(const ValueKey('finder-mode-changes')));
    await tester.pumpAndSettle();
    final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await gesture.addPointer(
      location: tester.getCenter(find.text('main.dart')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('finder-change-stage')));
    await tester.pumpAndSettle();
    expect(git.staged, ['lib/main.dart']);
    await gesture.removePointer();
  });

  testWidgets('New File names a file in place and opens it', (tester) async {
    await pumpPanel(tester);
    await tester.tap(find.byKey(const ValueKey('finder-new-file')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('finder-name-field')),
      'notes.md',
    );
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(files.texts.containsKey('/r/notes.md'), isTrue);
    expect(tab('/r/notes.md'), findsOneWidget);
  });

  testWidgets('with no file open it asks only for its file list\'s width', (
    tester,
  ) async {
    await pumpPanel(tester);
    expect(widths, [265]);

    await tester.tap(find.text('README.md'));
    await tester.pumpAndSettle();
    expect(widths.last, isNull, reason: 'a file open takes its share');

    await tester.tap(find.byKey(const ValueKey('finder-tab-close')));
    await tester.pumpAndSettle();
    expect(widths.last, 265);
  });

  testWidgets('Collapse folds it to a rail; the rail opens it again', (
    tester,
  ) async {
    await pumpPanel(tester);
    await tester.tap(find.byKey(const ValueKey('finder-collapse')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('finder-rail')), findsOneWidget);
    expect(widths.last, 44);

    await tester.tap(find.byKey(const ValueKey('finder-rail-changes')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('finder-rail')), findsNothing);
    expect(find.byKey(const ValueKey('finder-changes')), findsOneWidget);
    expect(widths.last, 265);
  });
}
