import 'package:flutter/foundation.dart';

import '../ws/ws_conn.dart';
import 'shared_tabs.dart'
    show SharedTabsFailure, SharedTabsRequest, unreachableComputer;

enum TabHarnessState { working, idle, unknown }

/// One harness of a desk tab as this computer's daemon reports it.
@immutable
class TabHarnessActivity {
  const TabHarnessActivity({
    required this.machineId,
    required this.agentId,
    required this.state,
    this.summary,
    this.away = false,
  });

  final String machineId, agentId;
  final TabHarnessState state;

  /// One line on what it does, already cut and cleaned by the daemon; plain
  /// text that may come from another account.
  final String? summary;

  /// Its computer did not answer: the row waits, it is not known.
  final bool away;

  static TabHarnessActivity? fromJson(Object? json) {
    if (json is! Map) return null;
    final machineId = json['machineId'], agentId = json['agentId'];
    if (machineId is! String || machineId.isEmpty) return null;
    if (agentId is! String || agentId.isEmpty) return null;
    final summary = json['summary'];
    return TabHarnessActivity(
      machineId: machineId,
      agentId: agentId,
      state: switch (json['state']) {
        'working' => TabHarnessState.working,
        'idle' => TabHarnessState.idle,
        _ => TabHarnessState.unknown,
      },
      summary: summary is String && summary.isNotEmpty ? summary : null,
      away: json['away'] == true,
    );
  }
}

/// `tab_activity` on this computer's daemon: every harness of a desk tab, shared
/// or not, with what it does now.
class TabActivityReader {
  TabActivityReader({required this.request});

  final SharedTabsRequest request;

  /// Throws [SharedTabsFailure] with the daemon's code (`NOT_A_TAB` for a tab
  /// just made: ask again later) or `UNAVAILABLE` when it was not reached.
  Future<List<TabHarnessActivity>> read(String tabId) async {
    final Map<String, dynamic> answer;
    try {
      answer = await request({'action': 'tab_activity', 'tabId': tabId});
    } on WsRequestFailure catch (e) {
      final detail = e.detail;
      throw SharedTabsFailure(
        e.code,
        detail == null || detail.isEmpty ? e.code : detail,
      );
    } catch (_) {
      throw SharedTabsFailure('UNAVAILABLE', unreachableComputer);
    }
    final rows = answer['harnesses'];
    if (rows is! List) return const [];
    return [for (final row in rows) ?TabHarnessActivity.fromJson(row)];
  }
}
