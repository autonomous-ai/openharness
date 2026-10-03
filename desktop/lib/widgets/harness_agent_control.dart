import 'package:flutter/material.dart';

import '../core/models.dart';
import '../state/app_state.dart';
import 'harness_agent_picker.dart';
import 'pane_header_text_button.dart';

/// The agent name, immediately beside the model, opens the shared & picker.
class HarnessAgentControl extends StatelessWidget {
  const HarnessAgentControl({
    super.key,
    required this.app,
    required this.machineId,
    required this.agent,
    this.enabled = true,
  });
  final AppNotifier app;
  final String machineId;
  final Agent agent;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final name = HarnessAgentPicker.label(agent.engine ?? '');
    final canChange = enabled && app.openAgentPicker != null;
    return PaneHeaderTextButton(
      key: const ValueKey('pane-agent-control'),
      text: name,
      label: 'Agent: $name',
      tooltip: canChange ? 'Change agent' : null,
      onPressed: canChange
          ? () => app.openAgentPicker!(machineId, agent.id)
          : null,
    );
  }
}
