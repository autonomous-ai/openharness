// Machines lists the account's signed-in devices beside its machines: COMPUTERS (each machine, with
// this computer's code, and a signed-in computer that has no machine record), then PHONES & APPS.
// These moved here from Settings ▸ Your devices and Settings ▸ Profiles. The device list and every
// write are canned (support/devices_app.dart), so nothing reaches a daemon.
import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/measurement/product_measurement.dart'
    show AddPhoneOpening;
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/machine_devices.dart';
import 'package:harness/state/swarm_search.dart' show MachineSearchSection;
import 'package:harness/viewer/device_history.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/add_phone_dialog.dart' show AddPhoneDialog;
import 'package:harness/widgets/machine_picker_extras.dart';
import 'package:harness/widgets/new_device_notice.dart' show openMachines;

import 'support/devices_app.dart';
import 'support/resource_picker.dart';
import 'support/workspace_tools.dart';
import 'swarm_screen_test.dart' show terminal;

const _localId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _remoteId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _strayId = 'cccccccccccccccccccccccccccccccc';

class _App extends FakeDevicesApp {
  final deletes = <String>[];
  String? deleteError;

  /// Each Add Phone opened, by its way in.
  final addPhoneOpenings = <AddPhoneOpening>[];

  @override
  void addPhoneOpened(AddPhoneOpening from) {
    addPhoneOpenings.add(from);
    super.addPhoneOpened(from);
  }

  @override
  Future<String?> deleteMachine(String id) async {
    deletes.add(id);
    if (deleteError != null) return deleteError;
    machineStates.remove(id);
    machines = machineStates.values.map((s) => s.machine).toList();
    notifyListeners();
    return null;
  }

  void add(String id, String name, {bool local = false}) {
    final machine = Machine(
      machineId: id,
      name: name,
      authMode: MachineAuthMode.remote,
    );
    machineStates[id] = MachineState(machine)
      ..localOnly = local
      ..nodeOnline = true
      ..needsLink = false
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..connectionStatus = ConnectionStatus.connected;
    machines = machineStates.values.map((s) => s.machine).toList();
    notifyListeners();
  }
}

/// Add Phone's daemon and backend, canned so nothing reaches a network: no
/// phone waiting to pair, a sign-in code for the QR, and no pending list.
class _AddPhoneApi extends ApiClient {
  _AddPhoneApi() : super(config: AppConfig.dev, session: AuthSession());

  @override
  Future<({int status, Map<String, dynamic> body})> pair(
    String code, {
    CancelToken? cancelToken,
  }) async => (status: 409, body: <String, dynamic>{'error': 'NO_INTENT'});

  @override
  Future<({String code, Duration ttl})?> phoneSignInCode() async =>
      (code: 'h1', ttl: const Duration(seconds: 90));

  @override
  Future<Map<String, dynamic>?> daemonDevices() async => null;
}

/// The phone half of a sign-in, canned: a lamp on this network asking, and what this computer said.
class _ApproveApi extends ApiClient {
  _ApproveApi({this.sameNetwork = true, this.status = 'pending'})
    : super(config: AppConfig.dev, session: AuthSession());
  final bool sameNetwork;
  final String status;
  final looked = <String>[];
  final answers = <String>[];
  @override
  Future<Map<String, dynamic>> signInLookup(String code) async {
    looked.add(code);
    return {'label': 'Lamp', 'kind': 'computer', 'sameNetwork': sameNetwork, 'status': status, 'country': 'VN', 'ipHint': '9.8.7.x'};
  }

  @override
  Future<void> approveSignIn(String code) async => answers.add('approve:$code');
  @override
  Future<void> denySignIn(String code) async => answers.add('deny:$code');
}

AccountDevice _device(
  String pub, {
  required String label,
  String kind = 'viewer',
  String machineId = '',
  bool self = false,
  Duration? seenAgo,
  String fingerprint = fakeFingerprint,
  bool pending = false,
}) {
  final now = DateTime.now();
  return AccountDevice(
    pub: pub,
    label: label,
    kind: kind,
    machineId: machineId,
    addedAt: now.subtract(const Duration(days: 30)),
    fingerprint: fingerprint,
    self: self,
    lastSeen: seenAgo == null ? null : now.subtract(seenAgo),
    pending: pending,
  );
}

void main() {
  late _App app;

  setUp(() {
    app = _App()
      ..add(_localId, 'Studio Mac', local: true)
      ..add(_remoteId, 'Build box');
    app.devices = AccountDevices(
      devices: [
        _device(
          'self',
          label: 'Studio Mac',
          kind: 'machine',
          machineId: _localId,
          self: true,
          fingerprint: 'D991·0A0B·0C0D·0E0F',
        ),
        _device(
          'remote',
          label: 'Build box',
          kind: 'machine',
          machineId: _remoteId,
          seenAgo: const Duration(minutes: 21),
        ),
        _device(
          'stray',
          label: 'Lab computer',
          kind: 'machine',
          machineId: _strayId,
          seenAgo: const Duration(hours: 3),
        ),
        _device(
          'phone',
          label: 'Test iPhone',
          seenAgo: const Duration(minutes: 27),
        ),
      ],
      historyAvailable: true,
    );
  });
  tearDown(() => app.dispose());

  Future<void> mount(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 900);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: SwarmScreen(notifier: app, nativeTabs: false),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> openPicker(WidgetTester tester) async {
    await openWorkspaceManagement(tester, 'machines');
    await tester.pumpAndSettle();
    expect(resourceScope('@'), findsOneWidget);
  }

  Finder pill(String label) => find.widgetWithText(DesktopPill, label);

  testWidgets('computers, then phones and apps; this computer shows its code', (
    tester,
  ) async {
    await mount(tester);
    await openPicker(tester);
    final search = resourceSearch(tester);
    expect(search.rows.map((row) => row.title), [
      'Studio Mac',
      'Build box',
      'Lab computer',
      'Test iPhone',
      'Add machine',
    ]);
    expect(
      find.byKey(const ValueKey('machine-section:computers')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('machine-section:phones')),
      findsOneWidget,
    );
    expect(find.text('Computers'), findsOneWidget);
    expect(find.text('Phones & apps'), findsOneWidget);
    final local = search.rows.firstWhere((row) => row.title == 'Studio Mac');
    expect(local.detail, contains('This computer · code D991…'));
    final remote = search.rows.firstWhere((row) => row.title == 'Build box');
    expect(remote.detail, contains('last active 21 minutes ago'));
    // A computer signed in to the account with no machine record is still a computer.
    final stray = search.rows.firstWhere((row) => row.title == 'Lab computer');
    expect(stray.devicePub, 'stray');
    expect(stray.deviceIsComputer, isTrue);
    expect(search.machineSection(stray), MachineSearchSection.computers);

    await selectResource(tester, 'machine:$_localId');
    await tester.pumpAndSettle();
    expect(find.text('D991·0A0B·0C0D·0E0F'), findsOneWidget);
    expect(find.byKey(const ValueKey('device-code-copy:self')), findsOneWidget);
    // This computer is never removed from here.
    expect(pill('Remove'), findsNothing);
  });

  testWidgets('a phone: its facts and code; Remove signs it out after asking', (
    tester,
  ) async {
    await mount(tester);
    await openPicker(tester);
    await selectResource(tester, 'device:phone');
    await tester.pumpAndSettle();
    expect(find.text('App'), findsOneWidget);
    expect(find.text(fakeFingerprint), findsOneWidget);
    await tester.tap(pill('Remove'));
    await tester.pumpAndSettle();
    expect(find.text('Remove Test iPhone?'), findsOneWidget);
    expect(app.removed, isEmpty);
    await tester.tap(find.byKey(const Key('account-device-confirm')));
    await tester.pumpAndSettle();
    expect(app.removed, ['phone']);
    expect(
      resourceSearch(tester).rows.any((row) => row.devicePub == 'phone'),
      isFalse,
    );
  });

  testWidgets(
    'Remove on a computer signs it out AND deletes its machine record, and says so first',
    (tester) async {
      await mount(tester);
      await openPicker(tester);
      await selectResource(tester, 'machine:$_remoteId');
      await tester.pumpAndSettle();
      expect(pill('Delete'), findsNothing);
      await tester.tap(pill('Remove'));
      await tester.pumpAndSettle();
      expect(
        find.text('Remove this computer from your account?'),
        findsOneWidget,
      );
      expect(
        find.text('It is signed out, and its machine record is deleted.'),
        findsOneWidget,
      );
      expect(app.removed, isEmpty);
      expect(app.deletes, isEmpty);
      await tester.tap(find.byKey(const ValueKey('machine-form:Remove')));
      await tester.pumpAndSettle();
      expect(app.removed, ['remote']);
      expect(app.deletes, [_remoteId]);
    },
  );

  testWidgets(
    'Add machine says what to do in its one line; the preview keeps the steps',
    (tester) async {
      const line = 'Install Harness there and sign in to the same account';
      await mount(tester);
      await openPicker(tester);
      final add = resourceSearch(tester).rows
          .singleWhere((row) => row.isCreate);
      expect(add.title, 'Add machine');
      // Not "On the other computer:", the first line of the steps, cut off there.
      expect(add.detail, line);
      expect(add.terminalDetail, line);
      expect(
        find.descendant(
          of: find.byKey(ValueKey(add.id)),
          matching: find.text(line, findRichText: true),
        ),
        findsWidgets,
      );
      await selectResource(tester, add.id);
      await tester.pumpAndSettle();
      for (final step in [
        'On the other computer:',
        '1. Install the app or CLI.',
        '2. Sign in to the same account.',
        'It appears here and connects on its own.',
      ]) {
        expect(find.text(step), findsOneWidget, reason: step);
      }
    },
  );

  testWidgets('a sign-out that fails leaves the machine record alone', (
    tester,
  ) async {
    app.removeError = 'OFFLINE';
    await mount(tester);
    await openPicker(tester);
    await selectResource(tester, 'machine:$_remoteId');
    await tester.pumpAndSettle();
    await tester.tap(pill('Remove'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('machine-form:Remove')));
    await tester.pumpAndSettle();
    expect(app.removed, ['remote']);
    expect(app.deletes, isEmpty);
    expect(find.textContaining('Couldn’t sign Build box out'), findsOneWidget);
  });

  testWidgets('a new phone offers It’s mine', (tester) async {
    app.newDevices.add(
      const NewDeviceNotice(pub: 'phone', label: 'Test iPhone', kind: 'viewer'),
    );
    await mount(tester);
    await openPicker(tester);
    final row = resourceSearch(tester).rows
        .firstWhere((row) => row.devicePub == 'phone');
    expect(row.detail, endsWith('New'));
    await selectResource(tester, 'device:phone');
    await tester.pumpAndSettle();
    await tester.tap(pill('It’s mine'));
    await tester.pumpAndSettle();
    expect(app.dismissCalls, [('phone', false)]);
    // Opening Machines was looking at the list: what was new is marked seen.
    expect(app.seenPending, hasLength(1));
  });

  testWidgets('History… opens the account’s device history', (tester) async {
    app.history = const DeviceLogHistory(rows: [], complete: true);
    await mount(tester);
    await openPicker(tester);
    await tester.tap(find.byKey(const Key('account-devices-history')));
    await tester.pumpAndSettle();
    expect(find.text('Device history'), findsOneWidget);
  });

  // A device with no screen (a lamp, #1410) says eight digits aloud; this computer approves it as a
  // phone would, with the same "Sign in …?" before anything is sent.
  testWidgets('Approve a device takes the code a device says, and asks before approving', (tester) async {
    final api = _ApproveApi();
    app.api = api;
    await mount(tester);
    await openPicker(tester);
    await tester.tap(find.byKey(const Key('machine-picker-approve-device')));
    await tester.pumpAndSettle();
    final next = find.byKey(const Key('sign-in-code-continue'));
    await tester.enterText(find.byKey(const Key('sign-in-code-field')), '1234 567');
    await tester.pump();
    expect(tester.widget<FilledButton>(next).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('sign-in-code-field')), '1234 5678');
    await tester.pump();
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(api.looked, ['12345678']);
    expect(find.text('Sign in Lamp?'), findsOneWidget);
    expect(api.answers, isEmpty);
    await tester.tap(find.byKey(const Key('approve-sign-in-approve')));
    await tester.pumpAndSettle();
    expect(api.answers, ['approve:12345678']);
  });

  Future<void> typeCode(WidgetTester tester, String code) async {
    await tester.tap(find.byKey(const Key('machine-picker-approve-device')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Never type a code someone sent you'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('sign-in-code-field')), code);
    await tester.pump();
    await tester.tap(find.byKey(const Key('sign-in-code-continue')));
    await tester.pumpAndSettle();
  }

  // A code is easily read out over a call or a chat: a device on another network takes a deliberate
  // hold, as on the phone, never one click.
  testWidgets('a device on another network is approved only by holding', (tester) async {
    final api = _ApproveApi(sameNetwork: false);
    app.api = api;
    await mount(tester);
    await openPicker(tester);
    await typeCode(tester, '12345678');
    expect(find.textContaining('On another network (VN · 9.8.7.x)'), findsOneWidget);
    final hold = find.byKey(const Key('approve-sign-in-approve'));
    await tester.tap(hold);
    await tester.pump(const Duration(milliseconds: 300));
    expect(api.answers, isEmpty, reason: 'a click is not a hold');
    final gesture = await tester.startGesture(tester.getCenter(hold));
    await tester.pump(); // the hold's clock starts on the first frame after the press
    await tester.pump(const Duration(milliseconds: 2100));
    await gesture.up();
    await tester.pumpAndSettle();
    expect(api.answers, ['approve:12345678']);
  });

  testWidgets('a code someone else answered warns before the device asks', (tester) async {
    final api = _ApproveApi(status: 'approved');
    app.api = api;
    await mount(tester);
    await openPicker(tester);
    await typeCode(tester, '12345678');
    expect(find.textContaining('Someone else already answered this code'), findsOneWidget);
    expect(api.answers, isEmpty);
  });

  testWidgets('Show in this window narrows the window to one computer', (
    tester,
  ) async {
    await mount(tester);
    await openPicker(tester);
    final field = find.byKey(const Key('machine-window-choice-field'));
    expect(field, findsOneWidget);
    final select = tester.widget<AppSelectField<String?>>(field);
    expect(select.value, isNull);
    expect(select.options.map((o) => o.label), [
      'All machines',
      'Studio Mac',
      'Build box',
    ]);
    select.onChanged(_remoteId);
    await tester.pumpAndSettle();
    expect(app.machineProfileId, _remoteId);
    tester.widget<AppSelectField<String?>>(field).onChanged(null);
    await tester.pumpAndSettle();
    expect(app.machineProfileId, isNull);
  });

  testWidgets(
    'a computer that is not connected or is offline cannot be chosen; one chosen stays',
    (tester) async {
      app.machineStates[_remoteId]!.connectionStatus =
          ConnectionStatus.disconnected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: app,
              builder: (context, _) => MachineWindowChoice(app: app),
            ),
          ),
        ),
      );
      List<String> offered() => tester
          .widget<AppSelectField<String?>>(
            find.byKey(const Key('machine-window-choice-field')),
          )
          .options
          .map((o) => o.label)
          .toList();
      expect(offered(), ['All machines', 'Studio Mac']);
      app.machineStates[_remoteId]!
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = false;
      app.notifyListeners();
      await tester.pump();
      expect(offered(), ['All machines', 'Studio Mac']);
      app.machineStates[_remoteId]!.nodeOnline = true;
      app.notifyListeners();
      await tester.pump();
      expect(offered(), ['All machines', 'Studio Mac', 'Build box']);
      app.setMachineProfile(_remoteId);
      app.machineStates[_remoteId]!.nodeOnline = false;
      app.notifyListeners();
      await tester.pump();
      final field = tester.widget<AppSelectField<String?>>(
        find.byKey(const Key('machine-window-choice-field')),
      );
      expect(field.value, _remoteId);
      expect(
        field.options.firstWhere((o) => o.value == _remoteId).note,
        contains('Offline'),
      );
    },
  );

  testWidgets('apps unused for 90 days are offered for removal together', (
    tester,
  ) async {
    app.devices = AccountDevices(
      devices: [
        ...app.devices!.devices,
        _device(
          'old',
          label: 'Old browser',
          seenAgo: const Duration(days: 120),
        ),
      ],
    );
    await mount(tester);
    await openPicker(tester);
    expect(find.byKey(const Key('account-devices-unused')), findsOneWidget);
    await tester.tap(find.byKey(const Key('account-devices-remove-unused')));
    await tester.pumpAndSettle();
    expect(find.text('Remove 1 unused app?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('account-device-confirm')));
    await tester.pumpAndSettle();
    expect(app.removed, ['old']);
  });

  testWidgets('the devices already on the account are said once; Got it', (
    tester,
  ) async {
    app.devices = AccountDevices(
      devices: app.devices!.devices,
      baselineSeen: false,
      baselineKeys: const ['phone'],
    );
    await mount(tester);
    await openPicker(tester);
    expect(find.byKey(const Key('account-devices-baseline')), findsOneWidget);
    await tester.tap(find.byKey(const Key('account-devices-baseline-gotit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('account-devices-baseline')), findsNothing);
    expect(app.baselineSeenCalls, 1);
  });

  testWidgets(
    'a frozen list offers Review…, which trusts it again after asking',
    (tester) async {
      app.devices = AccountDevices(
        devices: app.devices!.devices,
        frozenReason: 'fork',
      );
      app.previews.add(
        const DevicesRebaseline(added: ['Test iPhone'], removed: []),
      );
      app.confirmAnswer = const DevicesRebaseline(added: [], removed: []);
      await mount(tester);
      await openPicker(tester);
      expect(find.byKey(const Key('account-devices-frozen')), findsOneWidget);
      await tester.tap(find.byKey(const Key('account-devices-review')));
      await tester.pumpAndSettle();
      expect(find.text('Trust this device list again?'), findsOneWidget);
      await tester.tap(find.byKey(const Key('account-device-confirm')));
      await tester.pumpAndSettle();
      expect(app.confirmedHeads, hasLength(1));
    },
  );

  testWidgets('a deep link opens Machines on that device', (tester) async {
    await mount(tester);
    final context = tester.element(find.byType(SwarmScreen));
    openMachines(context, app, devicePub: 'phone');
    await tester.pumpAndSettle();
    expect(resourceScope('@'), findsOneWidget);
    expect(resourceSearch(tester).selected?.devicePub, 'phone');
    expect(app.machinesRequest, isNull);
  });

  testWidgets('a deep link to a computer selects its machine row', (
    tester,
  ) async {
    await mount(tester);
    app.requestMachines(devicePub: 'remote');
    await tester.pumpAndSettle();
    expect(resourceSearch(tester).selected?.id, 'machine:$_remoteId');
  });

  testWidgets('Add Phone’s way in selects the first phone', (tester) async {
    await mount(tester);
    app.requestMachines(phones: true);
    await tester.pumpAndSettle();
    expect(resourceSearch(tester).selected?.devicePub, 'phone');
  });

  testWidgets('See your phones, once Add Phone has its phone, opens Machines '
      'at its phones', (tester) async {
    app
      ..api = _AddPhoneApi()
      ..signedIn = true
      ..currentUser = const CurrentUserProfile(email: 'dee@example.test');
    // A terminal open, as on a desk in use: closing the dialog hands focus
    // back to it, and only then did the link fail.
    app.add('m', 'Test host');
    app.machineStates['m']!.agents = [
      const Agent(
        id: 'a0',
        name: 'Agent 0',
        engine: 'codex',
        terminalAvailable: true,
      ),
    ];
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester);
    expect(app.panes, isNotEmpty);
    // In by Machines' own Add phone: the account has a phone already, so the
    // tab row has no Add Phone of its own.
    await openPicker(tester);
    await tester.tap(find.byKey(const Key('machine-picker-add-phone')));
    await tester.pumpAndSettle();
    expect(find.byType(AddPhoneDialog), findsOneWidget);
    expect(app.addPhoneOpenings, [AddPhoneOpening.machines]);
    expect(resourceScope('@'), findsNothing);

    app.ownDaemonMachineIdForTest(_localId);
    await tester.runAsync(
      () => app.handleEventForTest(_localId, {
        'type': 'device_key_added',
        'payload': {
          'pub': 'new-phone',
          'label': 'Phat’s S23',
          'kind': 'viewer',
        },
      }),
    );
    await tester.pump();
    expect(find.text('Phat’s S23 is ready.'), findsOneWidget);

    // Right after the dialog's pop the workspace's route is not current yet:
    // opening Machines then was refused, and the link did nothing.
    await tester.tap(find.byKey(const ValueKey('add-phone-see-phones')));
    await tester.pumpAndSettle();
    expect(find.byType(AddPhoneDialog), findsNothing);
    expect(resourceScope('@'), findsOneWidget);
    expect(
      resourceSearch(tester).selected?.devicePub,
      isIn(['phone', 'new-phone']),
    );
  });

  test('a picker that opened on its own marks nothing seen', () async {
    final devices = MachineDevices(app)..markSeen = false;
    app.newDevices.add(
      const NewDeviceNotice(pub: 'phone', label: 'Test iPhone', kind: 'viewer'),
    );
    devices.start();
    await Future<void>.delayed(Duration.zero);
    expect(devices.loaded, isTrue);
    expect(app.seenPending, isEmpty);
    devices.dispose();
  });

  test('without a device list there are only machines', () async {
    app.loadError = StateError('daemon predates the list');
    final devices = MachineDevices(app)..start();
    await Future<void>.delayed(Duration.zero);
    expect(devices.loaded, isTrue);
    expect(devices.devices, isNull);
    expect(devices.rows({_localId}), isEmpty);
    expect(app.seenPending, isEmpty);
    devices.dispose();
  });
}
