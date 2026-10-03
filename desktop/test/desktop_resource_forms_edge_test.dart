import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/api_picker_form.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/machine_picker_form.dart';

import 'keymap_host_test.dart' show key;
import 'support/machine_api.dart';
import 'support/password_cli.dart';

const _connection = ApiConnection({
  'id': 'review-api',
  'provider': 'custom',
  'name': 'Review API',
  'baseUrl': 'https://review.example.test/v1',
  'keyEnv': 'REVIEW_API_KEY',
  'authHeader': 'Authorization',
  'authPrefix': 'Bearer',
});

class _App extends AppNotifier {
  _App() : this._(PasswordCli());
  _App._(this.passwords)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLink: passwords,
      ) {
    api = edits;
    const machine = Machine(
      machineId: 'm',
      name: 'Studio Mac',
      authMode: MachineAuthMode.remote,
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..localOnly = true
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
  }

  final PasswordCli passwords;
  final edits = MachineApi();
  final apiRequests = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> apiConnections(
    String machineId,
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    apiRequests.add(payload);
    return {
      'connections': payload['action'] == 'remove' ? [] : [_connection.data],
      'presets': [],
    };
  }
}

Future<void> _mount(
  WidgetTester tester,
  Widget form, {
  FocusNode? query,
  bool desktop = true,
  Brightness brightness = Brightness.dark,
}) async {
  tester.view.physicalSize = const Size(500, 660);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              if (query != null)
                TextField(
                  key: const ValueKey('resource-query'),
                  focusNode: query,
                ),
              Expanded(child: desktop ? DesktopChrome(child: form) : form),
            ],
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder _machine(String id) => find.byKey(ValueKey('machine-form:$id'));
Finder _api(String id) => find.byKey(ValueKey('api-form:$id'));
Finder _apiInput(String id) => find.byKey(ValueKey('api-form-input:$id'));
final _rename = find.byKey(const ValueKey('machine-rename-input'));
TextField _field(WidgetTester tester, Finder finder) =>
    tester.widget<TextField>(finder);
bool _buttonFocused(WidgetTester tester, Finder finder) =>
    switch (tester.widget(finder)) {
      DesktopPill(:final focusNode) => focusNode!.hasFocus,
      ButtonStyleButton(:final focusNode) => focusNode!.hasFocus,
      _ => false,
    };

void main() {
  for (final switchPane in [true, false]) {
    testWidgets('native machine Tab boundaries preserve draft ($switchPane)', (
      tester,
    ) async {
      final app = _App();
      final query = FocusNode(debugLabel: 'Resource query');
      final form = GlobalKey<MachinePickerFormState>();
      final closed = <String?>[];
      addTearDown(app.dispose);
      addTearDown(query.dispose);
      await _mount(
        tester,
        MachinePickerForm(
          key: form,
          app: app,
          kind: MachinePickerFormKind.rename,
          machineId: 'm',
          onClose: closed.add,
          onFocusChanged: (_) {},
          onSwitchPane: switchPane ? query.requestFocus : null,
        ),
        query: switchPane ? query : null,
      );
      await tester.enterText(_rename, 'Build Mac');
      await key(tester, LogicalKeyboardKey.tab);
      expect(_buttonFocused(tester, _machine('Save')), isTrue);
      await key(tester, LogicalKeyboardKey.tab);
      expect(_buttonFocused(tester, _machine('Cancel')), isTrue);
      await key(tester, LogicalKeyboardKey.tab);
      expect(
        switchPane
            ? query.hasFocus
            : _field(tester, _rename).focusNode!.hasFocus,
        isTrue,
      );
      form.currentState!.focus();
      await tester.pump();
      await key(tester, LogicalKeyboardKey.tab, shift: true);
      expect(
        switchPane
            ? query.hasFocus
            : _buttonFocused(tester, _machine('Cancel')),
        isTrue,
      );
      form.currentState!.focus();
      await tester.pump();
      expect(_field(tester, _rename).controller!.text, 'Build Mac');
      expect(app.edits.renames, isEmpty);
      expect(closed, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'native API Tab boundaries preserve masked draft ($switchPane)',
      (tester) async {
        final app = _App();
        final controller = ApiConnectionsController(app, machineId: 'm')
          ..loaded = true
          ..connections = [_connection];
        final query = FocusNode(debugLabel: 'Resource query');
        final form = GlobalKey<ApiPickerFormState>();
        addTearDown(app.dispose);
        addTearDown(controller.dispose);
        addTearDown(query.dispose);
        await _mount(
          tester,
          ApiPickerForm(
            key: form,
            controller: controller,
            connectionId: _connection.id,
            onClose: (_) => fail('Traversal must not close the API editor'),
            onFocusChanged: (_) {},
            onSwitchPane: switchPane ? query.requestFocus : null,
          ),
          query: switchPane ? query : null,
          brightness: switchPane ? Brightness.light : Brightness.dark,
        );
        await tester.enterText(_apiInput('key'), 'fixture-only-secret');
        // One row under the fields, the job first: Save, Cancel, then the quieter ones.
        for (final id in ['save', 'cancel', 'visibility', 'options']) {
          await key(tester, LogicalKeyboardKey.tab);
          expect(_buttonFocused(tester, _api(id)), isTrue);
        }
        await key(tester, LogicalKeyboardKey.tab);
        expect(
          switchPane
              ? query.hasFocus
              : _field(tester, _apiInput('name')).focusNode!.hasFocus,
          isTrue,
        );
        form.currentState!.focus();
        await tester.pump();
        await key(tester, LogicalKeyboardKey.tab, shift: true);
        expect(
          switchPane ? query.hasFocus : _buttonFocused(tester, _api('options')),
          isTrue,
        );
        form.currentState!.focus();
        await tester.pump();
        expect(
          _field(tester, _apiInput('key')).controller!.text,
          'fixture-only-secret',
        );
        expect(_field(tester, _apiInput('key')).obscureText, isTrue);
        expect(
          controller.connections.single.data.containsKey('apiKey'),
          isFalse,
        );
        expect(app.apiRequests, isEmpty);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('machine name validation recovers through readline editing', (
    tester,
  ) async {
    final app = _App();
    addTearDown(app.dispose);
    await _mount(
      tester,
      MachinePickerForm(
        app: app,
        kind: MachinePickerFormKind.rename,
        machineId: 'm',
        onClose: (_) {},
        onFocusChanged: (_) {},
      ),
    );
    await tester.enterText(_rename, '   ');
    await key(tester, LogicalKeyboardKey.enter);
    expect(find.text('Enter a name.'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.keyU, ctrl: true);
    expect(find.text('Enter a name.'), findsNothing);
    await tester.enterText(_rename, 'Draft');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(app.edits.renames, isEmpty);
    await tester.tapAt(const Offset(2, 2));
    await tester.pump();
    expect(_field(tester, _rename).controller!.text, 'Draft');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'native API deletion starts on Cancel and requires choosing Delete',
    (tester) async {
      final app = _App();
      final controller = ApiConnectionsController(app, machineId: 'm')
        ..loaded = true
        ..connections = [_connection];
      final closed = <String?>[];
      addTearDown(app.dispose);
      addTearDown(controller.dispose);
      await _mount(
        tester,
        ApiPickerForm(
          controller: controller,
          connectionId: _connection.id,
          removing: true,
          onClose: closed.add,
          onFocusChanged: (_) {},
        ),
      );
      expect(_buttonFocused(tester, _api('cancel')), isTrue);
      expect(
        tester
            .widget<FilledButton>(_api('delete'))
            .style!
            .backgroundColor!
            .resolve({}),
        Theme.of(tester.element(_api('delete'))).colorScheme.error,
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(closed, [null]);
      expect(app.apiRequests, isEmpty);
      await key(tester, LogicalKeyboardKey.tab, shift: true);
      expect(_buttonFocused(tester, _api('delete')), isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(app.apiRequests, [
        {'action': 'remove', 'id': _connection.id},
      ]);
      expect(closed, [null, '']);
    },
  );

  for (final kind in [MachinePickerFormKind.app, MachinePickerFormKind.cli]) {
    testWidgets(
      'legacy $kind setup keeps selectable installation instructions',
      (tester) async {
        final app = _App();
        addTearDown(app.dispose);
        await _mount(
          tester,
          MachinePickerForm(
            app: app,
            kind: kind,
            machineId: 'm',
            onClose: (_) {},
            onFocusChanged: (_) {},
          ),
          desktop: false,
        );
        expect(find.byType(SelectableText), findsWidgets);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('legacy machine rename shows errors and one pending save', (
    tester,
  ) async {
    final app = _App();
    addTearDown(app.dispose);
    await _mount(
      tester,
      MachinePickerForm(
        app: app,
        kind: MachinePickerFormKind.rename,
        machineId: 'm',
        onClose: (_) {},
        onFocusChanged: (_) {},
      ),
      desktop: false,
    );
    await tester.enterText(_rename, '');
    await key(tester, LogicalKeyboardKey.enter);
    expect(find.text('Enter a name.'), findsOneWidget);
    app.edits.renameReply = Completer<String?>();
    await tester.enterText(_rename, 'New name');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pump();
    expect(_field(tester, _rename).readOnly, isTrue);
    await key(tester, LogicalKeyboardKey.enter);
    expect(app.edits.renames, [('m', 'New name')]);
    app.edits.renameReply!.complete(null);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
