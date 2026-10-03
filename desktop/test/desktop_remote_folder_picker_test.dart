import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/remote_folder_picker.dart';
import 'package:harness/widgets/swarm_dialogs.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;

final _renderDir = Platform.environment['DESKTOP_REMOTE_FOLDER_RENDER_DIR'];
final _picture = GlobalKey();

Future<void> _capture(WidgetTester tester, String name) async {
  if (_renderDir == null) return;
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1.5);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    Directory(_renderDir!).createSync(recursive: true);
    await File('$_renderDir/$name.png')
        .writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
}

class _Folders extends AppNotifier {
  _Folders()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    machineStates['remote'] = MachineState(
      const Machine(
        machineId: 'remote',
        name: 'Studio Mac',
        authMode: MachineAuthMode.remote,
      ),
    );
  }

  final requests =
      <
        ({String machine, String? path, Completer<Map<String, dynamic>> reply})
      >[];

  @override
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) {
    final reply = Completer<Map<String, dynamic>>();
    requests.add((machine: machineId, path: path, reply: reply));
    return reply.future;
  }
}

Map<String, dynamic> _listing(String path, [List<String> names = const []]) => {
  'path': path,
  'entries': [
    for (final name in names) {'name': name, 'isDir': true},
  ],
};

Future<void> _key(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool cmd = false,
  bool ctrl = false,
  bool shift = false,
  bool alt = false,
}) async {
  final modifiers = [
    if (cmd) LogicalKeyboardKey.metaLeft,
    if (ctrl) LogicalKeyboardKey.controlLeft,
    if (shift) LogicalKeyboardKey.shiftLeft,
    if (alt) LogicalKeyboardKey.altLeft,
  ];
  for (final modifier in modifiers) {
    await tester.sendKeyDownEvent(modifier);
  }
  await tester.sendKeyEvent(key);
  for (final modifier in modifiers.reversed) {
    await tester.sendKeyUpEvent(modifier);
  }
  await tester.pump();
}

Future<_Folders> _open(
  WidgetTester tester, {
  ValueChanged<String?>? onResult,
  TargetPlatform platform = TargetPlatform.macOS,
  Brightness brightness = Brightness.dark,
  Size size = const Size(1100, 800),
  double scale = 1,
  String? initialPath,
  bool unknownMachine = false,
  bool desktop = true,
  bool addProject = false,
}) async {
  final app = _Folders();
  final callerFocus = FocusNode(debugLabel: 'remote-folder-caller');
  addTearDown(callerFocus.dispose);
  if (unknownMachine) app.machineStates.clear();
  addTearDown(app.dispose);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final oldBrightness = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid
          .buildAppTheme(brightness: brightness)
          .copyWith(platform: platform),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: RepaintBoundary(key: _picture, child: child!),
      ),
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            focusNode: callerFocus,
            autofocus: true,
            onPressed: () async {
              if (addProject) {
                final project = await showSwarmProjectDialog(context, app);
                onResult?.call(project?.path);
                return;
              }
              final result = await showRemoteFolderPicker(
                context,
                notifier: app,
                machineId: 'remote',
                initialPath: initialPath,
                desktop: desktop,
                // Desktop presentation must win over a legacy caller's flag.
                terminal: true,
              );
              onResult?.call(result);
            },
            child: const Text('Browse remote'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Browse remote'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
  if (addProject) {
    await tester.ensureVisible(find.text('Choose folder'));
    await tester.tap(find.text('Choose folder'));
    await tester.pumpAndSettle();
  }
  return app;
}

TextField _path(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(const Key('remote-folder-path')));

FilledButton _select(WidgetTester tester) =>
    tester.widget<FilledButton>(find.byKey(const Key('remote-folder-select')));

void main() {
  setUpAll(() async {
    if (_renderDir != null) await loadPreviewFonts();
  });
  testWidgets('folder browser has native chrome and accessible path and rows', (
    tester,
  ) async {
    final app = await _open(tester);
    final semantics = tester.ensureSemantics();
    expect(find.byType(DesktopDialogSurface), findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);
    expect(_path(tester).focusNode!.hasFocus, isTrue);
    expect(find.bySemanticsLabel(RegExp('Folder path')), findsOneWidget);
    expect(_select(tester).onPressed, isNull);
    app.requests.single.reply.complete(
      _listing('/Users/dev', ['code', 'notes']),
    );
    await tester.pumpAndSettle();
    expect(find.text('On Studio Mac'), findsOneWidget);
    expect(_select(tester).onPressed, isNotNull);
    await _capture(tester, 'remote-folder-desktop');
    final row = tester.getSemantics(find.bySemanticsLabel('code'));
    expect(row.getSemanticsData().hasAction(ui.SemanticsAction.tap), isTrue);
    tester
        .renderObject(find.bySemanticsLabel('code'))
        .owner!
        .semanticsOwner!
        .performAction(row.id, ui.SemanticsAction.tap);
    await tester.pump();
    expect(app.requests.last.path, '/Users/dev/code');
    app.requests.last.reply.complete(_listing('/Users/dev/code'));
    await tester.pumpAndSettle();
    expect(find.text('No subfolders here.'), findsOneWidget);
    expect(
      app.requests.every((request) => request.machine == 'remote'),
      isTrue,
    );
    semantics.dispose();
  });

  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    testWidgets('keyboard paths, paging, parent and selection on $platform', (
      tester,
    ) async {
      String? selected;
      final app = await _open(
        tester,
        platform: platform,
        onResult: (value) => selected = value,
      );
      final entries = [for (var i = 0; i < 100; i++) 'project-$i'];
      app.requests.single.reply.complete(_listing('/Users/dev', entries));
      await tester.pumpAndSettle();
      await _key(tester, LogicalKeyboardKey.arrowDown);
      expect(FocusManager.instance.primaryFocus!.debugLabel, 'Remote folders');
      await _key(tester, LogicalKeyboardKey.pageDown);
      await _key(tester, LogicalKeyboardKey.pageUp);
      await _key(tester, LogicalKeyboardKey.end);
      expect(find.text('project-99').hitTestable(), findsOneWidget);
      await _key(tester, LogicalKeyboardKey.home);
      expect(find.text('project-0').hitTestable(), findsOneWidget);
      await _key(tester, LogicalKeyboardKey.arrowDown);
      await _key(tester, LogicalKeyboardKey.arrowRight);
      expect(app.requests.last.path, '/Users/dev/project-1');
      app.requests.last.reply.complete(
        _listing('/Users/dev/project-1', ['src']),
      );
      await tester.pumpAndSettle();
      await _key(tester, LogicalKeyboardKey.arrowUp, alt: true);
      expect(app.requests.last.path, '/Users/dev');
      app.requests.last.reply.complete(_listing('/Users/dev', entries));
      await tester.pumpAndSettle();
      final mac = platform == TargetPlatform.macOS;
      await _key(tester, LogicalKeyboardKey.keyL, cmd: mac, ctrl: !mac);
      expect(_path(tester).focusNode!.hasFocus, isTrue);
      expect(
        _path(tester).controller!.selection,
        const TextSelection(baseOffset: 0, extentOffset: 10),
      );
      await tester.enterText(
        find.byKey(const Key('remote-folder-path')),
        '/Users/dev/new',
      );
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(app.requests.last.path, '/Users/dev/new');
      app.requests.last.reply.complete(_listing('/Users/dev/new'));
      await tester.pumpAndSettle();
      await _key(tester, LogicalKeyboardKey.keyR, cmd: mac, ctrl: !mac);
      expect(app.requests.last.path, '/Users/dev/new');
      app.requests.last.reply.complete(_listing('/Users/dev/new'));
      await tester.pumpAndSettle();
      await _key(tester, LogicalKeyboardKey.enter, cmd: mac, ctrl: !mac);
      await tester.pumpAndSettle();
      expect(selected, '/Users/dev/new');
      expect(find.byType(DesktopDialogSurface), findsNothing);
    });
  }

  testWidgets('Mac go-to-folder and Back/Home preserve the folder history', (
    tester,
  ) async {
    final app = await _open(tester, initialPath: '/Users/dev/code');
    app.requests.single.reply.complete(_listing('/Users/dev/code', ['src']));
    await tester.pumpAndSettle();
    await _key(tester, LogicalKeyboardKey.arrowUp, cmd: true);
    expect(app.requests.last.path, '/Users/dev');
    app.requests.last.reply.complete(_listing('/Users/dev', ['code', 'notes']));
    await tester.pumpAndSettle();
    await _key(tester, LogicalKeyboardKey.keyG, cmd: true, shift: true);
    expect(_path(tester).focusNode!.hasFocus, isTrue);
    await tester.tap(find.byKey(const Key('remote-folder-up')));
    expect(app.requests.last.path, '/Users');
    app.requests.last.reply.complete(_listing('/Users'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('remote-folder-home')));
    expect(app.requests.last.path, isNull);
    app.requests.last.reply.complete(_listing('/Users/dev'));
    await tester.pumpAndSettle();
  });

  testWidgets('held Enter cannot walk into another folder after a reply', (
    tester,
  ) async {
    final app = await _open(tester);
    app.requests.single.reply.complete(_listing('/Users/dev', ['code']));
    await tester.pumpAndSettle();
    await _key(tester, LogicalKeyboardKey.arrowDown);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    app.requests.last.reply.complete(_listing('/Users/dev/code', ['src']));
    await tester.pumpAndSettle();
    await tester.sendKeyRepeatEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
    expect(app.requests, hasLength(2));
  });

  testWidgets('composition retains Escape, navigation and modified Enter', (
    tester,
  ) async {
    var closed = false;
    final app = await _open(tester, onResult: (_) => closed = true);
    app.requests.single.reply.complete(_listing('/Users/日本語', ['code']));
    await tester.pumpAndSettle();
    final value = TextEditingValue(
      text: '/Users/日本語',
      selection: const TextSelection.collapsed(offset: 10),
      composing: const TextRange(start: 7, end: 10),
    );
    tester.testTextInput.updateEditingValue(value);
    await tester.pump();
    for (final key in [
      LogicalKeyboardKey.arrowDown,
      LogicalKeyboardKey.escape,
    ]) {
      await _key(tester, key);
    }
    await _key(tester, LogicalKeyboardKey.enter, cmd: true);
    await _key(tester, LogicalKeyboardKey.keyL, cmd: true);
    await _key(tester, LogicalKeyboardKey.keyR, cmd: true);
    expect(_path(tester).focusNode!.hasFocus, isTrue);
    expect(_path(tester).controller!.value, value);
    expect(closed, isFalse);
    expect(app.requests, hasLength(1));
    tester.testTextInput.updateEditingValue(
      value.copyWith(composing: TextRange.empty),
    );
    await _key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(closed, isTrue);
  });

  testWidgets('typing and newer requests win over late replies', (
    tester,
  ) async {
    final app = await _open(tester);
    await tester.enterText(
      find.byKey(const Key('remote-folder-path')),
      '/Users/dev/new',
    );
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    app.requests.last.reply.complete(_listing('/Users/dev/new', ['src']));
    await tester.pumpAndSettle();
    app.requests.first.reply.complete(_listing('/old', ['old']));
    await tester.pumpAndSettle();
    expect(_path(tester).controller!.text, '/Users/dev/new');
    expect(find.text('old'), findsNothing);
    await tester.tap(find.byKey(const Key('remote-folder-refresh')));
    await tester.enterText(
      find.byKey(const Key('remote-folder-path')),
      '/draft',
    );
    app.requests.last.reply.complete(
      _listing('/Users/dev/new', ['src', 'tests']),
    );
    await tester.pumpAndSettle();
    expect(_path(tester).controller!.text, '/draft');
    expect(_select(tester).onPressed, isNull);
    expect(find.text('Showing /Users/dev/new'), findsOneWidget);
  });

  testWidgets(
    'request exceptions recover through Home and malformed listings stay safe',
    (tester) async {
      final app = await _open(tester);
      app.requests.single.reply.completeError(StateError('connection closed'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Couldn’t reach this machine. Check its connection and retry.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('remote-folder-home')));
      app.requests.last.reply.complete({'path': ''});
      await tester.pumpAndSettle();
      expect(_select(tester).onPressed, isNull);
      await tester.tap(find.text('Retry'));
      app.requests.last.reply.complete({
        'path': '/',
        'entries': [
          {'name': 'Users', 'isDir': true},
          {'name': 'file.txt', 'isDir': false},
          {'name': ''},
          {'name': 123},
          'malformed',
        ],
      });
      await tester.pumpAndSettle();
      expect(find.text('Users'), findsOneWidget);
      expect(find.text('file.txt'), findsNothing);
      expect(
        tester
            .widget<DesktopPill>(find.byKey(const Key('remote-folder-up')))
            .onPressed,
        isNull,
      );
      expect(_select(tester).onPressed, isNotNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'terminal callers keep their previous presentation and cancellation',
    (tester) async {
      String? result;
      var closed = false;
      final app = await _open(
        tester,
        desktop: false,
        onResult: (value) {
          closed = true;
          result = value;
        },
      );
      app.requests.single.reply.complete({
        ..._listing('/home/dev', ['code']),
        'truncated': true,
      });
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.byType(DesktopDialogSurface), findsNothing);
      expect(
        find.text(
          'More folders are available. Enter their full path to open them.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(closed, isTrue);
      expect(result, isNull);
    },
  );

  for (final error in [
    'FORBIDDEN',
    'PERMISSION_DENIED',
    'NOT_A_DIRECTORY',
    'NOT_FOUND',
    'INVALID_PATH',
    'UNREACHABLE',
    'UNKNOWN',
  ]) {
    testWidgets('$error offers a focused, repeat-safe Retry', (tester) async {
      final app = await _open(tester, initialPath: '/Users/dev/missing');
      app.requests.single.reply.complete({'error': error});
      await tester.pumpAndSettle();
      expect(_select(tester).onPressed, isNull);
      expect(find.text('Retry'), findsOneWidget);
      if (error == 'NOT_FOUND') await _capture(tester, 'remote-folder-error');
      await tester.tap(find.text('Retry'));
      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(app.requests, hasLength(2));
      expect(_path(tester).focusNode!.hasFocus, isTrue);
      expect(app.requests.last.path, '/Users/dev/missing');
      app.requests.last.reply.complete(_listing('/Users/dev/missing'));
      await tester.pumpAndSettle();
      expect(find.text('Retry'), findsNothing);
      expect(_select(tester).onPressed, isNotNull);
      expect(tester.takeException(), isNull);
    });
  }

  for (final dismissal in ['Cancel', 'Escape', 'backdrop']) {
    testWidgets(
      '$dismissal ignores a late response and restores caller focus',
      (tester) async {
        var closed = false;
        String? selection;
        final app = await _open(
          tester,
          onResult: (value) {
            closed = true;
            selection = value;
          },
        );
        if (dismissal == 'Cancel') {
          await tester.tap(find.text('Cancel'));
        } else if (dismissal == 'Escape') {
          await _key(tester, LogicalKeyboardKey.escape);
        } else {
          await tester.tapAt(const Offset(2, 2));
        }
        await tester.pumpAndSettle();
        app.requests.single.reply.complete(_listing('/Users/dev', ['code']));
        await tester.pumpAndSettle();
        expect(closed, isTrue);
        expect(selection, isNull);
        expect(find.byType(DesktopDialogSurface), findsNothing);
        expect(find.text('Browse remote').hitTestable(), findsOneWidget);
        expect(
          FocusManager.instance.primaryFocus!.debugLabel,
          'remote-folder-caller',
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  for (final brightness in Brightness.values) {
    for (final desktop in [false, true]) {
      testWidgets(
        'folder errors remain readable in ${brightness.name} desktop=$desktop',
        (tester) async {
          final app = await _open(
            tester,
            brightness: brightness,
            desktop: desktop,
          );
          app.requests.single.reply.complete({'error': 'FORBIDDEN'});
          await tester.pumpAndSettle();
          final error = find.text(
            'Choose a folder inside your home directory on this machine.',
          );
          final foreground = tester.widget<Text>(error).style!.color!;
          Color? background;
          error.evaluate().single.visitAncestorElements((element) {
            if (element.widget case Material(color: final color?)
                when color.a == 1) {
              background = color;
              return false;
            }
            return true;
          });
          expect(background, isNotNull);
          final fg = foreground.computeLuminance();
          final bg = background!.computeLuminance();
          final contrast = fg > bg
              ? (fg + .05) / (bg + .05)
              : (bg + .05) / (fg + .05);
          expect(contrast, greaterThanOrEqualTo(4.5));
        },
      );
    }

    testWidgets(
      'Add project uses the desktop remote chooser with enlarged recovery in ${brightness.name}',
      (tester) async {
        String? projectPath;
        final app = await _open(
          tester,
          brightness: brightness,
          size: const Size(440, 560),
          scale: 1.6,
          addProject: true,
          onResult: (path) => projectPath = path,
        );
        expect(
          find.byKey(const ValueKey('desktop-remote-folder-dialog')),
          findsOneWidget,
        );
        app.requests.single.reply.complete({'error': 'FORBIDDEN'});
        await tester.pumpAndSettle();
        final error = find.text(
          'Choose a folder inside your home directory on this machine.',
        );
        await _capture(tester, 'add-project-remote-${brightness.name}');
        await tester.ensureVisible(error);
        expect(error.hitTestable(), findsOneWidget);
        await tester.ensureVisible(find.text('Retry'));
        expect(find.text('Retry').hitTestable(), findsOneWidget);
        expect(
          tester.getBottomRight(error).dy,
          lessThan(
            tester.getTopLeft(find.byKey(const Key('remote-folder-select'))).dy,
          ),
        );
        await tester.tap(find.text('Retry'));
        await tester.pump();
        app.requests.last.reply.complete(
          _listing('/Users/dev/Project', ['src']),
        );
        await tester.pumpAndSettle();
        await _key(tester, LogicalKeyboardKey.arrowDown);
        expect(_path(tester).focusNode!.hasFocus, isFalse);
        await _key(tester, LogicalKeyboardKey.keyL, cmd: true);
        expect(_path(tester).focusNode!.hasFocus, isTrue);
        expect(
          _path(tester).controller!.selection,
          const TextSelection(baseOffset: 0, extentOffset: 18),
        );
        await _key(tester, LogicalKeyboardKey.enter, cmd: true);
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('desktop-remote-folder-dialog')),
          findsNothing,
        );
        expect(
          find.widgetWithText(OutlinedButton, '/Users/dev/Project'),
          findsOneWidget,
        );
        await tester.tap(find.widgetWithText(FilledButton, 'Add project'));
        await tester.pumpAndSettle();
        expect(projectPath, '/Users/dev/Project');
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'narrow ${brightness.name} keeps enlarged errors and actions reachable',
      (tester) async {
        final app = await _open(
          tester,
          brightness: brightness,
          size: const Size(440, 560),
          scale: 1.6,
          unknownMachine: true,
        );
        app.requests.single.reply.complete({'error': 'FORBIDDEN'});
        await tester.pumpAndSettle();
        await _capture(tester, 'remote-folder-narrow-${brightness.name}');
        expect(find.text('On the remote machine'), findsOneWidget);
        expect(find.text('Cancel').hitTestable(), findsOneWidget);
        expect(
          find.byKey(const Key('remote-folder-select')).hitTestable(),
          findsOneWidget,
        );
        await tester.ensureVisible(find.text('Retry'));
        await tester.tap(find.text('Retry'));
        await tester.pump();
        app.requests.last.reply.complete({
          ..._listing('/Users/dev', [
            'a very long folder name with 日本語 and emoji 👩🏽‍💻',
          ]),
          'truncated': true,
        });
        await tester.pumpAndSettle();
        expect(
          find.text(
            'More folders are available. Enter their full path to open them.',
          ),
          findsOneWidget,
        );
        expect(_select(tester).onPressed, isNotNull);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'Windows paths retain their remote separators and root boundary',
    (tester) async {
      String? selected;
      final app = await _open(
        tester,
        initialPath: r'C:\Users\dev',
        onResult: (value) => selected = value,
      );
      app.requests.single.reply.complete(_listing(r'C:\Users\dev', ['code']));
      await tester.pumpAndSettle();
      await tester.tap(find.text('code'));
      expect(app.requests.last.path, r'C:\Users\dev\code');
      app.requests.last.reply.complete(_listing(r'C:\Users\dev\code'));
      await tester.pumpAndSettle();
      await _key(tester, LogicalKeyboardKey.arrowLeft);
      expect(app.requests.last.path, r'C:\Users\dev');
      app.requests.last.reply.complete(_listing(r'C:\Users\dev', ['code']));
      await tester.pumpAndSettle();
      await _key(tester, LogicalKeyboardKey.enter);
      app.requests.last.reply.complete(_listing(r'C:\Users\dev\code'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('remote-folder-select')));
      await tester.pumpAndSettle();
      expect(selected, r'C:\Users\dev\code');
    },
  );
}
