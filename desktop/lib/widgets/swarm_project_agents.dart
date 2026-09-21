import 'swarm_search_field.dart';

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/swarm_catalog.dart';

Future<SavedSwarmProject?> showSwarmProjectAgents(
  BuildContext context,
  AppNotifier app,
  SwarmProjectGroup group,
) => showAppDialog<SavedSwarmProject>(
  context: context,
  transitionDuration: Duration.zero,
  veilBlur: 0,
  builder: (_) => _ProjectAgents(app: app, group: group),
);

class _ProjectAgents extends StatefulWidget {
  const _ProjectAgents({required this.app, required this.group});
  final AppNotifier app;
  final SwarmProjectGroup group;
  @override
  State<_ProjectAgents> createState() => _ProjectAgentsState();
}

class _ProjectAgentsState extends State<_ProjectAgents> {
  late final _members = {...?widget.group.saved?.members};
  late final _automatic = {
    for (final a in widget.group.agents)
      if (a.project?.identity(a.machineId) == widget.group.id)
        (machineId: a.machineId, agentId: a.agent.id),
  };
  String _query = '';

  void _save() {
    final original = widget.group.saved;
    final anchor = widget.group.agents
        .where((a) => a.project != null)
        .firstOrNull;
    if (original == null && anchor == null) return;
    Navigator.pop(
      context,
      SavedSwarmProject(
        machineId: original?.machineId ?? anchor!.machineId,
        path: original?.path ?? anchor!.project!.root ?? anchor!.project!.cwd,
        name: original?.name ?? widget.group.name,
        members: List.unmodifiable(_members),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Dialog(
    child: SizedBox(
      width: 620,
      height: 520,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.group.name,
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w500),
            ),
            const SizedBox(height: 8),
            const Text(
              'Include agents from any machine. Matching repositories are included automatically.',
              style: TextStyle(fontSize: 12),
            ),
            const SizedBox(height: 16),
            SwarmSearchField(
              autofocus: true,
              hintText: 'Find a harness or machine',
              onChanged: (value) => setState(() => _query = value),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: ListenableBuilder(
                listenable: widget.app,
                builder: (context, _) {
                  final rows = swarmAgents(widget.app, _query);
                  if (rows.isEmpty) {
                    return const Center(child: Text('No matching harnesses'));
                  }
                  return ListView.builder(
                    itemCount: rows.length,
                    itemBuilder: (context, index) {
                      final agent = rows[index];
                      final id = (
                        machineId: agent.machineId,
                        agentId: agent.agent.id,
                      );
                      final automatic = _automatic.contains(id);
                      return CheckboxListTile(
                        controlAffinity: ListTileControlAffinity.leading,
                        contentPadding: EdgeInsets.zero,
                        value: automatic || _members.contains(id),
                        title: Text(
                          agent.agent.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 13),
                        ),
                        subtitle: Text(
                          '${agent.machine.machine.displayName}${automatic ? ' · Repository match' : ''}',
                          style: const TextStyle(fontSize: 11),
                        ),
                        onChanged: automatic
                            ? null
                            : (selected) => setState(() {
                                if (selected == true) {
                                  _members.add(id);
                                } else {
                                  _members.remove(id);
                                }
                              }),
                      );
                    },
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _save, child: const Text('Save')),
              ],
            ),
          ],
        ),
      ),
    ),
  );
}
