import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// Swarm on the phone against an isolated local backend, a screenshot at each
/// step. First the real shell: Home without Swarm, Settings ▸ Experimental,
/// then Swarm Home at the root, Harness from its drawer, and the terminal's
/// Swarm mark and Find's Swarm command back to Swarm Home, all through the
/// app's own Swarm path to one account machine. Then the screens: what needs
/// the person and the Swarms, a project, a chat, a post with a mention, and a
/// decision answered with one tap and its Undo.
///
/// The backend is the local backend recipe's (in-memory MongoDB and Redis, a
/// fake SSO, no daemon), seeded with one Swarm whose open decision and tag are
/// for the owner. Its "machine" is a connection that forwards the phone's
/// Swarm requests to that backend over plain HTTP, as the daemon would, so
/// nothing here reaches a real account, machine or daemon: it refuses any
/// backend but 127.0.0.1 and knows only the recipe's fake owner token. Without
/// `SWARM_LOCAL_BACKEND` it skips. The screens test answers the decision, so
/// seed again before another run.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_local_review_test.dart \
///       --dart-define=SWARM_LOCAL_BACKEND=http://127.0.0.1:18085
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const backend = String.fromEnvironment('SWARM_LOCAL_BACKEND');

  testWidgets(
    "the real shell's ways in: Settings, Home's mark, Find",
    (tester) async {
      final local = _LocalBackend.open(backend);
      addTearDown(local.close);
      final accountId = await local.accountId();
      final walk = _Walk(tester, binding, 'shell');

      const machine = Machine(
        machineId: 'review-machine',
        authMode: MachineAuthMode.remote,
        name: 'Studio Mac',
      );
      final agents = [
        <String, dynamic>{
          'id': 'agent-review',
          'name': 'passkeys',
          'sessionId': 'session-review',
          'engine': 'claude',
          'status': 'active',
          'terminal': {'available': true},
          'project': {'name': 'harness', 'cwd': '/srv/harness'},
          'updatedAt': DateTime.now().toUtc().toIso8601String(),
        },
      ];
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(storage: _Memory()),
        configStore: null,
        connectionForTest: (machineId) =>
            _ForwardingConn(machineId, agents, local),
      );
      addTearDown(notifier.dispose);
      notifier
        ..currentUser = CurrentUserProfile(
          id: accountId,
          email: 'owner@local.test',
        )
        ..machines = [machine];
      notifier.machineStates[machine.machineId] = MachineState(machine)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [for (final json in agents) Agent.fromJson(json)];
      // Swarm starts off, and is turned off again however this ends: the
      // switch below writes this simulator's state file.
      experimentalFeaturesStore.value = const {};
      addTearDown(
        () => experimentalFeaturesStore.set(PhoneExperiment.swarm, false),
      );

      await tester.pumpWidget(_phone(PhoneShell(notifier: notifier)));
      // Back, as the page's own chevron does: the shell's navigator.
      Future<void> back() async {
        await tester
            .state<NavigatorState>(
              find
                  .descendant(
                    of: find.byType(PhoneShell),
                    matching: find.byType(Navigator),
                  )
                  .first,
            )
            .maybePop();
        await walk.wait(1200);
      }

      // ① Home with Swarm off: no mark.
      await walk.waitFor(find.byKey(const ValueKey('terminal-title')));
      await walk.wait(1500);
      expect(walk.key('swarm-mark'), findsNothing);
      await walk.shot('home-off');

      // ② The harness menu, then Settings ▸ Experimental ▸ Swarm.
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await walk.waitFor(find.text('Settings'));
      await walk.shot('menu');
      await tester.tap(find.text('Settings'));
      final row = walk.key('settings-experiment-swarm');
      await walk.waitFor(find.byType(Scrollable));
      await walk.wait();
      await tester.scrollUntilVisible(
        row,
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.tap(find.descendant(of: row, matching: find.text('Swarm')));
      await walk.wait();
      expect(experimentalFeaturesStore.isOn(PhoneExperiment.swarm), isTrue);
      await walk.shot('settings-experimental');

      // ③ Back: Swarm Home is the root now, what needs the person first.
      await back();
      // The menu, if it stayed under Settings.
      if (find.text('Settings').evaluate().isNotEmpty) await back();
      await walk.waitFor(find.textContaining('River asks you'));
      await walk.shot('swarm-home');

      // ④ Harness from its drawer: the terminal, its mark with how many
      // things need the person; the mark goes back to Swarm Home.
      Future<void> harness() async {
        await tester.tap(walk.key('swarm-menu'));
        await walk.waitFor(walk.key('swarm-drawer-harness'));
        await walk.wait();
        await tester.tap(walk.key('swarm-drawer-harness'));
        await walk.waitFor(walk.key('swarm-mark-count'));
      }

      await harness();
      expect(find.text('3'), findsOneWidget);
      await walk.shot('home-mark');
      await tester.tap(walk.key('swarm-mark'));
      await walk.waitFor(find.textContaining('River asks you'));
      await walk.shot('swarm-from-home');
      await harness();

      // ⑤ Find, a swipe right on the terminal: its Swarm command.
      await tester.timedDrag(
        find.byType(TerminalPage),
        const Offset(260, 0),
        const Duration(milliseconds: 300),
      );
      await walk.waitFor(find.byType(TextField));
      await tester.enterText(find.byType(TextField).last, 'swarm');
      // Find's command row is its title alone, the match highlighted.
      final command = find.text('Swarm', findRichText: true);
      await walk.waitFor(command);
      FocusManager.instance.primaryFocus?.unfocus();
      await walk.shot('find');
      await tester.tap(command.last);
      await walk.waitFor(find.textContaining('River asks you'));
      await walk.shot('swarm-from-find');
    },
    skip: backend.isEmpty,
    timeout: const Timeout(Duration(minutes: 3)),
  );

  testWidgets(
    'Swarm on the phone, as the owner',
    (tester) async {
      final local = _LocalBackend.open(backend);
      addTearDown(local.close);
      final accountId = await local.accountId();
      final walk = _Walk(tester, binding, 'screens');

      final account = ValueNotifier<String?>(accountId);
      final features = ExperimentalFeaturesStore(storage: _Memory())
        ..value = {PhoneExperiment.swarm};
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: local.request,
        notices: SilentSystemNotices(),
        features: features,
      );
      addTearDown(host.dispose);

      await tester.pumpWidget(
        _phone(
          const SwarmPage(),
          scope: (child) => SwarmScope(notifier: host, child: child),
        ),
      );

      // ① What needs the person, across every Swarm, then the Swarms.
      await walk.waitFor(find.textContaining('River asks you'));
      await walk.waitFor(walk.keyStarting('swarm-project-'));
      await walk.shot('swarm');

      // ② A project: its project chat, Chat with PM at the top right, the
      // line under the header; the line opens its work by latest.
      await tester.tap(find.text('Mobile app').last);
      await walk.waitFor(walk.key('swarm-team-line'));
      await walk.shot('project');
      await tester.tap(walk.key('swarm-team-line'));
      await walk.waitFor(walk.key('swarm-team-close'));
      await walk.wait();
      await walk.shot('project-work');

      // ③ The chat the decision was asked in, over the sheet.
      await tester.tap(find.textContaining('Sign in with passkeys').last);
      await walk.waitFor(
        find.textContaining('One thing I cannot decide alone'),
      );
      await walk.shot('chat');

      // ④ Posting: @ picks an agent, the text names it, Send.
      await tester.tap(walk.key('swarm-mention'));
      await walk.waitFor(find.text('Nova'));
      await walk.shot('mention');
      await tester.tap(find.text('Nova').last);
      await walk.wait();
      const post = '@Nova flag it for the first week, then on for everyone.';
      await tester.enterText(find.byType(TextField), post);
      await walk.wait();
      await walk.shot('posting');
      await tester.tap(walk.key('swarm-send'));
      await walk.waitFor(find.text(post));
      await walk.wait(1000);
      FocusManager.instance.primaryFocus?.unfocus();
      await walk.shot('posted');

      // ⑤ The decision: one tap holds the answer with Undo, then it goes.
      const question =
          'Turn passkeys on for everyone, or behind a flag for the first week?';
      await tester.tap(walk.keyStarting('swarm-option-').first);
      await walk.waitFor(walk.keyStarting('swarm-undo-'));
      await walk.shot('decision-held');
      await walk.waitGone(find.text(question));
      await walk.wait(1500);
      await walk.shot('decision-answered');

      // ⑥ Back on the Swarm page, what still needs the person: the chat,
      // the sheet, then the project.
      tester.state<NavigatorState>(find.byType(Navigator))
        ..pop()
        ..pop()
        ..pop();
      await walk.wait(1500);
      await walk.shot('swarm-after');
    },
    skip: backend.isEmpty,
    timeout: const Timeout(Duration(minutes: 3)),
  );
}

/// The app's own theme, as `app_shell.dart` builds it, around [home].
Widget _phone(Widget home, {Widget Function(Widget child)? scope}) {
  final brightness = grid.AppTheme.palette.value.brightness;
  grid.AppTheme.brightness.value = brightness;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    builder: (context, child) {
      final themed = grid.BrightnessScope(child: child!);
      return scope == null ? themed : scope(themed);
    },
    home: home,
  );
}

/// The local backend recipe's server, as its fake owner.
class _LocalBackend {
  _LocalBackend._(this.base);

  factory _LocalBackend.open(String backend) {
    final base = Uri.parse(backend);
    if (base.scheme != 'http' || base.host != '127.0.0.1') {
      fail('A local review reads only a loopback backend: $backend');
    }
    return _LocalBackend._(base);
  }

  final Uri base;
  final _client = HttpClient();

  void close() => _client.close(force: true);

  Future<String> accountId() async {
    final me = await request('GET', '/api/auth/me') as Map;
    return (me['user'] as Map)['id'] as String;
  }

  /// One call: the backend's data, or its refusal as a [SuperTabFailure].
  Future<Object?> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final call = await _client.openUrl(method, base.resolve(path));
    call.headers
      ..set('authorization', 'Bearer local-owner-token')
      ..set('x-autonomous-env', 'prod');
    if (body != null) {
      call.headers.contentType = ContentType.json;
      call.write(jsonEncode(body));
    }
    final response = await call.close();
    final answer =
        jsonDecode(await response.transform(utf8.decoder).join()) as Map;
    if (answer['success'] != true) {
      final error = answer['error'] as Map? ?? const {};
      throw SuperTabFailure(
        error['code'] as String? ?? 'ERROR',
        error['message'] as String? ?? 'Failed.',
        statusCode: response.statusCode,
      );
    }
    return answer['data'];
  }
}

/// An account machine that never dials: it lists [_agents], and forwards the
/// phone's Swarm requests (`super_tabs`, `action: backend`) to [_backend] and
/// answers as the daemon does (cli/src/superTabs/service.ts): the value, or
/// the refusal's code, words and status. Everything else gets nothing.
class _ForwardingConn extends WsConn {
  _ForwardingConn(String machineId, this._agents, this._backend)
    : super(
        wsBaseUrl: 'ws://review.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<Map<String, dynamic>> _agents;
  final _LocalBackend _backend;

  @override
  bool get isReady => true;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<void> connect() async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agents_list') return {'agents': _agents};
    if (type != 'super_tabs' || payload['action'] != 'backend') return {};
    try {
      final value = await _backend.request(
        payload['method'] as String,
        payload['path'] as String,
        body: payload['body'] as Map<String, dynamic>?,
      );
      return {'ok': true, 'value': value};
    } on SuperTabFailure catch (failure) {
      return {
        'error': failure.code,
        'detail': failure.message,
        'status': failure.statusCode,
      };
    }
  }
}

/// A walk's waits and its numbered screenshots, `<name>-NN-<step>`.
class _Walk {
  _Walk(this.tester, this.binding, this.name);

  final WidgetTester tester;
  final IntegrationTestWidgetsFlutterBinding binding;
  final String name;
  var _step = 0;

  Future<void> wait([int ms = 600]) async {
    for (var elapsed = 0; elapsed < ms; elapsed += 100) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Future<void> shot(String step) async {
    // Past any page transition.
    await wait(900);
    _step++;
    await binding.takeScreenshot(
      '$name-${_step.toString().padLeft(2, '0')}-$step',
    );
  }

  Future<void> waitFor(Finder finder, {int seconds = 20}) async {
    for (var i = 0; i < seconds * 10; i++) {
      if (finder.evaluate().isNotEmpty) return;
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('never appeared: $finder');
  }

  Future<void> waitGone(Finder finder, {int seconds = 20}) async {
    for (var i = 0; i < seconds * 10; i++) {
      if (finder.evaluate().isEmpty) return;
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('never went: $finder');
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Finder keyStarting(String prefix) => find.byWidgetPredicate(
    (widget) =>
        widget.key is ValueKey<String> &&
        (widget.key! as ValueKey<String>).value.startsWith(prefix),
  );
}

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
