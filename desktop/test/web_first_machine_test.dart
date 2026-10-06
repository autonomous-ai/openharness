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
import 'package:harness/widgets/machine_picker_form.dart';
import 'package:harness/widgets/link_another_machine_dialog.dart'
    show kLinkServerInstallCommand, kLinkServerLoginCommand;
import 'package:harness/widgets/web_download_button.dart';

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

  testWidgets('a computer waiting on this browser connects right here', (
    tester,
  ) async {
    const machine = Machine(
      machineId: 'mac',
      name: 'MacBookPro2021.local',
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    app.machineStates['mac'] = MachineState(machine)
      ..nodeOnline = true
      ..needsLink = true;
    await mount(tester);

    expect(find.text('Connect your computer'), findsOneWidget);
    expect(find.text('MacBookPro2021.local'), findsOneWidget);
    expect(find.text('Or set up another computer'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pump();

    expect(find.byType(MachinePickerForm), findsOneWidget);
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

  testWidgets('stacks the two ways in on a narrow window', (tester) async {
    await mount(tester, width: 420);

    expect(tester.takeException(), isNull);
    final app = tester.getTopLeft(find.text('Desktop app'));
    final cli = tester.getTopLeft(find.text('Command line'));
    expect(cli.dy, greaterThan(app.dy));
  });
}
