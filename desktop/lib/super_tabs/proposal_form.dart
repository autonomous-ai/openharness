import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import 'backlog.dart' show SuperTabTaskPriority;
import 'controller.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// + New proposal on a project's Board (task #3820, spec "Propose directly from the Board"): what to do, its goal,
/// why and what done looks like, and its priority, sent as #3817's `proposal.create`. The server refuses one that
/// misses its goal, why or done when, and a P0 from someone who may not set it; the form asks for all three and offers
/// P0 only to whoever may set it ([SuperTabController.maySteer]).
Future<void> showNewProposal(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
) => showAppDialog<void>(
  context: context,
  builder: (context) => _NewProposalDialog(controller: c, project: project),
);

class _NewProposalDialog extends StatefulWidget {
  const _NewProposalDialog({required this.controller, required this.project});

  final SuperTabController controller;
  final SuperTabProject project;

  @override
  State<_NewProposalDialog> createState() => _NewProposalDialogState();
}

class _NewProposalDialogState extends State<_NewProposalDialog> {
  SuperTabController get c => widget.controller;

  final _title = TextEditingController();
  final _goal = TextEditingController();
  final _why = TextEditingController();
  final _done = TextEditingController();
  var _priority = SuperTabTaskPriority.p2;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    for (final field in [_title, _goal, _why, _done]) {
      field.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    for (final field in [_title, _goal, _why, _done]) {
      field.dispose();
    }
    super.dispose();
  }

  bool get _complete => [
    _title,
    _goal,
    _why,
    _done,
  ].every((field) => field.text.trim().isNotEmpty);

  Future<void> _submit() async {
    if (_busy || !_complete) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final refused = await c.propose(
      widget.project.id,
      title: _title.text.trim(),
      goal: _goal.text.trim(),
      why: _why.text.trim(),
      doneWhen: _done.text.trim(),
      priority: _priority,
    );
    if (!mounted) return;
    if (refused == null) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _busy = false;
      _error = refused;
    });
  }

  Widget _field(
    String key,
    String label,
    TextEditingController controller, {
    int lines = 1,
    bool autofocus = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: grid.AppDesktop.controlGap),
    child: TextField(
      key: ValueKey(key),
      controller: controller,
      autofocus: autofocus,
      enabled: !_busy,
      minLines: lines,
      maxLines: lines == 1 ? 1 : lines + 2,
      decoration: InputDecoration(labelText: label),
    ),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final priorities = [
      for (final p in SuperTabTaskPriority.values)
        if (p != SuperTabTaskPriority.p0 || c.maySteer(widget.project)) p,
    ];
    return AlertDialog(
      title: const Text('New proposal'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'The PM decides it on the Board, and you hear back on its card.',
                style: DesktopChrome.text(),
              ),
              const SizedBox(height: grid.AppDesktop.controlGap),
              _field('super-proposal-title', 'Title', _title, autofocus: true),
              _field('super-proposal-goal', 'Goal', _goal, lines: 2),
              _field('super-proposal-why', 'Why', _why, lines: 2),
              _field('super-proposal-done', 'Done when', _done, lines: 2),
              Wrap(
                spacing: grid.AppDesktop.listRowGap,
                children: [
                  for (final p in priorities)
                    ChoiceChip(
                      key: ValueKey('super-proposal-priority-${p.name}'),
                      label: Text(p.badge),
                      tooltip: p.meaning,
                      selected: p == _priority,
                      onSelected: _busy
                          ? null
                          : (_) => setState(() => _priority = p),
                    ),
                ],
              ),
              if (_error case final error?) ...[
                const SizedBox(height: grid.AppDesktop.controlGap),
                Text(
                  error,
                  key: const ValueKey('super-proposal-error'),
                  style: DesktopChrome.metadata(),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('super-proposal-send'),
          onPressed: _busy || !_complete ? null : _submit,
          child: const Text('Propose'),
        ),
      ],
    );
  }
}
