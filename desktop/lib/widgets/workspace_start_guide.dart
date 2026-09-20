import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import 'box_chrome.dart';

/// A quiet, live keyboard map for an empty workspace. The drawing illustrates
/// tabs and panes. Only the full shortcuts link is interactive.
class WorkspaceStartGuide extends StatelessWidget {
  const WorkspaceStartGuide({super.key, required this.onShortcuts});

  final VoidCallback onShortcuts;

  String _hint(BuildContext context, String command) =>
      KeymapTheme.of(context)?.hint(command) ??
      (KeymapTheme.of(context) == null
          ? harnessDefaultKeymap
                .bindingsFor(KeymapContext.workspace)
                .where((binding) => binding.command == command)
                .map(describeKeyBinding)
                .firstOrNull
          : null) ??
      '';

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ink = grid.AppTheme.palette.value.foreground;
    final faint = ink.withValues(alpha: .62);
    final accent = grid.AppPalette.swarmAccent;
    final stroke = faint.withValues(alpha: .30);
    return Material(
      color: grid.AppPalette.swarmField,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final scale = MediaQuery.textScalerOf(context).scale(13) / 13;
          final compact = constraints.maxWidth < 680 * scale;
          Widget callout(String command, String label, String explanation) =>
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text.rich(
                      TextSpan(
                        children: [
                          if (_hint(context, command).isNotEmpty)
                            TextSpan(
                              text: '${_hint(context, command)}  ',
                              style: TextStyle(color: accent),
                            ),
                          TextSpan(text: label),
                        ],
                      ),
                      style: boxMonoStyle(size: 13, color: ink),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      explanation,
                      style: boxMonoStyle(size: 12, color: faint),
                    ),
                  ],
                ),
              );
          final diagram = Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Flexible(
                    child: callout(
                      'swarm.new',
                      'New Tab',
                      'A tab holds your panes.',
                    ),
                  ),
                  Flexible(
                    child: callout(
                      'app.store',
                      'Harness Store',
                      'Tools for new kinds of work.',
                    ),
                  ),
                ],
              ),
              SizedBox(
                height: 24,
                width: double.infinity,
                child: CustomPaint(painter: _GuideArrows(stroke, top: true)),
              ),
              ExcludeSemantics(
                child: Container(
                  decoration: BoxDecoration(border: Border.all(color: stroke)),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        decoration: BoxDecoration(
                          border: Border(bottom: BorderSide(color: stroke)),
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 12,
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Row(
                                children: [
                                  Flexible(
                                    child: Text(
                                      'payments',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: boxMonoStyle(
                                        size: 12,
                                        color: faint,
                                      ),
                                    ),
                                  ),
                                  if (!compact) ...[
                                    const SizedBox(width: 32),
                                    Text(
                                      'research',
                                      style: boxMonoStyle(
                                        size: 12,
                                        color: faint,
                                      ),
                                    ),
                                  ],
                                  const SizedBox(width: 20),
                                  Text(
                                    '+',
                                    style: boxMonoStyle(size: 14, color: faint),
                                  ),
                                ],
                              ),
                            ),
                            Text(
                              compact ? 'Store' : 'Harness Store',
                              style: boxMonoStyle(size: 12, color: faint),
                            ),
                          ],
                        ),
                      ),
                      SizedBox(
                        height: (constraints.maxHeight - 300 * scale).clamp(
                          240 * scale,
                          540 * scale,
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: _DrawnPane(
                                name: 'Codex',
                                task: 'Review the API changes',
                                ink: ink,
                                faint: faint,
                                accent: accent,
                              ),
                            ),
                            VerticalDivider(
                              width: 1,
                              thickness: 1,
                              color: stroke,
                            ),
                            Expanded(
                              child: Column(
                                children: [
                                  Expanded(
                                    child: _DrawnPane(
                                      name: 'Claude Code',
                                      task: 'Write regression tests',
                                      ink: ink,
                                      faint: faint,
                                      accent: accent,
                                    ),
                                  ),
                                  Divider(
                                    height: 1,
                                    thickness: 1,
                                    color: stroke,
                                  ),
                                  Expanded(
                                    child: _DrawnPane(
                                      name: 'Grok',
                                      task: 'Explore edge cases',
                                      ink: ink,
                                      faint: faint,
                                      accent: accent,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              SizedBox(
                height: 28,
                width: double.infinity,
                child: CustomPaint(painter: _GuideArrows(stroke)),
              ),
              Align(
                alignment: const Alignment(.5, 0),
                child: callout(
                  'agent.add',
                  'New Pane',
                  'Each pane runs a harness.',
                ),
              ),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  key: const ValueKey('workspace-all-shortcuts'),
                  onPressed: onShortcuts,
                  style: TextButton.styleFrom(foregroundColor: faint),
                  child: Text(
                    '${_hint(context, 'keyboard.help')}  All Keyboard Shortcuts'
                        .trimLeft(),
                    style: boxMonoStyle(size: 11, color: faint),
                  ),
                ),
              ),
            ],
          );
          return SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: Center(
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: constraints.maxWidth * (compact ? 1 : .92),
                  ),
                  child: Padding(
                    padding: EdgeInsets.symmetric(
                      horizontal: compact ? 16 : 24,
                      vertical: 20,
                    ),
                    child: diagram,
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _DrawnPane extends StatelessWidget {
  const _DrawnPane({
    required this.name,
    required this.task,
    required this.ink,
    required this.faint,
    required this.accent,
  });
  final String name, task;
  final Color ink, faint, accent;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(16),
    child: Align(
      alignment: Alignment.topLeft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: boxMonoStyle(size: 14, color: ink),
          ),
          const SizedBox(height: 6),
          Text(
            'This Mac:~/work/payments',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: boxMonoStyle(size: 11, color: faint),
          ),
          const SizedBox(height: 18),
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: '› ',
                  style: TextStyle(color: accent),
                ),
                TextSpan(text: '$task ▏'),
              ],
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: boxMonoStyle(size: 12, color: ink),
          ),
        ],
      ),
    ),
  );
}

class _GuideArrows extends CustomPainter {
  const _GuideArrows(this.color, {this.top = false});
  final Color color;
  final bool top;
  @override
  void paint(Canvas canvas, Size size) {
    final pen = Paint()
      ..color = color
      ..strokeWidth = 1;
    void arrow(double x, {required bool down}) {
      final tip = Offset(x, down ? size.height - 2 : 2);
      canvas.drawLine(Offset(x, down ? 0 : size.height), tip, pen);
      for (final side in [-1, 1]) {
        canvas.drawLine(tip, tip + Offset(4.0 * side, down ? -5 : 5), pen);
      }
    }

    if (top) {
      arrow(56, down: true);
      arrow(size.width - 56, down: true);
    } else {
      arrow(size.width * .75, down: false);
    }
  }

  @override
  bool shouldRepaint(_GuideArrows old) => old.color != color || old.top != top;
}
