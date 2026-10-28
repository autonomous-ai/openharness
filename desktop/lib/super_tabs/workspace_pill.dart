import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';

/// The New Swarm box's Workspace: where the new Swarm is created, beside its
/// project's visibility. Shown only to a person with more than one Workspace
/// they may create a Swarm in.
class NewSwarmWorkspace extends StatefulWidget {
  const NewSwarmWorkspace({
    super.key,
    required this.value,
    required this.workspaces,
    required this.onChanged,
    this.disabledReason,
  });
  final String? value;
  final List<({String id, String name})> workspaces;
  final ValueChanged<String>? onChanged;
  final String? disabledReason;

  @override
  State<NewSwarmWorkspace> createState() => _NewSwarmWorkspaceState();
}

class _NewSwarmWorkspaceState extends State<NewSwarmWorkspace> {
  final _menu = MenuController();
  final _focus = FocusNode(debugLabel: 'New Swarm Workspace');

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
    final chosen =
        widget.workspaces.where((w) => w.id == widget.value).firstOrNull ??
        widget.workspaces.first;
    final width = (MediaQuery.sizeOf(context).width - 32).clamp(0.0, 280.0);
    return MenuAnchor(
      controller: _menu,
      childFocusNode: _focus,
      consumeOutsideTap: true,
      alignmentOffset: Offset(-width, grid.AppControl.menuGap),
      style: grid.AppMenu.style(
        minWidth: width,
        maxWidth: width,
      ).copyWith(alignment: AlignmentDirectional.bottomEnd),
      menuChildren: [
        for (final workspace in widget.workspaces)
          SizedBox(
            width: width,
            child: AppMenuItem(
              label: workspace.name,
              icon: AppIcons.layers,
              selected: workspace.id == chosen.id,
              expandLabel: true,
              onPressed: () {
                _menu.close();
                widget.onChanged?.call(workspace.id);
              },
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
          label: chosen.name,
          semanticLabel: 'Workspace',
          semanticHint: widget.disabledReason,
          icon: AppIcons.layers,
          menu: true,
          quiet: true,
          textSize: 13,
          tooltip:
              widget.disabledReason ?? 'The Workspace this Swarm is created in',
          onPressed: widget.onChanged == null
              ? null
              : () => menu.isOpen ? menu.close() : _open(),
        ),
      ),
    );
  }
}
