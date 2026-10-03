import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_monitor_controller.dart';

import 'model_manager.dart';

class MonitorConnection extends ModelManagerConnection {
  List<Map<String, dynamic>>? inventory;
  int inventoryReads = 0;
  final closes = <Map<String, dynamic>>[];
  @override
  Future<void> waitUntilReady({
    Duration timeout = const Duration(seconds: 10),
  }) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_close') {
      closes.add(Map.of(payload));
      throw StateError('The monitor machine is unavailable.');
    }
    if (type == 'agents_list' && inventory != null) {
      inventoryReads++;
      return {'agents': inventory};
    }
    final result = await super.request(
      type,
      payload: payload,
      timeout: timeout,
    );
    if (result['agent'] case final Map<String, dynamic> agent
        when agent['dsh'] == harnessMonitorId) {
      return {
        ...result,
        'agent': {
          ...agent,
          'engine': 'opencode',
          'closeSupported': true,
          'createdAt': '2026-10-01T12:00:00.000Z',
          'viewerUrl': 'http://127.0.0.1:4179/',
          'viewerName': harnessMonitorName,
        },
      };
    }
    return result;
  }
}

class MonitorTestApp extends ModelManagerTestApp {
  MonitorTestApp(MonitorConnection super.connection);
  void Function(String machineId, String agentId)? onReopen;

  @override
  Future<RestartAgentResult> resumeAgent(
    String machineId,
    String agentId,
  ) async {
    final result = await super.resumeAgent(machineId, agentId);
    if (result.error == null) onReopen?.call(machineId, agentId);
    return result;
  }

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {
    await probeReply?.future;
    if (probeError != null) throw StateError(probeError!);
    stateOf(machineId)!.dsh.replace([
      DshEntry(
        id: harnessMonitorId,
        name: harnessMonitorName,
        engine: 'opencode',
        description: '',
        installed: installed,
      ),
    ]);
  }
}
