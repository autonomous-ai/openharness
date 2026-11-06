import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'model.dart';

/// The two ways a project can work (task #3897, #3896): its id as the server names it, its title, and one line on what
/// it means.
const kProjectProcesses = [
  ('simple', 'Simple', 'To do, Doing, Done. No review, test or merge steps.'),
  (
    'full',
    'Full',
    'Proposal, Next up, Working, Done, Merged, Shipped, with review, test and merge.',
  ),
];

String _title(String id) => id == 'simple' ? 'Simple' : 'Full';

/// New project's choice of process, beside its visibility: Full until the person picks Simple. [disabledReason] says
/// why it cannot change (creation started, another request in flight).
class ProjectProcessPicker extends StatefulWidget {
  const ProjectProcessPicker({
    super.key,
    required this.value,
    required this.onChanged,
    this.disabledReason,
  });
  final String value;
  final ValueChanged<String>? onChanged;
  final String? disabledReason;

  @override
  State<ProjectProcessPicker> createState() => _ProjectProcessPickerState();
}

class _ProjectProcessPickerState extends State<ProjectProcessPicker> {
  final _menu = MenuController();
  final _focus = FocusNode(debugLabel: 'Project process');

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  void _open() {
    if (widget.onChanged != null) _menu.open();
  }

  @override
  Widget build(BuildContext context) {
    final width = (MediaQuery.sizeOf(context).width - 32).clamp(0.0, 360.0);
    return AppDropdown(
      controller: _menu,
      childFocusNode: _focus,
      width: width,
      alignmentOffset: Offset(-width, grid.AppControl.menuGap),
      alignment: AlignmentDirectional.bottomEnd,
      children: [
        for (final (id, title, detail) in kProjectProcesses)
          Tooltip(
            message: detail,
            child: AppMenuItem(
              label: title,
              detail: detail,
              selected: id == widget.value,
              onPressed: () => widget.onChanged?.call(id),
            ),
          ),
      ],
      builder: (context, menu, _) => CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.arrowDown): _open,
          const SingleActivator(LogicalKeyboardKey.arrowUp): _open,
        },
        child: DesktopPill(
          focusNode: _focus,
          label: _title(widget.value),
          semanticLabel: 'Project process',
          semanticHint: widget.disabledReason,
          icon: AppIcons.squareKanban,
          menu: true,
          quiet: true,
          textSize: 13,
          tooltip:
              widget.disabledReason ??
              kProjectProcesses.firstWhere((p) => p.$1 == widget.value).$3,
          onPressed: widget.onChanged == null
              ? null
              : () => menu.isOpen ? menu.close() : _open(),
        ),
      ),
    );
  }
}

/// Project settings ▸ Process: the project's two ways of working, one line each. Its owner or the Swarm's owner
/// chooses (`project.process`; the server refuses anyone else); everyone else reads it.
Future<void> showProjectProcess(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: project.id,
    requireWrite: false,
    child: _ProjectProcess(controller: c, projectId: project.id),
  ),
);

class _ProjectProcess extends StatefulWidget {
  const _ProjectProcess({required this.controller, required this.projectId});

  final SuperTabController controller;
  final String projectId;

  @override
  State<_ProjectProcess> createState() => _ProjectProcessState();
}

class _ProjectProcessState extends State<_ProjectProcess> {
  SuperTabController get c => widget.controller;
  String? _error;

  Future<void> _choose(SuperTabProcess process) async {
    setState(() => _error = null);
    final refused = await c.setProcess(widget.projectId, process);
    if (mounted) setState(() => _error = refused);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final project = c.snapshot?.projectById(widget.projectId);
        if (project == null) return const SizedBox.shrink();
        // Only the project's owner or the Swarm's owner may change it.
        final mayChange =
            c.canWrite &&
            !c.saving &&
            !c.hasPendingAction &&
            (project.ownerId == c.accountId || c.isOwner);
        final ownerMay = project.ownerId == c.accountId || c.isOwner;
        return SuperTabDetailDialog(
          title: 'Process',
          detail: project.name,
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final (id, title, detail) in kProjectProcesses)
                _option(
                  id,
                  title,
                  detail,
                  selected: (id == 'simple') == project.isSimple,
                  enabled: mayChange,
                ),
              if (!ownerMay)
                Padding(
                  padding: const EdgeInsets.only(
                    top: grid.AppDesktop.controlGap,
                  ),
                  child: Text(
                    'Only the project’s owner can change it.',
                    key: const ValueKey('project-process-owner-only'),
                    style: DesktopChrome.metadata(),
                  ),
                ),
              if (_error case final error?)
                Padding(
                  padding: const EdgeInsets.only(
                    top: grid.AppDesktop.controlGap,
                  ),
                  child: Text(
                    error,
                    key: const ValueKey('project-process-error'),
                    style: DesktopChrome.metadata(),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _option(
    String id,
    String title,
    String detail, {
    required bool selected,
    required bool enabled,
  }) => KeyedSubtree(
    key: ValueKey('project-process-$id'),
    child: MergeSemantics(
      child: Semantics(
        selected: selected,
        inMutuallyExclusiveGroup: true,
        child: InkWell(
          onTap: enabled && !selected
              ? () => unawaited(
                  _choose(
                    id == 'simple'
                        ? SuperTabProcess.simple
                        : SuperTabProcess.full,
                  ),
                )
              : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              vertical: grid.AppDesktop.listRowGap,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: DesktopChrome.control()),
                      Text(detail, style: DesktopChrome.metadata()),
                    ],
                  ),
                ),
                if (selected)
                  Icon(
                    AppIcons.check,
                    size: AppIcons.inlineSize,
                    color: DesktopChrome.foreground,
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
