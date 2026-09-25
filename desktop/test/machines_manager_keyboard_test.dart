import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/machines_manager.dart';

import 'keymap_host_test.dart' show key, MemoryKeymap;
import 'support/machine_api.dart';
import 'support/password_cli.dart';

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLink: PasswordCli(),
      ) {
    api = edits;
  }
  final edits = MachineApi();
  int refreshes = 0;
  Completer<void>? refresh;
  String? refreshError;
  @override
  String? get machineListError => refreshError;
  @override
  Future<void> retryMachines() {
    refreshes++;
    return refresh?.future ?? Future.value();
  }

  void add(
    String id,
    String name, {
    bool local = false,
    bool? online = true,
    bool needsLink = false,
    bool shared = false,
  }) {
    final machine = Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: name,
      hostname: '$id.local',
      isShared: shared,
      ownerName: shared ? 'Fixture Owner' : null,
    );
    machineStates[id] = MachineState(machine)
      ..localOnly = local
      ..nodeOnline = online
      ..needsLink = needsLink;
    machines = machineStates.values.map((state) => state.machine).toList();
    notifyListeners();
  }

  void forget(String id) {
    machineStates.remove(id);
    machines.removeWhere((machine) => machine.machineId == id);
    notifyListeners();
  }
}

final _search = find.byKey(const Key('machines-manager-search'));
final _rename = find.byKey(const Key('machine-rename-input'));
TextField _field(WidgetTester tester, Finder finder) =>
    tester.widget<TextField>(finder);

Future<void> _mount(
  WidgetTester tester,
  _App app, {
  AppKeymap? keymap,
  Size size = const Size(1000, 700),
  double scale = 1,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final opener = Scaffold(
    body: Builder(
      builder: (context) => TextButton(
        onPressed: () => showMachinesManager(context, app),
        child: const Text('open'),
      ),
    ),
  );
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: keymap == null
          ? opener
          : KeymapProvider(
              keymap: keymap,
              child: KeymapHost(
                keymap: keymap,
                enabled: () => false,
                actions: const {},
                child: opener,
              ),
            ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

Future<void> _typeOpen(WidgetTester tester, String query) async {
  tester.testTextInput.enterText(query);
  await key(tester, LogicalKeyboardKey.enter);
  await tester.pumpAndSettle();
}

void main() {
  late _App app;
  setUp(() => app = _App());
  tearDown(() => app.dispose());

  testWidgets(
    'search finds hostnames, retains query across actions and keeps stable selection',
    (tester) async {
      app.add('work', 'Workstation', local: true);
      app.add('build-10', 'Build 10');
      app.add('build-2', 'Build 2', online: false, needsLink: true);
      await _mount(tester, app);
      expect(_field(tester, _search).focusNode!.hasFocus, isTrue);
      await key(tester, LogicalKeyboardKey.keyN, ctrl: true);
      app.add('build-1', 'Build 1');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Build 2'), findsOneWidget);
      expect(find.textContaining('offline · link required'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      tester.testTextInput.enterText('build-10.local');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Build 10'), findsOneWidget);
      expect(find.text('Rename'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(_field(tester, _search).controller!.text, 'build-10.local');
      expect(_field(tester, _search).focusNode!.hasFocus, isTrue);
    },
  );

  testWidgets(
    'rename focuses selected text, handles errors and rejoins a pending save',
    (tester) async {
      app.add('work', 'Workstation');
      await _mount(tester, app);
      await _typeOpen(tester, 'work');
      await _typeOpen(tester, 'rename');
      expect(_field(tester, _rename).focusNode!.hasFocus, isTrue);
      expect(
        _field(tester, _rename).controller!.selection,
        const TextSelection(baseOffset: 0, extentOffset: 11),
      );
      expect(_search, findsNothing); // One visible prompt.
      tester.testTextInput.enterText('   ');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Name cannot be empty'), findsOneWidget);
      expect(app.edits.renames, isEmpty);
      app.edits.renameFailure = ApiException('Connection unavailable');
      tester.testTextInput.enterText('Office');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(find.textContaining('Connection unavailable'), findsOneWidget);
      expect(_field(tester, _rename).focusNode!.hasFocus, isTrue);
      app.edits.renameFailure = null;
      app.edits.renameReply = Completer<String?>();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(_field(tester, _rename).readOnly, isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.edits.renames, hasLength(2));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(_field(tester, _search).controller!.text, 'rename');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(_field(tester, _rename).controller!.text, 'Office');
      expect(_field(tester, _rename).readOnly, isTrue);
      expect(app.edits.renames, hasLength(2));
      app.edits.renameReply!.complete('Office');
      await tester.pumpAndSettle();
      expect(find.text('Office'), findsOneWidget);
      expect(_field(tester, _search).controller!.text, 'rename');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(_field(tester, _search).controller!.text, 'work');
    },
  );

  testWidgets(
    'delete starts on Cancel, reports failure, and resumes one pending request',
    (tester) async {
      app.add('work', 'Workstation');
      await _mount(tester, app);
      await _typeOpen(tester, 'work');
      await _typeOpen(tester, 'delete');
      expect(find.text('Delete machine'), findsOneWidget);
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Cancel'))
            .focusNode!
            .hasFocus,
        isTrue,
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(app.edits.deletes, isEmpty);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      app.edits.deleteFailure = ApiException('Account unavailable');
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Delete failed: Account unavailable'), findsOneWidget);
      expect(app.stateOf('work'), isNotNull);
      app.edits.deleteFailure = null;
      app.edits.deleteReply = Completer<void>();
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Deleting machine…'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Deleting machine…'), findsOneWidget);
      expect(app.edits.deletes, ['work', 'work']);
      app.edits.deleteReply!.complete();
      await tester.pumpAndSettle();
      expect(app.stateOf('work'), isNull);
      expect(find.text('Machines'), findsOneWidget);
      expect(find.text('Workstation deleted.'), findsOneWidget);
    },
  );

  testWidgets(
    'refresh keeps query and active machine while errors are recoverable',
    (tester) async {
      app.add('work', 'Workstation');
      await _mount(tester, app);
      tester.testTextInput.enterText('work');
      app.refresh = Completer<void>();
      final ctrl =
          Theme.of(tester.element(_search)).platform != TargetPlatform.macOS;
      await key(tester, LogicalKeyboardKey.keyR, ctrl: ctrl, cmd: !ctrl);
      await key(tester, LogicalKeyboardKey.keyR, ctrl: ctrl, cmd: !ctrl);
      expect(app.refreshes, 1);
      expect(_field(tester, _search).controller!.text, 'work');
      expect(_field(tester, _search).focusNode!.hasFocus, isTrue);
      app.refreshError = 'Connection unavailable';
      app.refresh!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Connection unavailable'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      app.refresh = null;
      app.refreshError = null;
      await key(tester, LogicalKeyboardKey.keyR, ctrl: ctrl, cmd: !ctrl);
      await tester.pumpAndSettle();
      expect(find.text('Connection unavailable'), findsNothing);
      app.forget('work');
      await tester.pump();
      expect(find.text('This machine is no longer available.'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.edits.deletes, isEmpty);
      expect(app.edits.renames, isEmpty);
    },
    variant: TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  testWidgets(
    'local and shared machine actions expose their actual capabilities',
    (tester) async {
      app.add('work', 'Workstation', local: true);
      app.add('shared', 'Shared builder', shared: true);
      await _mount(tester, app);
      await _typeOpen(tester, 'work');
      expect(find.text('This computer’s password'), findsOneWidget);
      expect(find.text('Delete machine…'), findsNothing);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await _typeOpen(tester, 'shared');
      expect(find.textContaining('view-only. Their owner'), findsOneWidget);
      expect(find.text('Rename'), findsNothing);
      expect(find.text('Delete machine…'), findsNothing);
      expect(app.edits.renames, isEmpty);
    },
  );

  testWidgets('link entry returns to the same action query and machine', (
    tester,
  ) async {
    app.add('build', 'Build box', needsLink: true);
    await _mount(tester, app);
    await _typeOpen(tester, 'build');
    await _typeOpen(tester, 'link');
    final password = find.byKey(const Key('remote-password-connect-field'));
    expect(_field(tester, password).focusNode!.hasFocus, isTrue);
    expect(_search, findsNothing);
    tester.testTextInput.enterText('fixture password');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(app.stateOf('build')!.needsLink, isFalse);
    expect(_field(tester, _search).controller!.text, 'link');
    expect(find.text('Build box'), findsOneWidget);
    expect(find.text('Build box linked.'), findsOneWidget);
    expect(_field(tester, _search).focusNode!.hasFocus, isTrue);
  });

  testWidgets(
    'custom keys own nested prompts and composition keeps Enter and Escape',
    (tester) async {
      app.add('work', 'Workstation');
      final map = MemoryKeymap()
        ..apply('''{"bindings":[
      {"keys":"enter","command":null,"when":"picker"},
      {"keys":"escape","command":null,"when":"picker"},
      {"keys":"f8","command":"picker.accept","when":"picker"},
      {"keys":"f7","command":"picker.cancel","when":"picker"}
    ]}''');
      addTearDown(map.dispose);
      await _mount(tester, app, keymap: map);
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      expect(find.text('Machines'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.f8);
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.f8);
      await tester.pumpAndSettle();
      expect(_rename, findsOneWidget);
      final text = _field(tester, _rename).controller!;
      text.value = const TextEditingValue(
        text: 'Office',
        selection: TextSelection.collapsed(offset: 6),
        composing: TextRange(start: 0, end: 6),
      );
      await key(tester, LogicalKeyboardKey.f8);
      await key(tester, LogicalKeyboardKey.f7);
      expect(_rename, findsOneWidget);
      expect(app.edits.renames, isEmpty);
      text.clearComposing();
      map.apply('''{"bindings":[
      {"keys":"enter","command":null,"when":"picker"},
      {"keys":"f10","command":"picker.accept","when":"picker"},
      {"keys":"f4","command":"picker.cancel","when":"picker"}
    ]}''');
      await tester.pump();
      expect(
        find.textContaining(RegExp('f10  save', caseSensitive: false)),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.edits.renames, isEmpty);
      await key(tester, LogicalKeyboardKey.f10);
      await tester.pumpAndSettle();
      expect(app.edits.renames, [('work', 'Office')]);
      await key(tester, LogicalKeyboardKey.f4);
      await tester.pumpAndSettle();
      expect(find.text('Machines'), findsOneWidget);
    },
  );

  testWidgets(
    'short windows and long machine names keep search and back in view',
    (tester) async {
      app.add(
        'long-machine-id-0123456789',
        'A very long machine name used for remote feature builds',
        online: false,
      );
      for (var i = 1; i < 22; i++) {
        app.add('build-$i', 'Build $i');
      }
      await _mount(tester, app, size: const Size(480, 360), scale: 1.7);
      await key(tester, LogicalKeyboardKey.pageDown);
      expect(tester.takeException(), isNull);
      tester.testTextInput.enterText('long-machine');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(_search.hitTestable(), findsOneWidget);
      expect(find.text('esc  back').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _typeOpen(tester, 'rename');
      expect(_rename.hitTestable(), findsOneWidget);
      expect(find.text('esc  close').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the footer action activates without recursively dispatching itself',
    (tester) async {
      app.add('work', 'Workstation');
      await _mount(tester, app, keymap: MemoryKeymap());
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Rename'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
