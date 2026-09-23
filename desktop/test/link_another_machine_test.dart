import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/auth/peer_link_client.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/widgets/link_another_machine_dialog.dart';
import 'package:harness/widgets/link_machine_screen.dart';
import 'package:harness/widgets/machines_manager.dart';

import 'keymap_host_test.dart' show key, MemoryKeymap;

class _Links implements PeerLinkClient {
  final requests = <String>[];
  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async {
    requests.add(machineId);
    return CliLinkConnectResult(linkedMachineId: machineId);
  }

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult();
  @override
  Future<String?> unlink(String machineId) async => null;
}

class _App extends AppNotifier {
  _App(this.links)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        peerLinks: links,
      );
  final _Links links;
  int refreshes = 0;
  Completer<void>? refresh;
  String? error;
  @override
  String? get machineListError => error;
  @override
  Future<void> retryMachines() {
    refreshes++;
    return refresh?.future ?? Future.value();
  }

  void add(String id, String name, {bool linked = false, bool local = false}) {
    final machine = Machine(
      machineId: id,
      name: name,
      authMode: MachineAuthMode.remote,
    );
    machineStates[id] = MachineState(machine)
      ..localOnly = local
      ..nodeOnline = true
      ..needsLink = !linked;
    machines = machineStates.values.map((state) => state.machine).toList();
    notifyListeners();
  }
}

const _search = Key('link-machine-search');
final _input = find.byKey(_search);

Future<void> _mount(
  WidgetTester tester,
  _App app, {
  double scale = 1,
  AppKeymap? keymap,
  bool manager = false,
}) async {
  final opener = Scaffold(
    body: Builder(
      builder: (context) => TextButton(
        onPressed: () => manager
            ? showMachinesManager(context, app)
            : showLinkAnotherMachineDialog(context, app),
        child: const Text('open setup'),
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
                actions: const {},
                enabled: () => false,
                child: opener,
              ),
            ),
    ),
  );
  await tester.tap(find.text('open setup'));
  await tester.pumpAndSettle();
  if (manager) {
    await tester.tap(find.text('Link Machine'));
    await tester.pumpAndSettle();
  }
}

void main() {
  late _App app;
  late List<String> clipboard;
  var failCopy = false;
  setUp(() {
    app = _App(_Links());
    clipboard = [];
    failCopy = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            if (failCopy) {
              throw PlatformException(code: 'clipboard unavailable');
            }
            clipboard.add((call.arguments as Map)['text'] as String);
          }
          return null;
        });
  });
  tearDown(() {
    app.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  testWidgets(
    'filter, link, and return to the same machine query by keyboard',
    (tester) async {
      app.add('build', 'build-box');
      app.add('studio', 'studio');
      app.add('local', 'my laptop', local: true);
      await _mount(tester, app);
      expect(tester.widget<TextField>(_input).focusNode!.hasFocus, isTrue);
      expect(find.text('my laptop'), findsNothing);
      tester.testTextInput.enterText('bdbx');
      await tester.pump();
      expect(find.text('build-box'), findsOneWidget);
      expect(find.text('studio'), findsNothing);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final password = find.byKey(const Key('remote-password-connect-field'));
      expect(tester.widget<TextField>(password).focusNode!.hasFocus, isTrue);
      tester.testTextInput.enterText('fixture password');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(LinkMachineScreen), findsNothing);
      expect(app.links.requests, ['build']);
      expect(tester.widget<TextField>(_input).controller!.text, 'bdbx');
      expect(tester.widget<TextField>(_input).focusNode!.hasFocus, isTrue);
      expect(find.text('build-box is linked.'), findsOneWidget);
      expect(
        find.text('Already linked. Open its agents from New Tab or New Pane.'),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(_input, findsNothing);
    },
  );

  testWidgets('SSH guide copies exact commands and Escape restores the query', (
    tester,
  ) async {
    await _mount(tester, app);
    tester.testTextInput.enterText('ssh');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('On the other machine, over SSH:'), findsOneWidget);
    final copyInstall = find.byKey(
      const ValueKey('copy-$kLinkServerInstallCommand'),
    );
    expect(tester.widget<TextButton>(copyInstall).focusNode!.hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(clipboard, [kLinkServerInstallCommand]);
    await tester.tap(find.byKey(const Key('link-copy-all')));
    await tester.pumpAndSettle();
    expect(
      clipboard.last,
      '$kLinkServerInstallCommand\n$kLinkServerLoginCommand\n$kLinkServerStartCommand',
    );
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(_input).controller!.text, 'ssh');
    expect(tester.widget<TextField>(_input).focusNode!.hasFocus, isTrue);
  });

  testWidgets(
    'background arrivals preserve the highlighted action and open guide',
    (tester) async {
      await _mount(tester, app);
      await key(tester, LogicalKeyboardKey.keyN, ctrl: true);
      await key(tester, LogicalKeyboardKey.keyP, ctrl: true);
      await key(tester, LogicalKeyboardKey.keyN, ctrl: true);
      app.add('new', 'new-server');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Link another machine / SSH'), findsOneWidget);
      app.add('next', 'second-server');
      await tester.pump();
      expect(find.text(kLinkServerInstallCommand), findsOneWidget);
      expect(find.text('second-server'), findsOneWidget);
      expect(
        tester
            .widget<TextButton>(
              find.byKey(const ValueKey('copy-$kLinkServerInstallCommand')),
            )
            .focusNode!
            .hasFocus,
        isTrue,
      );
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Link another machine / SSH'), findsOneWidget);
    },
  );

  testWidgets(
    'refresh coalesces, preserves filtering, and reports recovery',
    (tester) async {
      app.add('build', 'build-box');
      app.refresh = Completer<void>();
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      await _mount(tester, app, keymap: map);
      tester.testTextInput.enterText('build');
      final mac =
          Theme.of(tester.element(_input)).platform == TargetPlatform.macOS;
      await key(tester, LogicalKeyboardKey.keyR, cmd: mac, ctrl: !mac);
      await key(tester, LogicalKeyboardKey.keyR, cmd: mac, ctrl: !mac);
      expect(app.refreshes, 1);
      expect(find.text('Refreshing machines…'), findsOneWidget);
      app.error = 'Machine list is offline';
      app.refresh!.complete();
      await tester.pumpAndSettle();
      expect(find.text(app.error!), findsOneWidget);
      expect(tester.widget<TextField>(_input).controller!.text, 'build');
      expect(tester.widget<TextField>(_input).focusNode!.hasFocus, isTrue);
      app.error = null;
      app.refresh = null;
      await key(tester, LogicalKeyboardKey.keyR, cmd: mac, ctrl: !mac);
      await tester.pumpAndSettle();
      expect(app.refreshes, 2);
      expect(find.text('Machine list refreshed.'), findsOneWidget);
    },
    variant: TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  for (final manager in [false, true]) {
    testWidgets(
      'picker keys stay live across dialog routes (manager: $manager)',
      (tester) async {
        final map = MemoryKeymap();
        addTearDown(map.dispose);
        map.apply('''{"bindings":[
        {"keys":"enter","command":null,"when":"picker"},
        {"keys":"escape","command":null,"when":"picker"},
        {"keys":"ctrl+n","command":null,"when":"picker"},
        {"keys":"cmd+r","command":null,"when":"picker"},
        {"keys":"f6","command":"picker.next","when":"picker"},
        {"keys":"f7","command":"picker.cancel","when":"picker"},
        {"keys":"f8","command":"picker.accept","when":"picker"},
        {"keys":"f9","command":"picker.refresh","when":"picker"}
      ]}''');
        await _mount(tester, app, keymap: map, manager: manager);
        if (manager) {
          // The legacy entry forwards to the new Machines panel and keeps
          // the live picker keymap across that nested route.
          await key(tester, LogicalKeyboardKey.enter);
          await key(tester, LogicalKeyboardKey.escape);
          expect(find.text('Machines'), findsOneWidget);
          await key(tester, LogicalKeyboardKey.keyR, cmd: true);
          expect(app.refreshes, 0);
          await key(tester, LogicalKeyboardKey.f9);
          expect(app.refreshes, 1);
          map.apply(
            '{"bindings":[{"keys":"f4","command":"picker.cancel","when":"picker"}]}',
          );
          await tester.pump();
          await key(tester, LogicalKeyboardKey.f7);
          expect(find.text('Machines'), findsOneWidget);
          await key(tester, LogicalKeyboardKey.f4);
          await tester.pumpAndSettle();
          expect(find.text('Machines'), findsNothing);
          expect(find.text('Machines Manager'), findsOneWidget);
          await tester.pumpWidget(const SizedBox());
          return;
        }
        await key(tester, LogicalKeyboardKey.enter);
        await key(tester, LogicalKeyboardKey.escape);
        expect(_input, findsOneWidget);
        await key(tester, LogicalKeyboardKey.keyN, ctrl: true);
        await key(tester, LogicalKeyboardKey.f6);
        await key(tester, LogicalKeyboardKey.f8);
        await tester.pumpAndSettle();
        expect(find.text('Link another machine / SSH'), findsOneWidget);
        // The configured accept key also activates a focused guide control.
        await key(tester, LogicalKeyboardKey.f8);
        await tester.pumpAndSettle();
        expect(clipboard, [kLinkServerInstallCommand]);
        await key(tester, LogicalKeyboardKey.keyR, cmd: true);
        expect(app.refreshes, 0);
        await key(tester, LogicalKeyboardKey.f9);
        await tester.pumpAndSettle();
        expect(app.refreshes, 1);
        await key(tester, LogicalKeyboardKey.f7);
        await tester.pumpAndSettle();
        expect(tester.widget<TextField>(_input).focusNode!.hasFocus, isTrue);
        map.apply('''{"bindings":[
        {"keys":"f4","command":"picker.cancel","when":"picker"},
        {"keys":"f10","command":"picker.accept","when":"picker"}
      ]}''');
        await tester.pump();
        expect(
          find.textContaining(RegExp('f10  open', caseSensitive: false)),
          findsOneWidget,
        );
        await key(tester, LogicalKeyboardKey.f8);
        expect(_input, findsOneWidget);
        await key(tester, LogicalKeyboardKey.f10);
        await tester.pumpAndSettle();
        expect(find.text('Link another machine / SSH'), findsOneWidget);
        await key(tester, LogicalKeyboardKey.f4);
        await key(tester, LogicalKeyboardKey.f4);
        await tester.pumpAndSettle();
        expect(_input, findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('composition owns Enter and Escape in machine search', (
    tester,
  ) async {
    await _mount(tester, app);
    tester.testTextInput.enterText('ssh');
    await tester.pump();
    final controller = tester.widget<TextField>(_input).controller!;
    controller.value = controller.value.copyWith(
      composing: const TextRange(start: 0, end: 3),
    );
    await key(tester, LogicalKeyboardKey.enter);
    await key(tester, LogicalKeyboardKey.escape);
    expect(_input, findsOneWidget);
    expect(find.text('Link another machine / SSH'), findsNothing);
    controller.value = controller.value.copyWith(composing: TextRange.empty);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Link another machine / SSH'), findsOneWidget);
  });

  testWidgets('clipboard errors leave the focused command available to retry', (
    tester,
  ) async {
    await _mount(tester, app);
    tester.testTextInput.enterText('ssh');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    failCopy = true;
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(
      find.text('Could not copy. Select the text to copy it, or try again.'),
      findsOneWidget,
    );
    failCopy = false;
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(clipboard, [kLinkServerInstallCommand]);
    expect(find.text('Copied. Run on the other machine.'), findsOneWidget);
  });

  testWidgets('short windows with enlarged text keep setup and back reachable', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(600, 420);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _mount(tester, app, scale: 1.7);
    tester.testTextInput.enterText('ssh');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('esc  back').hitTestable(), findsOneWidget);
    // Tab traversal scrolls the controls into view; no mouse is needed to copy.
    for (var i = 0; i < 10; i++) {
      final all = tester.widget<TextButton>(
        find.byKey(const Key('link-copy-all')),
      );
      final focus = Focus.of(
        tester.element(find.text('Copy all three commands')),
      );
      if (focus.hasFocus) {
        expect(all.onPressed, isNotNull);
        break;
      }
      await key(tester, LogicalKeyboardKey.tab);
    }
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(
      clipboard.last,
      '$kLinkServerInstallCommand\n$kLinkServerLoginCommand\n$kLinkServerStartCommand',
    );
    expect(tester.takeException(), isNull);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(_input).focusNode!.hasFocus, isTrue);
  });
}
