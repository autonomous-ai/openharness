// New Harness lists the same rows as the pane picker (grid-reads-without-waking, issue 03). Every
// read now asks for row state, so the daemon labels a row whose computers seem offline with
// `unavailable` rather than folding the label into its node — and New Harness still says so, in the
// daemon's own words for a client that does not ask: the computer as the Machines list names it
// ("Studio"), which is not the node ("studio").
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';

import 'support/mixed_agents.dart';
import 'support/resting_models.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<List<String>> details(Map<String, dynamic> reply) async {
    final daemon = RecordingDaemon({
      ...reply,
      'localModelEngines': ['codex'],
    });
    final app = createApp(connectionForTest: (_) => daemon);
    addTearDown(app.dispose);
    seedMixedAgents(app);
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/scene',
    );
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.model);
    await box.refreshModels();
    return box.options
        .where((option) => option.model != null)
        .map((option) => option.detail)
        .toList();
  }

  test('a row whose computers seem offline still says so', () async {
    expect(
      await details(
        modelsReply([
          section(
            'home',
            own: true,
            models: [
              row('Qwen3.5-4B', 'macbook'),
              row('LFM2.5-8B', 'studio', offlineMachine: 'Studio'),
            ],
          ),
        ]),
      ),
      ['macbook', 'Studio · seems offline'],
    );
  });

  test(
    'an older daemon that folded the label into the node reads as before',
    () async {
      expect(
        await details(
          modelsReply([
            section(
              'home',
              own: true,
              models: [
                row('Qwen3.5-4B', 'macbook'),
                // What the daemon sends a client that did not ask for row state, for the
                // row above.
                row('LFM2.5-8B', 'Studio · seems offline'),
              ],
            ),
          ]),
        ),
        ['macbook', 'Studio · seems offline'],
      );
    },
  );
}
