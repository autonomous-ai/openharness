import '../terminal/terminal_viewport.dart';
import 'terminal_pane.dart';

/// One intentional attention detour, held only in this window's memory.
/// Keeping pane identity prevents a replaced/closed tile becoming a return
/// destination; the reading anchor lives in its retained terminal renderer.
class DeviceVisit {
  DeviceVisit({
    required this.id,
    required this.connectionMachineId,
    required this.originSwarm,
    required this.origin,
    required this.label,
    required this.bookmark,
  }) : originMachine = origin.machineId,
       originAgent = origin.agentId;
  final String id, connectionMachineId, originSwarm, label, originMachine;
  final String? originAgent;
  final TerminalPane origin;
  final TerminalReadingBookmark bookmark;
  String? visitingSwarm, visitingMachine, visitingAgent;
  TerminalPane? visiting;
  void dispose() => bookmark.dispose();
}
