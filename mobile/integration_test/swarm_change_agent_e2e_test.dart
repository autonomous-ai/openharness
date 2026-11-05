import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/main.dart' as app;
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

/// Change agent on a Swarm Product Manager's pane, end to end on a real
/// phone: the real app, signed in to its owner's account, switching a PM that
/// runs on one of the account's own computers to another engine, then back.
///
/// It WRITES: the PM's machine saves and stops the PM's agent and starts the
/// other engine in its place, twice. Run it only on a test project's PM, on
/// the owner's own phone, when they ask for it. Opt-in with
/// `SWARM_CHANGE_AGENT_E2E=true`; it skips otherwise, so no CI or simulator
/// run reaches a real account.
///
///     flutter drive -d <phone> --keep-app-running \
///       --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_change_agent_e2e_test.dart \
///       --dart-define=SWARM_CHANGE_AGENT_E2E=true \
///       --dart-define=SWARM_E2E_PM_AGENT=<the PM's harness id> \
///       [--dart-define=SWARM_E2E_TO_ENGINE=codex] \
///       [--dart-define=SWARM_E2E_SWITCH_BACK=false]
///
/// Each switch must end on a running agent of the chosen engine, in the same
/// folder, with the old one stopped and no refusal said: before the PM's
/// machine knew the switch (`agent_close` naming its `changeId`), it refused
/// a PM's close with LEAD_PROTECTED. Then the terminal's menu names the new
/// engine on its Change agent row. `--keep-app-running` always: without it
/// `flutter drive` uninstalls the app (`integration_test/README.md`).
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const run = bool.fromEnvironment('SWARM_CHANGE_AGENT_E2E');
  const pmAgent = String.fromEnvironment('SWARM_E2E_PM_AGENT');
  const toEngine = String.fromEnvironment(
    'SWARM_E2E_TO_ENGINE',
    defaultValue: 'codex',
  );
  const switchBack = bool.fromEnvironment(
    'SWARM_E2E_SWITCH_BACK',
    defaultValue: true,
  );

  testWidgets(
    'Change agent on a Swarm PM, for its signed-in owner',
    (tester) async {
      expect(pmAgent, isNotEmpty, reason: 'Name the PM: SWARM_E2E_PM_AGENT');
      var step = 0;
      Future<void> wait([int ms = 600]) async {
        for (var elapsed = 0; elapsed < ms; elapsed += 100) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }

      Future<void> shot(String name) async {
        // Past any page or sheet transition.
        await wait(900);
        step++;
        await binding.takeScreenshot(
          'change-agent-${step.toString().padLeft(2, '0')}-$name',
        );
      }

      Future<void> waitFor(Finder finder, {int seconds = 30}) async {
        for (var i = 0; i < seconds * 10; i++) {
          if (finder.evaluate().isNotEmpty) return;
          await tester.pump(const Duration(milliseconds: 100));
        }
        await shot('never-appeared');
        fail('never appeared: $finder');
      }

      Finder key(String value) => find.byKey(ValueKey(value));

      await app.main();
      // The signed-in shell, whatever its home shows; or the welcome, which
      // this run cannot pass.
      final shell = find.byType(PhoneShell);
      for (var i = 0; i < 900 && shell.evaluate().isEmpty; i++) {
        if (find.text(OnboardingCopy.welcome).evaluate().isNotEmpty) {
          fail('Sign in on the phone first, then run this again.');
        }
        await tester.pump(const Duration(milliseconds: 100));
      }
      if (shell.evaluate().isEmpty) {
        await shot('no-shell');
        fail('the signed-in shell never appeared');
      }
      final notifier = tester.widget<PhoneShell>(shell).notifier;

      /// The machine that runs [agentId] and the agent as it reads now.
      (String, Agent)? locate(String agentId) {
        for (final MapEntry(key: machineId, value: machine)
            in notifier.machineStates.entries) {
          for (final agent in machine.agents) {
            if (agent.id == agentId) return (machineId, agent);
          }
        }
        return null;
      }

      // The PM, once its machine has listed its agents.
      (String, Agent)? found;
      for (var i = 0; i < 900 && found == null; i++) {
        found = locate(pmAgent);
        if (found == null) await tester.pump(const Duration(milliseconds: 100));
      }
      await shot('home');
      expect(found, isNotNull, reason: 'the PM $pmAgent on a linked machine');
      final machineId = found!.$1;
      final firstEngine = found.$2.engine!;
      expect(
        AppNotifier.canChangeAgent(found.$2),
        isTrue,
        reason: 'Change agent is offered on the PM',
      );
      debugPrint('[change-agent] PM $pmAgent on $machineId runs $firstEngine');

      // Its terminal, as the project team's Open terminal opens it.
      tester
          .widget<PhoneShellScope>(find.byType(PhoneShellScope).first)
          .onOpenAgent(machineId, pmAgent);
      await waitFor(key('terminal-title'), seconds: 60);
      await wait(3000);
      await shot('pm-terminal');

      /// Change agent from the terminal's menu to [engine], chosen by its
      /// [title] in the picker; returns the agent that took over.
      Future<String> change(
        String fromId,
        String engine,
        String title,
        String label,
      ) async {
        final before = {
          for (final agent
              in notifier.machineStates[machineId]?.agents ?? const <Agent>[])
            agent.id,
        };
        await tester.tap(key('terminal-title'));
        await waitFor(find.text('Change agent'));
        await shot('menu-before-$engine');
        await tester.tap(find.text('Change agent'));
        await waitFor(find.text(title));
        await shot('picker-$engine');
        await tester.tap(find.text(title).last);
        final started = DateTime.now();
        String? said;
        String? next;
        // Saving and stopping the old agent, then starting the new one.
        for (var i = 0; i < 3000 && next == null; i++) {
          await tester.pump(const Duration(milliseconds: 100));
          final snack = find.descendant(
            of: find.byType(SnackBar),
            matching: find.byType(Text),
          );
          if (snack.evaluate().isNotEmpty) {
            final text = tester.widget<Text>(snack.first).data;
            if (text != null && text != said) {
              said = text;
              debugPrint('[change-agent] said: $text');
            }
          }
          final old = locate(fromId)?.$2;
          for (final agent
              in notifier.machineStates[machineId]?.agents ?? const <Agent>[]) {
            if (!before.contains(agent.id) &&
                agent.engine == engine &&
                !agent.isStopped &&
                (old == null || old.isStopped)) {
              next = agent.id;
            }
          }
        }
        if (next == null) {
          await shot('switch-failed-$engine');
          fail('no running $engine agent took over; said: $said');
        }
        debugPrint(
          '[change-agent] $fromId → $next ($engine) in '
          '${DateTime.now().difference(started).inSeconds} s; said: $said',
        );
        expect(
          said,
          anyOf(
            isNull,
            isNot(
              anyOf(
                contains('Product Manager of a Swarm project'),
                contains('already switching'),
                contains('Could not'),
              ),
            ),
          ),
          reason: 'no refusal',
        );
        // The new agent's own page, its menu naming the new engine.
        await waitFor(key('terminal-title'), seconds: 60);
        await wait(4000);
        await shot('after-$engine');
        await tester.tap(key('terminal-title'));
        await waitFor(find.text('Change agent'));
        expect(
          find.textContaining(label),
          findsWidgets,
          reason: 'the Change agent row names $label',
        );
        await shot('menu-after-$engine');
        // Closed again by a tap above it, as the person would.
        await tester.tapAt(const Offset(20, 120));
        await wait(1200);
        return next;
      }

      // The picker's titles and the menu row's value, as terminal_page.dart
      // writes them.
      String titleOf(String engine) =>
          engine == 'claude' ? 'Claude Code' : engineIdentity(engine).label;
      String labelOf(String engine) => engineIdentity(engine).label;

      final switched = await change(
        pmAgent,
        toEngine,
        titleOf(toEngine),
        labelOf(toEngine),
      );
      if (!switchBack || firstEngine == toEngine) return;
      await change(
        switched,
        firstEngine,
        titleOf(firstEngine),
        labelOf(firstEngine),
      );
    },
    skip: !run,
    timeout: const Timeout(Duration(minutes: 15)),
  );
}
