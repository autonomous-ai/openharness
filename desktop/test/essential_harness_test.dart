import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/essential_harness_controller.dart';
import 'package:harness/state/harness_monitor_controller.dart';

import 'support/harness_monitor.dart';

/// The monitor's fixtures, with Memories in the catalog and its agent given a viewer.
class _Connection extends MonitorConnection {
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final result = await super.request(
      type,
      payload: payload,
      timeout: timeout,
    );
    if (result['agent'] case final Map<String, dynamic> agent
        when agent['dsh'] == memoriesEssential.id) {
      return {
        ...result,
        'agent': {
          ...agent,
          'engine': 'opencode',
          'viewerUrl': 'http://127.0.0.1:4180/',
          'viewerName': memoriesEssential.name,
        },
      };
    }
    return result;
  }
}

class _App extends MonitorTestApp {
  _App(super.connection);

  /// What the machine's catalog says the package runs on: an older CLI says Claude Code for Memories.
  String listedEngine = 'opencode';

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {
    stateOf(machineId)!.dsh.replace([
      for (final essential in storeEssentials)
        DshEntry(
          id: essential.id,
          name: essential.name,
          engine: listedEngine,
          category: 'Essentials',
          description: '',
          installed: installed,
        ),
    ]);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Connection connection;
  late _App app;
  setUp(() {
    connection = _Connection();
    app = _App(connection);
  });
  tearDown(() => app.dispose());

  test('Memories: one click creates it on OpenCode, asked to build About You, in a tab of its own; the next opens it', () async {
    final memories = app.essential(memoriesEssential.id)!;
    expect(memories.exists, isFalse);
    expect(await memories.open(), isNull);
    final created = connection.creations.single;
    expect(created['dsh'], memoriesEssential.id);
    expect(created['engine'], 'opencode');
    expect(created['name'], 'Memories');
    expect(created['prompt'], 'Build my About You.');
    expect(app.activeSwarm.name, 'Memories');
    expect(app.panes.map((p) => p.isWeb), [true, false]);
    expect(app.focusedPane, app.panes.firstWhere((p) => p.isWeb));
    expect(memories.exists, isTrue);
    final tab = app.activeSwarmId, tabs = app.swarms.length;
    app.newSwarm(name: 'Elsewhere');
    expect(await memories.open(), isNull);
    expect(app.activeSwarmId, tab);
    expect(app.swarms, hasLength(tabs + 1));
    expect(connection.creations, hasLength(1));
  });

  test('only the Essentials have a one-click opener, one each; the footer shares the monitor\'s', () {
    expect(app.essential('autonomous/blender'), isNull);
    expect(
      identical(app.essential(harnessMonitorId), app.harnessMonitor),
      isTrue,
    );
    expect(
      identical(
        app.essential(memoriesEssential.id),
        app.essential(memoriesEssential.id),
      ),
      isTrue,
    );
    expect(essentialFor(memoriesEssential.id), memoriesEssential);
    expect(harnessMonitorEssential.firstTask, isNull);
  });

  test(
    'a failed install or create is said, and nothing is left half made',
    () async {
      app.installed = false;
      app.installError = 'Install failed.';
      expect(
        await app.essential(memoriesEssential.id)!.open(),
        'Install failed.',
      );
      expect(connection.creations, isEmpty);
      expect(app.essential(memoriesEssential.id)!.exists, isFalse);
    },
  );

  test('a CLI older than the Essentials keeps Memories on the engine it lists, and nothing is asked on it', () async {
    app.listedEngine = 'claude';
    expect(await app.essential(memoriesEssential.id)!.open(), isNull);
    expect(connection.creations.single['engine'], 'claude');
    expect(connection.creations.single['prompt'], isNull);
  });

  test('Open means a click opens: one on another machine, in no tab, is not the one a click would reach', () {
    final memories = app.essential(memoriesEssential.id)!;
    app.stateOf('other')!.agents = [
      Agent(
        id: 'elsewhere',
        name: 'Memories',
        engine: 'opencode',
        dsh: memoriesEssential.id,
      ),
    ];
    expect(memories.exists, isFalse);
    app.stateOf('m')!.agents = [
      Agent(
        id: 'here',
        name: 'Memories',
        engine: 'opencode',
        dsh: memoriesEssential.id,
      ),
    ];
    expect(memories.exists, isTrue);
  });
}
