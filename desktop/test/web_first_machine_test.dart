import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/web/onboarding/web_first_machine.dart';
import 'package:harness/web/onboarding/web_your_computers.dart';
import 'package:harness/widgets/machine_picker_form.dart';
import 'package:harness/widgets/link_another_machine_dialog.dart'
    show kLinkServerInstallCommand, kLinkServerLoginCommand;
import 'package:harness/widgets/web_download_button.dart';

/// A password link under way, at its first stage.
class _Linking extends AppNotifier {
  _Linking()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  @override
  Future<String?>? pendingMachineLink(String machineId) =>
      Completer<String?>().future;

  @override
  String? machineLinkStage(String machineId) => 'deriving_key';
}

/// Counts the quiet machine-list reads the page makes while it waits.
class _Watching extends AppNotifier {
  _Watching()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  var reads = 0;

  @override
  Future<void> rereadMachines() async => reads++;
}

/// Dialing with no password: [trusted] says how the computer answers.
class _Dialing extends AppNotifier {
  _Dialing({required this.trusted})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final bool trusted;
  final dialed = <String>[];

  @override
  Future<bool> connectTrusted(String machineId, {Duration? timeout}) async {
    dialed.add(machineId);
    return trusted;
  }
}

void main() {
  late AppNotifier app;
  late List<Uri> opened;

  setUp(() {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    )..currentUser = const CurrentUserProfile(email: 'new@example.test');
    opened = [];
  });

  tearDown(() => app.dispose());

  Future<void> mount(WidgetTester tester, {double width = 900}) async {
    tester.view.physicalSize = Size(width, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SingleChildScrollView(
            child: WebFirstMachine(
              app: app,
              openPage: (uri) async {
                opened.add(uri);
                return true;
              },
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('names the account to sign in with, both ways in', (
    tester,
  ) async {
    await mount(tester);

    expect(find.text('Connect a computer'), findsOneWidget);
    expect(find.textContaining('new@example.test'), findsNWidgets(2));
    expect(find.text(kLinkServerInstallCommand), findsOneWidget);
    expect(find.text(kLinkServerLoginCommand), findsOneWidget);
    expect(find.text('Waiting for your computer…'), findsOneWidget);
  });

  testWidgets('Download app opens the download page', (tester) async {
    await mount(tester);

    await tester.tap(find.text('Download app'));

    expect(opened, [WebDownloadButton.uri]);
  });

  testWidgets('a command copies to the clipboard', (tester) async {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );

    await mount(tester);
    // The command itself is selectable text; the row's copy mark takes the tap.
    await tester.tap(find.byIcon(AppIcons.copy).at(1));
    await tester.pump();

    expect(copied, [kLinkServerLoginCommand]);
    await tester.pump(const Duration(seconds: 3));
  });

  void addWaitingComputer(AppNotifier on) {
    const machine = Machine(
      machineId: 'mac',
      name: 'MacBookPro2021.local',
      authMode: MachineAuthMode.remote,
    );
    on.machines.add(machine);
    on.machineStates['mac'] = MachineState(machine)
      ..nodeOnline = true
      ..needsLink = true;
  }

  testWidgets('a computer that trusts this browser connects with a click', (
    tester,
  ) async {
    app.dispose();
    app = _Dialing(trusted: true); // tearDown disposes it
    addWaitingComputer(app);
    await mount(tester);

    expect(find.text('Connect your computer'), findsOneWidget);
    expect(find.text('Or set up another computer'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pump();

    expect((app as _Dialing).dialed, ['mac']);
    expect(find.byType(MachinePickerForm), findsNothing);
  });

  testWidgets('one that does not answer says so and offers another try', (
    tester,
  ) async {
    app.dispose();
    app = _Dialing(trusted: false);
    addWaitingComputer(app);
    await mount(tester);

    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pump();

    expect(find.byType(MachinePickerForm), findsNothing, reason: 'no password');
    expect(find.textContaining("Couldn't connect"), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Try again'));
    await tester.pump();
    expect((app as _Dialing).dialed, ['mac', 'mac']);
  });

  testWidgets('keeps asking for the machine list while it waits', (
    tester,
  ) async {
    app.dispose();
    app = _Watching();
    await mount(tester);

    await tester.pump(WebFirstMachine.watchEvery * 3);

    expect((app as _Watching).reads, 3);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(WebFirstMachine.watchEvery * 2);
    expect((app as _Watching).reads, 3, reason: 'stops with the page');
  });

  void addComputer(String id, {bool online = false}) {
    final machine = Machine(
      machineId: id,
      name: 'MacBookPro2021.local',
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    app.machineStates[id] = MachineState(machine)
      ..nodeOnline = online
      ..needsLink = online;
  }

  testWidgets('a computer taken out of the account says to sign in on it', (
    tester,
  ) async {
    addComputer('mac');
    app.removedMachines = {'mac': 23};
    await mount(tester);

    expect(find.textContaining('Removed from your account'), findsOneWidget);
    expect(find.textContaining('Offline'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Connect'), findsNothing);
  });

  testWidgets('a computer set up again shows once, as it is now', (
    tester,
  ) async {
    addComputer('before');
    addComputer('now', online: true);
    app.removedMachines = {'before': 20};
    await mount(tester);

    expect(find.text('MacBookPro2021.local'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Connect'), findsOneWidget);
  });

  test('of removed ones sharing a name, only the latest removal is kept', () {
    addComputer('yesterday');
    addComputer('today');
    final listed = WebYourComputers.newestOfEachName(
      app.machineStates.values.toList(),
      {'yesterday': 20, 'today': 23},
    );

    expect([for (final s in listed) s.machine.machineId], ['today']);
  });

  testWidgets('an offline computer says what to do on it', (tester) async {
    const machine = Machine(
      machineId: 'mac',
      name: 'MacBookPro2021.local',
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    app.machineStates['mac'] = MachineState(machine)..nodeOnline = false;
    await mount(tester);

    expect(find.textContaining('Offline'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Connect'), findsNothing);
  });

  testWidgets('a link in progress reads the same in the row as in the form', (
    tester,
  ) async {
    final linking = _Linking();
    const machine = Machine(
      machineId: 'mac',
      name: 'MacBookPro2021.local',
      authMode: MachineAuthMode.remote,
    );
    linking.machines.add(machine);
    final state = linking.machineStates['mac'] = MachineState(machine)
      ..nodeOnline = true
      ..needsLink = true;

    expect(
      computerLinkState(linking, state, failed: true),
      ComputerLinkState.linking,
    );
    app.dispose();
    app = linking; // tearDown disposes it
    await mount(tester);

    expect(find.text('Checking password…'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Connect'), findsNothing);
  });

  testWidgets('stacks the two ways in on a narrow window', (tester) async {
    await mount(tester, width: 420);

    expect(tester.takeException(), isNull);
    final app = tester.getTopLeft(find.text('Desktop app'));
    final cli = tester.getTopLeft(find.text('Command line'));
    expect(cli.dy, greaterThan(app.dy));
  });
}
