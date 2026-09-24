import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/machines_panel.dart';
import 'package:harness/widgets/toolbar_icon.dart';
import 'package:harness/widgets/workspace_welcome.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/password_cli.dart';
import 'support/real_fonts.dart';

class _Cli extends PasswordCli {
  final connections = <(String, String)>[];
  Completer<CliLinkConnectResult>? connectReply;
  String? connectError;
  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async {
    connections.add((machineId, password));
    onProgress?.call('exchanging');
    return connectReply?.future ??
        CliLinkConnectResult(error: connectError, linkedMachineId: machineId);
  }
}

class _App extends AppNotifier {
  _App(_Cli cli)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLink: cli,
        peerLinks: cli,
      );
  String? inventoryError;
  int refreshes = 0;
  final deletes = <String>[];
  @override
  Future<String?> deleteMachine(String id) async {
    deletes.add(id);
    machineStates.remove(id);
    machines = machineStates.values.map((s) => s.machine).toList();
    notifyListeners();
    return null;
  }

  final resourceReadIds = <String>[];
  final resourceValues = <String, MachineResources?>{};
  final resourceReplies = <String, Completer<MachineResources?>>{};
  @override
  Future<MachineResources?> readMachineResources(String id) async {
    resourceReadIds.add(id);
    return resourceReplies[id]?.future ?? resourceValues[id];
  }

  @override
  String? get machineListError => inventoryError;
  @override
  Future<void> retryMachines() async {
    refreshes++;
  }

  void add(
    String id,
    String name, {
    bool local = false,
    bool linked = false,
    bool online = true,
  }) {
    final machine = Machine(
      machineId: id,
      name: name,
      authMode: MachineAuthMode.remote,
    );
    machineStates[id] = MachineState(machine)
      ..localOnly = local
      ..nodeOnline = online
      ..needsLink = !linked && !local
      ..agentLoadStatus = linked || local
          ? AgentLoadStatus.loaded
          : AgentLoadStatus.needsLink
      ..connectionStatus = linked || local
          ? ConnectionStatus.connected
          : ConnectionStatus.disconnected;
    machines = machineStates.values.map((s) => s.machine).toList();
    notifyListeners();
  }

  void connected(String id) {
    stateOf(id)!.connectionStatus = ConnectionStatus.connected;
    stateOf(id)!.agentLoadStatus = AgentLoadStatus.loaded;
    notifyListeners();
  }
}

void main() {
  late _Cli cli;
  late _App app;
  final captureKey = GlobalKey();
  String? opened;
  setUp(() {
    cli = _Cli();
    app = _App(cli)..add('local', 'M2', local: true);
    opened = null;
  });
  tearDown(() => app.dispose());

  Future<void> mount(
    WidgetTester tester, {
    Size size = const Size(1000, 900),
    double scale = 1,
    Brightness brightness = Brightness.dark,
    AppKeymap? keymap,
    bool workspace = false,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    if (Platform.environment['HARNESS_MACHINES_CAPTURE_DIR'] != null) {
      await tester.runAsync(() async {
        if (Platform.isMacOS) {
          final bytes = ByteData.sublistView(
            await File('/System/Library/Fonts/Menlo.ttc').readAsBytes(),
          );
          for (final family in [
            '.AppleSystemUIFontMonospaced',
            'SF Mono',
            'Menlo',
          ]) {
            await (FontLoader(family)..addFont(Future.value(bytes))).load();
          }
          final sans = ByteData.sublistView(
            await File('/System/Library/Fonts/Supplemental/Arial.ttf')
                .readAsBytes(),
          );
          for (final family in [
            '.AppleSystemUIFont',
            'SF Pro Text',
            'Roboto',
          ]) {
            await (FontLoader(family)..addFont(Future.value(sans))).load();
          }
        } else {
          await loadRealFonts();
        }
        final font = FontLoader('MaterialIcons');
        font.addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
        await font.load();
        await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
              rootBundle.load(
                'packages/lucide_icons_flutter/assets/lucide.ttf',
              ),
            ))
            .load();
      });
    }
    final home = workspace
        ? SwarmScreen(notifier: app, nativeTabs: false)
        : Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  opened = await showMachinesPanel(context, app);
                },
                child: const Text('open machines'),
              ),
            ),
          );
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: keymap == null
              ? home
              : KeymapProvider(
                  keymap: keymap,
                  child: KeymapHost(
                    keymap: keymap,
                    actions: const {},
                    enabled: () => false,
                    child: home,
                  ),
                ),
        ),
      ),
    );
    if (workspace &&
        Platform.environment['HARNESS_MACHINES_CAPTURE_DIR'] != null) {
      await tester.runAsync(
        () => precacheImage(
          const AssetImage('assets/store/polymath.png'),
          tester.element(find.byType(SwarmScreen)),
        ),
      );
      await tester.pumpAndSettle();
    }
    await tester.tap(
      workspace
          ? find.byKey(const ValueKey('swarm-machines-button'))
          : find.text('open machines'),
    );
    await tester.pumpAndSettle();
  }

  Future<void> tap(WidgetTester tester, Finder target) async {
    await tester.ensureVisible(target);
    await tester.tap(target);
    await tester.pumpAndSettle();
  }

  Future<void> capture(WidgetTester tester, String name) async {
    final dir = Platform.environment['HARNESS_MACHINES_CAPTURE_DIR'];
    if (dir == null) return;
    await tester.runAsync(() async {
      final image =
          await (captureKey.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      Directory(dir).createSync(recursive: true);
      File('$dir/$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  final localInput = find.byKey(const ValueKey('make-available-password'));
  final remoteInput = find.byKey(
    const ValueKey('connect-password-remote-input'),
  );

  testWidgets(
    'toolbar panel is anchored, resizes, and closes outside without dimming work',
    (tester) async {
      final previous = newHarnessOpensInBox;
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = previous);
      app.add('remote', 'Mac mini');
      app.add('office', 'iMac · Office', linked: true);
      app.stateOf('office')!.agents = List.generate(
        8,
        (i) => Agent(id: 'office-$i', name: 'Work $i'),
      );
      app.stateOf('local')!.agents = List.generate(
        12,
        (i) => Agent(id: 'local-$i', name: 'Work $i'),
      );
      app.resourceValues.addAll({
        'local': const MachineResources(
          cpuPercent: 18,
          memoryUsedBytes: 10 * 1024 * 1024 * 1024,
          memoryTotalBytes: 32 * 1024 * 1024 * 1024,
        ),
        'office': const MachineResources(
          cpuPercent: 42,
          memoryUsedBytes: 24 * 1024 * 1024 * 1024,
          memoryTotalBytes: 64 * 1024 * 1024 * 1024,
        ),
      });
      app.add('server', 'Build server', online: false);
      await mount(tester, size: const Size(1280, 800), workspace: true);
      final panel = find.byKey(const ValueKey('machines-panel'));
      final icon = find.byKey(const ValueKey('swarm-machines-button'));
      expect(find.byType(Dialog), findsNothing);
      for (final barrier in tester.widgetList<ModalBarrier>(
        find.byType(ModalBarrier),
      )) {
        expect(
          barrier.color?.a ?? 0,
          0,
          reason: 'The workspace stays undimmed',
        );
      }
      expect(
        tester.getRect(panel).top,
        greaterThan(tester.getRect(icon).bottom),
      );
      expect(tester.getRect(panel).right, closeTo(1270, 2));
      expect(tester.widget<IconButton>(icon).isSelected, isTrue);
      expect(remoteInput, findsNothing);
      expect(localInput, findsNothing);
      expect(find.text('Set password'), findsOneWidget);
      expect(find.text('View harnesses'), findsNothing);
      expect(
        tester.getTopLeft(find.text('M2')).dy,
        lessThan(tester.getTopLeft(find.text('Mac mini')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Mac mini')).dy,
        lessThan(tester.getTopLeft(find.text('iMac · Office')).dy),
      );
      expect(
        tester.getTopLeft(find.text('iMac · Office')).dy,
        lessThan(tester.getTopLeft(find.text('Build server')).dy),
      );
      expect(
        find.text('12 harnesses · CPU 18% · RAM 10/32 GB'),
        findsOneWidget,
      );
      expect(find.text('8 harnesses · CPU 42% · RAM 24/64 GB'), findsOneWidget);
      expect(find.text('Connected'), findsNothing);
      expect(app.resourceReadIds, unorderedEquals(['local', 'office']));
      final widths = ['Set password', 'Connect'].map(
        (label) => tester
            .getSize(
              find.ancestor(
                of: find.text(label),
                matching: find.byType(TextButton),
              ),
            )
            .width,
      );
      expect(widths.toSet(), hasLength(1));
      for (final id in ['remote', 'office', 'server']) {
        expect(
          tester.getSize(find.byKey(ValueKey('machine-$id'))).height,
          lessThan(85),
        );
      }
      expect(
        find.byKey(const ValueKey('connect-machine-remote')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('machine-office')), findsOneWidget);
      await capture(tester, 'machines-toolbar-panel');
      await tap(tester, find.text('Set password'));
      expect(tester.widget<TextField>(localInput).focusNode!.hasFocus, isTrue);
      await capture(tester, 'machines-toolbar-set-password');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tap(tester, icon);
      expect(localInput, findsNothing);
      await tap(tester, find.byKey(const ValueKey('connect-machine-remote')));
      expect(tester.widget<TextField>(remoteInput).focusNode!.hasFocus, isTrue);
      await capture(tester, 'machines-toolbar-connect');
      tester.view.physicalSize = const Size(760, 620);
      await tester.pumpAndSettle();
      expect(tester.getRect(panel).right, closeTo(750, 2));
      expect(tester.getRect(panel).bottom, lessThanOrEqualTo(620));
      expect(tester.takeException(), isNull);
      await tester.tapAt(const Offset(30, 200));
      await tester.pumpAndSettle();
      expect(panel, findsNothing);
      expect(tester.widget<IconButton>(icon).isSelected, isFalse);
      await mount(tester, workspace: true, brightness: Brightness.light);
      expect(find.byType(ToolbarIcon), findsNWidgets(3));
      expect(panel, findsOneWidget);
      await tap(tester, find.byTooltip('Close Machines'));
      expect(icon.hitTestable(), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Set password reveals the password field and Save makes this computer available',
    (tester) async {
      await mount(tester);
      expect(find.text('Add a second machine'), findsOneWidget);
      expect(localInput, findsNothing);
      expect(find.text('Save'), findsNothing);
      expect(find.text('Set password'), findsOneWidget);
      expect(
        find.text('2. Open Machines and choose Set password.'),
        findsNothing,
      );
      await capture(tester, 'first-machine');
      await tap(tester, find.byTooltip('Add a machine'));
      expect(
        find.text('2. Open Machines and choose Set password.'),
        findsOneWidget,
      );
      await capture(tester, 'desktop-setup');
      await tap(tester, find.text('Set password'));
      expect(localInput, findsOneWidget);
      expect(tester.widget<TextField>(localInput).focusNode!.hasFocus, isTrue);
      await capture(tester, 'first-machine-setup');
      await tester.enterText(localInput, 'fixture reusable password');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(cli.passwords, ['fixture reusable password']);
      expect(find.textContaining('This computer · Available'), findsOneWidget);
      expect(localInput, findsNothing);
      await capture(tester, 'available-machine');
      await tap(tester, find.text('Change password'));
      expect(tester.widget<TextField>(localInput).controller!.text, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'new machine appears live; retry password and open it from the same panel',
    (tester) async {
      await mount(tester);
      app.add('remote', 'Mac mini');
      await tester.pumpAndSettle();
      expect(remoteInput, findsNothing);
      await tap(tester, find.byKey(const ValueKey('connect-machine-remote')));
      expect(remoteInput, findsOneWidget);
      expect(
        find.text('On Mac mini, open Machines → Set password.'),
        findsNothing,
      );
      await tap(
        tester,
        find.descendant(
          of: find.byKey(const ValueKey('machine-remote')),
          matching: find.byTooltip('Password help'),
        ),
      );
      expect(
        find.text('On Mac mini, open Machines → Set password.'),
        findsOneWidget,
      );
      await capture(tester, 'connect-machine');
      cli.connectError = 'Incorrect password. Try again.';
      await tester.enterText(remoteInput, 'fixture wrong password');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text(cli.connectError!), findsOneWidget);
      expect(find.text('Machines'), findsOneWidget);
      cli.connectError = null;
      await tester.enterText(remoteInput, 'fixture correct password');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(app.stateOf('remote')!.needsLink, isFalse);
      app.connected('remote');
      await tester.pumpAndSettle();
      expect(find.text('Connected'), findsNothing);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('machine-stats-remote')))
            .data,
        '0 harnesses · CPU — · RAM —',
      );
      expect(cli.connections, [
        ('remote', 'fixture wrong password'),
        ('remote', 'fixture correct password'),
      ]);
      expect(
        cli.passwords,
        isEmpty,
        reason: 'Connecting out never requires setting a local password',
      );
      await capture(tester, 'connected-machine');
      await tap(tester, find.text('New harness'));
      expect(opened, 'remote');
      expect(find.text('Machines'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'password save continues across closing and reopening without duplicate submission',
    (tester) async {
      cli.setReply = Completer<RemotePasswordSetResult>();
      await mount(tester);
      await tap(tester, find.text('Set password'));
      await tester.enterText(localInput, 'fixture password');
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.enter);
      expect(cli.passwords, hasLength(1));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tap(tester, find.text('open machines'));
      expect(find.text('Saving password…'), findsOneWidget);
      cli.setReply!.complete(const RemotePasswordSetResult());
      await tester.pumpAndSettle();
      expect(find.textContaining('This computer · Available'), findsOneWidget);
      expect(cli.passwords, hasLength(1));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('another arrival never replaces the password being typed', (
    tester,
  ) async {
    app.add('remote', 'Mac mini');
    await mount(tester);
    await tap(tester, find.byKey(const ValueKey('connect-machine-remote')));
    expect(tester.widget<TextField>(remoteInput).focusNode!.hasFocus, isTrue);
    await tester.enterText(remoteInput, 'fixture password');
    app.add('another', 'A build server');
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(remoteInput).controller!.text,
      'fixture password',
    );
    expect(tester.widget<TextField>(remoteInput).focusNode!.hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(cli.connections, [('remote', 'fixture password')]);
    expect(app.stateOf('another')!.needsLink, isTrue);
    await tap(tester, find.byKey(const ValueKey('connect-machine-another')));
    final another = find.byKey(
      const ValueKey('connect-password-another-input'),
    );
    expect(tester.widget<TextField>(another).focusNode!.hasFocus, isTrue);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('connection continues across closing and reopening', (
    tester,
  ) async {
    app.add('remote', 'Mac mini');
    cli.connectReply = Completer<CliLinkConnectResult>();
    await mount(tester);
    await tap(tester, find.byKey(const ValueKey('connect-machine-remote')));
    await tester.enterText(remoteInput, 'fixture password');
    await key(tester, LogicalKeyboardKey.enter);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await tap(tester, find.text('open machines'));
    expect(tester.widget<TextField>(remoteInput).readOnly, isTrue);
    expect(tester.widget<TextField>(remoteInput).controller!.text, isEmpty);
    cli.connectReply!.complete(
      const CliLinkConnectResult(linkedMachineId: 'remote'),
    );
    await tester.pumpAndSettle();
    app.connected('remote');
    await tester.pumpAndSettle();
    expect(find.text('Connected'), findsNothing);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('machine-stats-remote')))
          .data,
      '0 harnesses · CPU — · RAM —',
    );
    expect(cli.connections, hasLength(1));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'loading, inventory failure, and password failure never look like an empty account',
    (tester) async {
      app.machinesLoading = true;
      cli.status = const RemotePasswordStatus(error: 'CLI unavailable');
      await mount(tester);
      expect(find.text('Looking for your machines…'), findsOneWidget);
      expect(
        find.text('1. Open Harness on your other computer.'),
        findsNothing,
      );
      expect(localInput, findsNothing);
      expect(find.text('CLI unavailable'), findsOneWidget);
      app.machinesLoading = false;
      app.inventoryError = 'Network unavailable';
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Couldn’t update your machines.'),
        findsOneWidget,
      );
      await tap(tester, find.text('Try again').last);
      expect(app.refreshes, 1);
      expect(
        find.text('1. Open Harness on your other computer.'),
        findsNothing,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'offline machine keeps clear recovery and no password submission',
    (tester) async {
      app.add('remote', 'Mac mini', online: false);
      await mount(tester);
      expect(find.textContaining('Offline'), findsOneWidget);
      expect(
        find.byTooltip('Open Harness on Mac mini to bring it online.'),
        findsOneWidget,
      );
      expect(remoteInput, findsNothing);
      expect(find.byKey(const ValueKey('open-machine-remote')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'guest sees sign-in and remains on the same panel when signed in',
    (tester) async {
      app.signedIn = false;
      await mount(tester);
      expect(find.text('Sign in'), findsOneWidget);
      expect(localInput, findsNothing);
      app.signedIn = true;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(localInput, findsNothing);
      expect(find.text('Set password'), findsOneWidget);
      await tap(tester, find.byTooltip('Add a machine'));
      expect(
        find.text('1. Open Harness on your other computer.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'custom prompt keys and composing text do not accidentally submit',
    (tester) async {
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      map.apply(
        '{"bindings":[{"when":"picker","keys":"enter","command":null},{"when":"picker","keys":"ctrl+s","command":"picker.accept"}]}',
      );
      await mount(tester, keymap: map);
      await tap(tester, find.text('Set password'));
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
      expect(tester.widget<TextField>(localInput).obscureText, isFalse);
      await tester.enterText(localInput, 'fixture password');
      await key(tester, LogicalKeyboardKey.enter);
      expect(cli.passwords, isEmpty);
      final controller = tester.widget<TextField>(localInput).controller!;
      controller.value = const TextEditingValue(
        text: 'fixture password',
        selection: TextSelection.collapsed(offset: 7),
        composing: TextRange(start: 0, end: 7),
      );
      await key(tester, LogicalKeyboardKey.escape);
      expect(find.text('Machines'), findsOneWidget);
      controller.value = controller.value.copyWith(composing: TextRange.empty);
      await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
      await tester.pumpAndSettle();
      expect(cli.passwords, ['fixture password']);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'setup and forms remain usable in a narrow window at large text size',
    (tester) async {
      await mount(tester, size: const Size(460, 740), scale: 1.6);
      await tap(tester, find.byTooltip('Add a machine'));
      await capture(tester, 'narrow-setup');
      await tap(tester, find.text('Set up a server…'));
      expect(tester.takeException(), isNull);
      app.add('remote', 'A machine with a long descriptive name');
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const ValueKey('connect-machine-remote')));
      await tester.ensureVisible(remoteInput);
      await tester.enterText(remoteInput, 'fixture password');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(cli.connections, hasLength(1));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'stats ignore late offline replies and stop polling when the panel closes',
    (tester) async {
      app.add('remote', 'Mac mini', linked: true);
      app.resourceReplies['remote'] = Completer<MachineResources?>();
      await mount(tester);
      app.notifyListeners();
      await tester.pump();
      expect(app.resourceReadIds.where((id) => id == 'remote'), hasLength(1));
      app.stateOf('remote')!.nodeOnline = false;
      app.notifyListeners();
      await tester.pump();
      app.resourceReplies
          .remove('remote')!
          .complete(const MachineResources(cpuPercent: 92));
      await tester.pumpAndSettle();
      final stats = find.byKey(const ValueKey('machine-stats-remote'));
      expect(tester.widget<Text>(stats).data, '— harnesses · CPU — · RAM —');
      app.resourceValues['remote'] = const MachineResources(cpuPercent: 7);
      app.stateOf('remote')!.nodeOnline = true;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(tester.widget<Text>(stats).data, '0 harnesses · CPU 7% · RAM —');
      final reads = app.resourceReadIds.length;
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.pump(const Duration(minutes: 1));
      app.notifyListeners();
      await tester.pump();
      expect(app.resourceReadIds, hasLength(reads));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'resource polling pauses behind connection settings and resumes on return',
    (tester) async {
      await mount(tester);
      final reads = app.resourceReadIds.length;
      await tap(tester, find.byTooltip('Options for M2'));
      await tap(tester, find.text('Connection settings…'));
      await tester.pump(const Duration(minutes: 1));
      expect(app.resourceReadIds, hasLength(reads));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(app.resourceReadIds.length, greaterThan(reads));
      expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a replacement machine cannot inherit cached stats or a delayed reply',
    (tester) async {
      app.add('remote', 'Mac mini', linked: true);
      final oldReply = Completer<MachineResources?>();
      app.resourceReplies['remote'] = oldReply;
      await mount(tester);
      app.resourceReplies.remove('remote');
      app.resourceValues['remote'] = const MachineResources(cpuPercent: 7);
      app.add('remote', 'Replacement', linked: true);
      await tester.pumpAndSettle();
      oldReply.complete(const MachineResources(cpuPercent: 99));
      await tester.pumpAndSettle();
      final stats = find.byKey(const ValueKey('machine-stats-remote'));
      expect(tester.widget<Text>(stats).data, '0 harnesses · CPU 7% · RAM —');
      expect(app.resourceReadIds.where((id) => id == 'remote'), hasLength(2));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'guest sign-in can be cancelled and successful sign-in returns to machines',
    (tester) async {
      app.signedIn = false;
      await mount(tester);
      await tap(tester, find.text('Sign in'));
      expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
      await tap(tester, find.byTooltip('Close'));
      expect(find.text('Sign in'), findsOneWidget);
      expect(app.refreshes, 0);
      await tap(tester, find.text('Sign in'));
      app.signedIn = true;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.text('Set password'), findsOneWidget);
      expect(app.refreshes, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'starting inventory, account instructions and shared machines stay clear',
    (tester) async {
      app.machineStates.clear();
      app.machines = [];
      app.machinesLoading = true;
      app.currentUser = const CurrentUserProfile(email: 'fixture@example.test');
      await mount(tester);
      expect(find.text('Starting Harness…'), findsOneWidget);
      expect(find.text('Looking for your machines…'), findsOneWidget);
      await tap(tester, find.text('Add a second machine'));
      expect(find.text('Sign in as fixture@example.test.'), findsOneWidget);
      await tap(tester, find.text('Set up a server…'));
      expect(find.text('Sign in as fixture@example.test.'), findsOneWidget);
      await tap(tester, find.text('Hide server setup'));
      await tap(tester, find.byTooltip('Hide setup steps'));
      app.add('remote', 'Shared work', linked: true);
      final shared = app.stateOf('remote')!;
      app.machineStates['remote'] = MachineState(
        const Machine(
          machineId: 'remote',
          name: 'Shared work',
          isShared: true,
          authMode: MachineAuthMode.remote,
        ),
      )..connectionStatus = shared.connectionStatus;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.textContaining('Shared with you'), findsOneWidget);
      expect(find.byTooltip('Options for Shared work'), findsNothing);
      expect(find.text('View harnesses'), findsNothing);
      await tap(tester, find.text('Shared work'));
      expect(opened, 'remote');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('the row menu opens OVER the list, never instead of it', (
    tester,
  ) async {
    // The menu used to be a Navigator route, which an overlay panel sits above,
    // so the panel hid itself to let three items show — and a person saw their
    // machines vanish the moment they clicked "…".
    app.add('remote', 'Mac mini');
    await mount(tester);
    await tap(tester, find.byTooltip('Options for Mac mini'));
    expect(find.text('Rename'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('machines-panel')),
      findsOneWidget,
      reason: 'the panel stays on screen behind its own menu',
    );
    expect(find.text('Mac mini'), findsWidgets);
    expect(find.text('M2'), findsWidgets, reason: 'the other rows stay too');
    await capture(tester, 'machines-row-menu');

    // Escape closes the menu first, and only then the panel.
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Rename'), findsNothing);
    expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'removing a machine requires the existing confirmation and returns to the list',
    (tester) async {
      app.add('remote', 'Mac mini');
      await mount(tester);
      await tap(tester, find.byTooltip('Options for Mac mini'));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Mac mini'), findsOneWidget);
      await tap(tester, find.byTooltip('Options for Mac mini'));
      await tap(tester, find.text('Remove from account…'));
      expect(app.deletes, isEmpty);
      await tap(tester, find.text('Cancel'));
      expect(find.text('Mac mini'), findsOneWidget);
      await tap(tester, find.byTooltip('Options for Mac mini'));
      await tap(tester, find.text('Remove from account…'));
      await tap(tester, find.byKey(const Key('machine-delete-confirm')));
      expect(app.deletes, ['remote']);
      expect(find.text('Mac mini'), findsNothing);
      expect(find.text('Add a second machine'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'password validation, visibility, help and cancel keep values private',
    (tester) async {
      cli.status = const RemotePasswordStatus(hasPassword: true);
      await mount(tester);
      await tap(tester, find.text('Change password'));
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Enter a password.'), findsOneWidget);
      expect(cli.passwords, isEmpty);
      await tester.enterText(localInput, 'fixture');
      await tester.pump();
      expect(find.text('Enter a password.'), findsNothing);
      await tap(tester, find.byTooltip('Show password'));
      expect(tester.widget<TextField>(localInput).obscureText, isFalse);
      await tap(tester, find.byTooltip('Hide password'));
      expect(tester.widget<TextField>(localInput).obscureText, isTrue);
      tester.widget<TextField>(localInput).focusNode!.requestFocus();
      await tester.pump();
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(localInput).obscureText, isFalse);
      await tap(tester, find.byTooltip('Password help'));
      expect(
        find.text(
          'Use this password to connect to M2 from your other computers.',
        ),
        findsOneWidget,
      );
      final field = tester.widget<TextField>(localInput);
      field.controller!.text = 'line one\nline two';
      await tap(tester, find.text('Save'));
      expect(find.text('Use a password on one line.'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.keyU, ctrl: true);
      await tester.pump();
      expect(find.text('Use a password on one line.'), findsNothing);
      await tap(tester, find.text('Cancel'));
      expect(localInput, findsNothing);
      await tap(tester, find.text('Change password'));
      expect(tester.widget<TextField>(localInput).controller!.text, isEmpty);
      // The platform's Done action uses the same validation and submission.
      await tester.enterText(localInput, 'fixture replacement');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(cli.passwords, ['fixture replacement']);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'failed password status retries and a reopened failed save can be cancelled',
    (tester) async {
      cli.status = const RemotePasswordStatus(error: 'Status unavailable');
      await mount(tester);
      expect(find.text('Status unavailable'), findsOneWidget);
      cli.status = const RemotePasswordStatus(hasPassword: true);
      await tap(tester, find.text('Try again'));
      await tap(tester, find.text('Change password'));
      cli.setReply = Completer<RemotePasswordSetResult>();
      await tester.enterText(localInput, 'fixture replacement');
      await tap(tester, find.text('Save'));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tap(tester, find.text('open machines'));
      expect(find.text('Saving password…'), findsOneWidget);
      cli.setReply!.complete(
        const RemotePasswordSetResult(error: 'Save unavailable'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Save unavailable'), findsOneWidget);
      expect(localInput, findsOneWidget);
      await tap(tester, find.text('Cancel'));
      expect(find.text('Change password'), findsOneWidget);
      expect(cli.passwords, ['fixture replacement']);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'copy actions recover, ignore older results and reset their feedback',
    (tester) async {
      final copies = <String>[];
      final replies = <Completer<Object?>>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method != 'Clipboard.setData') return null;
          copies.add((call.arguments as Map)['text'] as String);
          final reply = Completer<Object?>();
          replies.add(reply);
          return reply.future;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await mount(tester);
      await tap(tester, find.text('Add a second machine'));
      await tap(tester, find.text('Copy download link'));
      replies.last.completeError(
        PlatformException(code: 'clipboard-unavailable'),
      );
      await tester.pumpAndSettle();
      await tap(tester, find.text('Couldn’t copy. Try again'));
      final older = replies.last;
      await tap(tester, find.text('Couldn’t copy. Try again'));
      replies.last.complete(null);
      await tester.pumpAndSettle();
      older.completeError(PlatformException(code: 'late-error'));
      await tester.pumpAndSettle();
      expect(find.text('Copied'), findsOneWidget);
      expect(copies.toSet(), hasLength(1));
      expect(Uri.parse(copies.first).scheme, 'https');
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('Copy download link'), findsOneWidget);
      await tap(tester, find.text('Set up a server…'));
      await tap(tester, find.byTooltip('Copy commands'));
      expect(copies.last, contains('harness login'));
      expect(copies.last, contains('harness start'));
      await capture(tester, 'server-setup');
      replies.last.completeError(
        PlatformException(code: 'clipboard-unavailable'),
      );
      await tester.pumpAndSettle();
      await tap(tester, find.byTooltip('Couldn’t copy. Try again'));
      replies.last.complete(null);
      await tester.pumpAndSettle();
      expect(find.byTooltip('Copied'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      await tap(tester, find.byTooltip('Copy commands'));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      replies.last.complete(null);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'desktop setup leads with the app and recovers from browser failures',
    (tester) async {
      const channel = MethodChannel('plugins.flutter.io/url_launcher');
      final launches = <String>[];
      Object? result = false;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        launches.add((call.arguments as Map)['url'] as String);
        if (result is Exception) {
          throw result;
        }
        if (result is Completer<bool>) {
          return result.future;
        }
        return result;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      await mount(tester);
      await tap(tester, find.text('Add a second machine'));
      expect(
        find.text('1. Open Harness on your other computer.'),
        findsOneWidget,
      );
      expect(find.textContaining('curl -fsSL'), findsNothing);
      await tap(tester, find.text('Download Harness'));
      expect(
        find.text('Couldn’t open your browser. Copy the link instead.'),
        findsOneWidget,
      );
      result = PlatformException(code: 'browser-unavailable');
      await tap(tester, find.text('Download Harness'));
      expect(find.text('Copy download link'), findsOneWidget);
      result = true;
      await tap(tester, find.text('Download Harness'));
      expect(find.textContaining('Couldn’t open your browser'), findsNothing);
      expect(launches.toSet(), {'https://www.autonomous.ai/harness'});
      final pending = Completer<bool>();
      result = pending;
      await tap(tester, find.text('Download Harness'));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      pending.complete(false);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'resource refresh backs off on failure and pauses while the app is inactive',
    (tester) async {
      app.resourceValues['local'] = const MachineResources(cpuPercent: 12);
      await mount(tester);
      expect(app.resourceReadIds, ['local']);
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(app.resourceReadIds, ['local', 'local']);
      app.resourceValues.clear();
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(find.text('0 harnesses · CPU — · RAM —'), findsOneWidget);
      final reads = app.resourceReadIds.length;
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(seconds: 5));
      }
      expect(app.resourceReadIds, hasLength(reads));
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(app.resourceReadIds, hasLength(reads + 1));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump(const Duration(minutes: 1));
      expect(app.resourceReadIds, hasLength(reads + 1));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(app.resourceReadIds, hasLength(reads + 2));
      app.machineStates.clear();
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.text('Starting Harness…'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Machines toolbar remains usable in a short narrow workspace at large text size',
    (tester) async {
      final previous = newHarnessOpensInBox;
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = previous);
      await mount(
        tester,
        size: const Size(480, 360),
        scale: 1.7,
        workspace: true,
      );
      expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
      await tap(tester, find.byTooltip('Close Machines'));
      expect(
        find.byKey(const ValueKey('swarm-machines-button')).hitTestable(),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('welcome teaches the effective Machines shortcut', (
    tester,
  ) async {
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    final commands = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: KeymapProvider(
          keymap: map,
          child: WorkspaceWelcome(onCommand: commands.add),
        ),
      ),
    );
    expect(find.text('⌘M'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('welcome-machines.list')));
    expect(commands, ['machines.list']);
    map.apply(
      '{"bindings":[{"keys":"cmd+m","command":null},{"keys":"cmd+y","command":"machines.list"}]}',
    );
    await tester.pumpAndSettle();
    expect(find.text('⌘Y'), findsOneWidget);
    expect(find.text('⌘M'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
