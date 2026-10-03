// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart' show ConnectionStatus;
import '../state/app_state.dart';
import '../state/attention_state.dart';
import 'fleet_graph.dart';
import 'neon.dart';

/// The fleet as [FleetGraph] reads it, built from the machines this window knows and the
/// local daemon's attention frame. A machine's agents take their state from the frame; an agent the
/// frame does not cover (another machine's, until that daemon's frame is relayed) reads idle when
/// its machine is connected and offline when not, which is all this window can honestly say.
List<FleetMachine> fleetFrom(AppNotifier app) {
  final attention = app.attention;
  final seen = <String>{};
  final out = <FleetMachine>[];
  for (final m in app.machines) {
    final st = app.stateOf(m.machineId);
    if (st == null) continue;
    final connected = st.connectionStatus == ConnectionStatus.connected;
    final agents = <FleetAgent>[];
    for (final a in st.agents) {
      final row = attention.of(a.id);
      seen.add(a.id);
      agents.add(FleetAgent(
        id: a.id,
        name: row?.name.isNotEmpty == true ? row!.name : a.name,
        state: row?.state ?? (connected ? AgentAttention.idle : AgentAttention.offline),
        lane: row?.lane,
        spendFraction: row?.spendFraction,
      ));
    }
    out.add(FleetMachine(id: m.machineId, name: m.displayName, connected: connected, local: st.isLocalMachine, agents: agents));
  }
  // Rows the frame carries that no machine lists yet (a session starting up) go on the local machine.
  final orphans = [for (final r in attention.rows) if (!seen.contains(r.agentId)) FleetAgent(id: r.agentId, name: r.name.isEmpty ? r.agentId : r.name, state: r.state, lane: r.lane, spendFraction: r.spendFraction)];
  if (orphans.isNotEmpty) {
    final i = out.indexWhere((m) => m.local);
    if (i >= 0) {
      final m = out[i];
      out[i] = FleetMachine(id: m.id, name: m.name, connected: m.connected, local: true, agents: [...m.agents, ...orphans]);
    } else {
      out.add(FleetMachine(id: 'local', name: attention.hostname.isEmpty ? 'this machine' : attention.hostname, connected: true, local: true, agents: orphans));
    }
  }
  return out;
}

/// Hosts the fleet overview above the workspace. Opened from the command bar ("Fleet overview") or
/// Ctrl+Shift+G; Escape, the close button or a click outside the panel closes it. The panel is a
/// fixed size inside the window: nothing in it scrolls (motion never moves the layout).
class FleetOverviewHost extends StatelessWidget {
  const FleetOverviewHost({super.key, required this.app, required this.child});

  final AppNotifier app;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyG, control: true, shift: true): () => app.fleetOverviewOpen.value = !app.fleetOverviewOpen.value,
      },
      child: Stack(
        fit: StackFit.expand,
        children: [
          child,
          ValueListenableBuilder<bool>(
            valueListenable: app.fleetOverviewOpen,
            builder: (context, open, _) => open ? _FleetPanel(app: app) : const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }
}

class _FleetPanel extends StatelessWidget {
  const _FleetPanel({required this.app});
  final AppNotifier app;

  void _close() => app.fleetOverviewOpen.value = false;

  @override
  Widget build(BuildContext context) {
    final neon = Neon.current();
    return CallbackShortcuts(
      bindings: {const SingleActivator(LogicalKeyboardKey.escape): _close},
      child: Focus(
        autofocus: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: _close,
          child: ColoredBox(
            color: Colors.black.withValues(alpha: 0.55),
            child: Center(
              child: GestureDetector(
                onTap: () {}, // clicks inside the panel stay inside
                child: FractionallySizedBox(
                  widthFactor: 0.78,
                  heightFactor: 0.78,
                  child: CustomPaint(
                    foregroundPainter: _ChamferFrame(neon.accent),
                    child: ClipPath(
                      clipper: _ChamferClip(),
                      child: ColoredBox(
                        color: neon.background,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Padding(
                              padding: const EdgeInsets.fromLTRB(16, 10, 6, 0),
                              child: Row(
                                children: [
                                  Text('FLEET', style: TextStyle(fontFamily: 'monospace', fontSize: 12, letterSpacing: 3, fontWeight: FontWeight.w700, color: neon.accent)),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Text('machines, their agents and what each needs; click an agent to open it',
                                        maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: neon.foreground.withValues(alpha: 0.55))),
                                  ),
                                  IconButton(tooltip: 'Close (Esc)', icon: const Icon(Icons.close, size: 16), color: neon.foreground, onPressed: _close),
                                ],
                              ),
                            ),
                            Expanded(
                              child: ListenableBuilder(
                                listenable: Listenable.merge([app, app.attention]),
                                builder: (context, _) => FleetGraph(
                                  machines: fleetFrom(app),
                                  hubLabel: 'this window',
                                  onAgentTap: (agentId) {
                                    final m = fleetFrom(app).where((m) => m.agents.any((a) => a.id == agentId)).firstOrNull;
                                    _close();
                                    if (m != null && m.id != 'local') app.openAgentFromDial(m.id, agentId, intent: AttachIntent.person);
                                  },
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ChamferClip extends CustomClipper<Path> {
  @override
  Path getClip(Size size) => chamferPath(Offset.zero & size, 18);
  @override
  bool shouldReclip(_ChamferClip old) => false;
}

class _ChamferFrame extends CustomPainter {
  const _ChamferFrame(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final p = chamferPath((Offset.zero & size).deflate(0.75), 18);
    canvas.drawPath(p, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 6
      ..color = color.withValues(alpha: 0.25)
      ..maskFilter = const MaskFilter.blur(BlurStyle.outer, 12));
    canvas.drawPath(p, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..color = color);
  }

  @override
  bool shouldRepaint(_ChamferFrame old) => old.color != color;
}
