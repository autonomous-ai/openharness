import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

/// Swarm on the phone against an isolated local backend, a screenshot at each
/// step: what needs the person and the Swarms, a project, a conversation, a
/// post with a mention, and a decision answered with one tap and its Undo.
///
/// The backend is the local backend recipe's (in-memory MongoDB and Redis, a
/// fake SSO, no daemon), seeded with one Swarm whose open decision and tag are
/// for the owner. The phone reads it over plain HTTP instead of through an
/// account machine, so nothing here reaches a real account, machine or daemon:
/// it refuses any backend but 127.0.0.1 and knows only the recipe's fake owner
/// token. Without `SWARM_LOCAL_BACKEND` it skips.
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
    'Swarm on the phone, as the owner',
    (tester) async {
      final base = Uri.parse(backend);
      if (base.scheme != 'http' || base.host != '127.0.0.1') {
        fail('A local review reads only a loopback backend: $backend');
      }
      final client = HttpClient();
      addTearDown(() => client.close(force: true));

      // What the account machine forwards: the backend's answer, its data
      // unwrapped and its refusal as a SuperTabFailure.
      Future<Object?> request(
        String method,
        String path, {
        Map<String, dynamic>? body,
      }) async {
        final call = await client.openUrl(method, base.resolve(path));
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

      final me = await request('GET', '/api/auth/me') as Map;
      final accountId = (me['user'] as Map)['id'] as String;
      final account = ValueNotifier<String?>(accountId);
      final features = ExperimentalFeaturesStore(storage: _Memory())
        ..value = {PhoneExperiment.swarm};
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: request,
        notices: SilentSystemNotices(),
        features: features,
      );
      addTearDown(host.dispose);

      final brightness = grid.AppTheme.palette.value.brightness;
      grid.AppTheme.brightness.value = brightness;
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => SwarmScope(
            notifier: host,
            child: grid.BrightnessScope(child: child!),
          ),
          home: const SwarmPage(),
        ),
      );

      var step = 0;
      Future<void> wait([int ms = 600]) async {
        for (var elapsed = 0; elapsed < ms; elapsed += 100) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }

      Future<void> shot(String name) async {
        // Past any page transition.
        await wait(900);
        step++;
        await binding.takeScreenshot(
          '${step.toString().padLeft(2, '0')}-$name',
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

      // ① What needs the person, across every Swarm, then the Swarms.
      await waitFor(find.text('River asks you'));
      await waitFor(keyStarting('swarm-project-'));
      await shot('swarm');

      // ② A project: Chat with PM, the Lead, work by latest, the team line.
      await tester.tap(find.text('Mobile app').last);
      await waitFor(key('swarm-team-line'));
      await shot('project');

      // ③ The conversation the decision was asked in.
      await tester.tap(find.textContaining('Sign in with passkeys').last);
      await waitFor(find.textContaining('One thing I cannot decide alone'));
      await shot('conversation');

      // ④ Posting: @ picks an agent, the text names it, Send.
      await tester.tap(key('swarm-mention'));
      await waitFor(find.text('Nova'));
      await shot('mention');
      await tester.tap(find.text('Nova').last);
      await wait();
      await tester.enterText(
        find.byType(TextField),
        '@Nova flag it for the first week, then on for everyone.',
      );
      await wait();
      await shot('posting');
      await tester.tap(key('swarm-send'));
      await waitFor(
        find.text('@Nova flag it for the first week, then on for everyone.'),
      );
      await wait(1000);
      FocusManager.instance.primaryFocus?.unfocus();
      await shot('posted');

      // ⑤ The decision: one tap holds the answer with Undo, then it goes.
      const question =
          'Turn passkeys on for everyone, or behind a flag for the first week?';
      await tester.tap(keyStarting('swarm-option-').first);
      await waitFor(keyStarting('swarm-undo-'));
      await shot('decision-held');
      await waitGone(find.text(question));
      await wait(1500);
      await shot('decision-answered');

      // ⑥ Back on the Swarm page, what still needs the person.
      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      navigator
        ..pop()
        ..pop();
      await wait(1500);
      await shot('swarm-after');
    },
    skip: backend.isEmpty,
    timeout: const Timeout(Duration(minutes: 3)),
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
