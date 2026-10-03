import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/remote_folder_picker.dart';

/// A machine whose folders are answered by the test, one `fs_list_dir` at a
/// time: each ask waits on a completer the test settles, in whatever order it
/// likes — which is how a slow answer arriving after a newer one is staged.
class _Folders extends AppNotifier {
  _Folders()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    const studio = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Studio',
    );
    machines = [studio];
    machineStates['m'] = MachineState(studio);
  }

  /// Every ask, in order, with the completer that answers it.
  final asks = <({String? path, Completer<Map<String, dynamic>> reply})>[];

  @override
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) {
    final reply = Completer<Map<String, dynamic>>();
    asks.add((path: path, reply: reply));
    return reply.future;
  }

  /// Answers the newest ask not yet answered for [path].
  void answer(String? path, Map<String, dynamic> reply) => asks
      .lastWhere((ask) => ask.path == path && !ask.reply.isCompleted)
      .reply
      .complete(reply);
}

Map<String, dynamic> _listing(
  String path,
  List<String> folders, {
  bool truncated = false,
}) => {
  'path': path,
  'entries': [
    for (final name in folders) {'name': name, 'isDir': true},
  ],
  if (truncated) 'truncated': true,
};

void main() {
  late _Folders app;

  setUp(() => app = _Folders());
  tearDown(() => app.dispose());

  /// Opens the picker from a page, the way the New agent form does, and hands
  /// back what it resolved to — or `'<open>'` while it is still up.
  Future<ValueNotifier<String?>> open(
    WidgetTester tester, {
    String? initialPath,
    double height = 900,
  }) async {
    tester.view.physicalSize = Size(430, height);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final result = ValueNotifier<String?>('<closed>');
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  result.value = '<open>';
                  result.value = await showRemoteFolderPicker(
                    context,
                    notifier: app,
                    machineId: 'm',
                    initialPath: initialPath,
                  );
                },
                child: const Text('Browse'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Browse'));
    // Not `pumpAndSettle`: while a folder loads, its skeleton breathes for as
    // long as the machine takes, which here is until the test answers.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    return result;
  }

  FilledButton selectButton(WidgetTester tester) =>
      tester.widget<FilledButton>(find.byType(FilledButton));

  TextField pathField(WidgetTester tester) =>
      tester.widget<TextField>(find.byKey(const Key('remote-folder-path')));

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump();
  }

  testWidgets('opens on the folder it was given, lists only folders, and '
      'Select hands that folder back', (tester) async {
    final result = await open(tester, initialPath: '/home/me/code');
    expect(app.asks.single.path, '/home/me/code');
    expect(find.text('On Studio'), findsOneWidget);
    // Still asking: a skeleton stands in, and nothing can be chosen yet.
    expect(find.bySemanticsLabel('Loading folders'), findsOneWidget);
    expect(selectButton(tester).onPressed, isNull);

    app.answer('/home/me/code', {
      'path': '/home/me/code',
      'entries': [
        {'name': 'app', 'isDir': true},
        // A file is not somewhere an agent can be started.
        {'name': 'notes.txt', 'isDir': false},
        // An older CLI says nothing about the kind: taken as a folder.
        {'name': 'site'},
        // Nameless and malformed entries are dropped, not drawn blank.
        {'name': '', 'isDir': true},
        {'isDir': true},
        42,
      ],
    });
    await settle(tester);

    expect(find.text('app'), findsOneWidget);
    expect(find.text('site'), findsOneWidget);
    expect(find.text('notes.txt'), findsNothing);
    expect(pathField(tester).controller!.text, '/home/me/code');
    expect(find.text('Folders'), findsOneWidget);

    await tester.tap(find.text('Select this folder'));
    await tester.pumpAndSettle();
    expect(result.value, '/home/me/code');
  });

  testWidgets('a row opens that folder, and Up comes back to the parent', (
    tester,
  ) async {
    await open(tester, initialPath: '/home/me');
    app.answer('/home/me', _listing('/home/me', ['code', 'docs']));
    await settle(tester);

    await tester.tap(find.text('code'));
    await settle(tester);
    expect(app.asks.last.path, '/home/me/code');
    app.answer('/home/me/code', _listing('/home/me/code', []));
    await settle(tester);
    expect(find.text('No subfolders here.'), findsOneWidget);
    expect(pathField(tester).controller!.text, '/home/me/code');

    await tester.tap(find.byTooltip('Up one folder (Alt+↑)'));
    await settle(tester);
    expect(app.asks.last.path, '/home/me');
    app.answer('/home/me', _listing('/home/me', ['code', 'docs']));
    await settle(tester);
    expect(pathField(tester).controller!.text, '/home/me');
  });

  testWidgets('Up stops at the root', (tester) async {
    await open(tester, initialPath: '/');
    app.answer('/', _listing('/', ['home']));
    await settle(tester);
    final up = tester.widget<IconButton>(
      find.widgetWithIcon(IconButton, Icons.arrow_upward),
    );
    expect(up.onPressed, isNull, reason: 'a root has no parent to go up to');
  });

  testWidgets('a Windows machine is walked with its own separators', (
    tester,
  ) async {
    await open(tester, initialPath: r'C:\Users\me');
    app.answer(r'C:\Users\me', _listing(r'C:\Users\me', ['Documents']));
    await settle(tester);

    await tester.tap(find.text('Documents'));
    await settle(tester);
    // Not `C:\Users\me/Documents`: the path is the far machine's, not this
    // phone's.
    expect(app.asks.last.path, r'C:\Users\me\Documents');
    app.answer(
      r'C:\Users\me\Documents',
      _listing(r'C:\Users\me\Documents', []),
    );
    await settle(tester);

    await tester.tap(find.byTooltip('Up one folder (Alt+↑)'));
    await settle(tester);
    expect(app.asks.last.path, r'C:\Users\me');
  });

  testWidgets('Home asks the machine for its own home folder', (tester) async {
    await open(tester, initialPath: '/srv/app');
    app.answer('/srv/app', _listing('/srv/app', []));
    await settle(tester);

    await tester.tap(find.byKey(const Key('remote-folder-home')));
    await settle(tester);
    expect(app.asks.last.path, isNull);
    expect(pathField(tester).controller!.text, isEmpty);
    app.answer(null, _listing('/Users/me', ['code']));
    await settle(tester);
    expect(pathField(tester).controller!.text, '/Users/me');
    expect(find.text('code'), findsOneWidget);
  });

  for (final (code, sentence) in [
    ('FORBIDDEN', 'Choose a folder inside your home directory'),
    ('PERMISSION_DENIED', 'permission to open this folder'),
    ('NOT_A_DIRECTORY', 'That path is not a folder.'),
    ('NOT_FOUND', 'This folder could not be found.'),
    ('INVALID_PATH', 'Enter a full folder path on this machine.'),
    ('UNREACHABLE', 'reach this machine'),
    ('SOMETHING_NEW', 'open this folder. Try again.'),
  ]) {
    testWidgets('$code is said in words, with a Retry', (tester) async {
      await open(tester, initialPath: '/x');
      app.answer('/x', {'error': code});
      await settle(tester);
      expect(find.textContaining(sentence), findsOneWidget);
      expect(selectButton(tester).onPressed, isNull);
      expect(
        find.text('Enter a path or open your home folder.'),
        findsOneWidget,
        reason: 'nothing has loaded yet, so the list says how to begin',
      );

      await tester.tap(find.text('Retry'));
      await settle(tester);
      expect(app.asks.last.path, '/x');
      app.answer('/x', _listing('/x', ['a']));
      await settle(tester);
      expect(find.textContaining(sentence), findsNothing);
      expect(selectButton(tester).onPressed, isNotNull);
    });
  }

  testWidgets('an answer with no path, or a machine that throws, is an error '
      'too', (tester) async {
    await open(tester, initialPath: '/x');
    app.answer('/x', const {});
    await settle(tester);
    expect(find.textContaining('open this folder. Try again.'), findsOneWidget);

    await tester.tap(find.text('Retry'));
    await settle(tester);
    app.asks.last.reply.completeError(StateError('socket closed'));
    await settle(tester);
    expect(find.textContaining('reach this machine'), findsOneWidget);
  });

  testWidgets('a long listing says there is more than it shows', (
    tester,
  ) async {
    await open(tester, initialPath: '/big');
    app.answer('/big', _listing('/big', ['a', 'b'], truncated: true));
    await settle(tester);
    expect(
      find.text(
        'More folders are available. Enter their full path to open them.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a typed path opens on submit, and Select waits for it to load', (
    tester,
  ) async {
    await open(tester, initialPath: '/home/me');
    app.answer('/home/me', _listing('/home/me', ['code']));
    await settle(tester);

    await tester.enterText(
      find.byKey(const Key('remote-folder-path')),
      '/srv/site ',
    );
    await tester.pump();
    // The field no longer names what the list shows: say which folder that is,
    // and do not let Select pick a folder the person has typed their way off.
    expect(find.text('Showing /home/me'), findsOneWidget);
    expect(selectButton(tester).onPressed, isNull);

    await tester.tap(find.byTooltip('Open path'));
    await settle(tester);
    expect(app.asks.last.path, '/srv/site');
    // Asked twice while that ask is in flight: still one ask.
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester);
    expect(app.asks.where((ask) => ask.path == '/srv/site'), hasLength(1));

    app.answer('/srv/site', _listing('/srv/site', []));
    await settle(tester);
    expect(pathField(tester).controller!.text, '/srv/site');
    expect(selectButton(tester).onPressed, isNotNull);
  });

  testWidgets('a slower, older answer does not replace a newer one', (
    tester,
  ) async {
    final result = await open(tester, initialPath: '/slow');
    // Before /slow answers, the person types another folder and opens it.
    await tester.enterText(find.byKey(const Key('remote-folder-path')), '/b');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester);
    expect(app.asks.map((ask) => ask.path), ['/slow', '/b']);

    app.answer('/b', _listing('/b', ['from-b']));
    await settle(tester);
    app.answer('/slow', _listing('/slow', ['from-slow']));
    await settle(tester);

    expect(find.text('from-b'), findsOneWidget);
    expect(find.text('from-slow'), findsNothing);
    expect(pathField(tester).controller!.text, '/b');
    await tester.tap(find.text('Select this folder'));
    await tester.pumpAndSettle();
    expect(result.value, '/b');
  });

  testWidgets('an edit made while a folder loads is kept, and its failure is '
      'not blamed on the draft', (tester) async {
    await open(tester, initialPath: '/a');
    await tester.enterText(find.byKey(const Key('remote-folder-path')), '/dra');
    await tester.pump();
    app.answer('/a', _listing('/a', ['one']));
    await settle(tester);
    // The listing lands; the draft stays exactly as typed.
    expect(pathField(tester).controller!.text, '/dra');
    expect(find.text('Showing /a'), findsOneWidget);
    expect(selectButton(tester).onPressed, isNull);

    await tester.enterText(find.byKey(const Key('remote-folder-path')), '/x');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester);
    await tester.enterText(find.byKey(const Key('remote-folder-path')), '/xy');
    await tester.pump();
    app.answer('/x', {'error': 'NOT_FOUND'});
    await settle(tester);
    expect(
      find.textContaining('could not be found'),
      findsNothing,
      reason: 'the failure was about /x, and the field says /xy now',
    );
  });

  testWidgets('Cancel hands back nothing and puts the keyboard away', (
    tester,
  ) async {
    final result = await open(tester, initialPath: '/a');
    app.answer('/a', _listing('/a', []));
    await settle(tester);
    tester.testTextInput.log.clear();

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(result.value, isNull);
    expect(
      tester.testTextInput.log.map((call) => call.method),
      contains('TextInput.hide'),
    );
  });

  testWidgets('a tap on the veil closes it too', (tester) async {
    final result = await open(tester, initialPath: '/a');
    app.answer('/a', _listing('/a', []));
    await settle(tester);
    await tester.tapAt(const Offset(4, 4));
    await tester.pumpAndSettle();
    expect(result.value, isNull);
    expect(find.text('Choose a folder'), findsNothing);
  });

  testWidgets('on a phone the path field does not raise the keyboard over the '
      'list it opens on', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    await open(tester, initialPath: '/a');
    app.answer('/a', _listing('/a', ['one']));
    await settle(tester);
    expect(pathField(tester).autofocus, isFalse);
    expect(tester.testTextInput.hasAnyClients, isFalse);
    // The field and the buttons under it are sized for a thumb, to one height.
    expect(
      tester.getSize(find.byKey(const Key('remote-folder-path'))).height,
      44,
    );
    for (final label in ['Cancel', 'Select this folder']) {
      expect(
        tester
            .getSize(
              find.ancestor(
                of: find.text(label),
                matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
              ),
            )
            .height,
        greaterThanOrEqualTo(44),
        reason: label,
      );
    }
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('with a hardware keyboard the list is walked by its keys', (
    tester,
  ) async {
    final result = await open(tester, initialPath: '/p');
    app.answer('/p', _listing('/p', ['a', 'b', 'c']));
    await settle(tester);

    // From the field, ↓ steps into the list.
    await tester.tap(find.byKey(const Key('remote-folder-path')));
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();

    bool selected(String name) => tester
        .widgetList<Semantics>(
          find.ancestor(of: find.text(name), matching: find.byType(Semantics)),
        )
        .any((row) => row.properties.selected == true);
    expect(selected('a'), isTrue);

    await tester.sendKeyEvent(LogicalKeyboardKey.end);
    await tester.pump();
    expect(selected('c'), isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    expect(selected('b'), isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.home);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(selected('b'), isTrue);
    // A key the list has no use for is left to whoever else wants it.
    await tester.sendKeyEvent(LogicalKeyboardKey.keyQ);
    // A chord is somebody else's shortcut, not a step through the list.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();
    expect(selected('b'), isTrue);

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await settle(tester);
    expect(app.asks.last.path, '/p/b');
    app.answer('/p/b', _listing('/p/b', ['deep']));
    await settle(tester);

    // ← goes back up, with the folder we came out of still the one picked.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await settle(tester);
    expect(app.asks.last.path, '/p');
    app.answer('/p', _listing('/p', ['a', 'b', 'c']));
    await settle(tester);
    expect(selected('b'), isTrue);

    // Alt+↑ is Up from anywhere in the sheet.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await settle(tester);
    expect(app.asks.last.path, '/');
    app.answer('/', _listing('/', ['p']));
    await settle(tester);

    // Ctrl+Enter picks the folder on show.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(result.value, '/');
  });

  testWidgets('a folder picked far down a long list is scrolled into view', (
    tester,
  ) async {
    final names = [
      for (var i = 0; i < 40; i++) 'f${i.toString().padLeft(2, '0')}',
    ];
    await open(tester, initialPath: '/p/f35');
    app.answer('/p/f35', _listing('/p/f35', []));
    await settle(tester);
    await tester.tap(find.byTooltip('Up one folder (Alt+↑)'));
    await settle(tester);
    app.answer('/p', _listing('/p', names));
    await settle(tester);
    await tester.pump();
    // The row we came out of is on screen, not thirty rows below the fold.
    expect(find.text('f35').hitTestable(), findsOneWidget);
  });
}
