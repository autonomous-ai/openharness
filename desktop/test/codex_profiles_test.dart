import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('requires explicit CLI capability, never infers it from the installed binary', () {
    expect(
      EngineAvailability.fromJson({'engine': 'codex', 'installed': true})
          ?.supportsCodexHome,
      isFalse,
    );
    expect(
      EngineAvailability.fromJson({
        'engine': 'codex',
        'supportsCodexHome': true,
      })?.supportsCodexHome,
      isTrue,
    );
    expect(
      EngineAvailability.fromJson({
        'engine': 'claude',
        'supportsCodexHome': true,
      })?.supportsCodexHome,
      isFalse,
    );
  });

  test('refuses an explicit profile for a missing capability or a non-Codex engine, never merely for being remote', () async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(notifier.dispose);
    // A remote machine on purpose: discovery/linking now run on the CLI wherever it is, so
    // choosing a profile must not be refused merely because this machine is not "this computer".
    final machine = MachineState(
      const Machine(machineId: 'remote', authMode: MachineAuthMode.remote),
    )..localOnly = false;
    notifier.machineStates['remote'] = machine;
    expect(
      await notifier.createAgent(
        'remote',
        engine: 'codex',
        folder: '/work',
        codexHome: '/accounts/two',
      ),
      contains('Update the harness CLI'),
    );
    machine.engines.replace(const [
      EngineAvailability(
        engine: 'codex',
        installed: true,
        supportsCodexHome: true,
      ),
    ]);
    expect(
      await notifier.createAgent(
        'remote',
        engine: 'claude',
        folder: '/work',
        codexHome: '/accounts/two',
      ),
      contains('only for Codex'),
    );
  });

  test('keeps a full profile path through agent updates and rename', () {
    final path = '/accounts/${'long-name-' * 15}/codex-two';
    final agent = Agent.fromJson({
      'id': 'one',
      'engine': 'codex',
      'codexHome': path,
    });
    expect(agent.codexHome, path);
    expect(agent.copyWith(name: 'renamed').codexHome, path);
    final changed = Agent.fromJson({
      'id': 'one',
      'engine': 'codex',
      'codexHome': '/accounts/other',
    });
    expect(AppNotifier.agentsEqual([agent], [changed]), isFalse);
    expect(
      Agent.fromJson({'id': 'one', 'engine': 'claude', 'codexHome': path})
          .codexHome,
      isNull,
    );
  });

  // #4183: an agent on a Windows machine has a `C:\…` profile folder; a check that wanted a leading '/' dropped it, so
  // the agent showed on the default account. The Desktop may run on another platform, so both spellings are kept.
  test('keeps a Windows profile path and drops one that is not absolute', () {
    const codex = r'C:\Users\me\.codex-work';
    const claude = r'C:\Users\me\.claude-work';
    expect(
      Agent.fromJson({'id': 'w', 'engine': 'codex', 'codexHome': codex})
          .codexHome,
      codex,
    );
    expect(
      Agent.fromJson({'id': 'w', 'engine': 'claude', 'claudeHome': claude})
          .claudeHome,
      claude,
    );
    for (final home in [r'relative\.codex', r'\\server\share\.codex', 'C:']) {
      expect(
        Agent.fromJson({'id': 'w', 'engine': 'codex', 'codexHome': home})
            .codexHome,
        isNull,
      );
    }
  });
}
