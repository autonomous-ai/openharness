import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'engine_identity.dart';
import 'swarm_icon.dart';

/// A static example of the workspace. It never creates or contacts an agent.
class WelcomeWorkspacePreview extends StatelessWidget {
  const WelcomeWorkspacePreview({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final palette = grid.AppTheme.palette.value;
    return Semantics(
      image: true,
      label: 'Example harness group: Claude Code and Codex working side by side.',
      child: ExcludeSemantics(
        child: Container(
          decoration: BoxDecoration(
            color: palette.workspace,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: Colors.white12),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                color: palette.tabBar,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                child: const Row(
                  children: [
                    SwarmIcon(size: 14, color: Colors.white70),
                    SizedBox(width: 8),
                    Text(
                      'Your project',
                      style: TextStyle(fontSize: 12, color: Colors.white),
                    ),
                    Spacer(),
                    Text(
                      '2 harnesses',
                      style: TextStyle(fontSize: 11, color: Colors.white70),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(8),
                child: Row(
                  children: [
                    Expanded(
                      child: _AgentExample(
                        engine: 'claude',
                        title: 'Claude Code',
                        task: 'Build the feature',
                        color: palette.background,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _AgentExample(
                        engine: 'codex',
                        title: 'Codex',
                        task: 'Review the changes',
                        color: palette.background,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AgentExample extends StatelessWidget {
  const _AgentExample({
    required this.engine,
    required this.title,
    required this.task,
    required this.color,
  });
  final String engine, title, task;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(6),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            EngineMark(engine: engine, size: 17),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                title,
                style: const TextStyle(
                  fontSize: 12,
                  color: Colors.white,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        Text(task, style: const TextStyle(fontSize: 11, color: Colors.white70)),
        const SizedBox(height: 10),
        for (final width in [0.9, 0.65])
          FractionallySizedBox(
            widthFactor: width,
            child: Container(
              height: 3,
              margin: const EdgeInsets.only(bottom: 5),
              color: Colors.white24,
            ),
          ),
      ],
    ),
  );
}
