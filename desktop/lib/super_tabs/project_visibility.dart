import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';

class ProjectVisibility extends StatefulWidget {
  const ProjectVisibility({
    super.key,
    required this.value,
    required this.onChanged,
    this.disabledReason,
  });
  final String value;
  final ValueChanged<String>? onChanged;
  final String? disabledReason;

  @override
  State<ProjectVisibility> createState() => _ProjectVisibilityState();
}

class _ProjectVisibilityState extends State<ProjectVisibility> {
  final _menu = MenuController();
  final _focus = FocusNode(debugLabel: 'Project visibility');

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
        for (final (id, title, detail) in const [
          ('public', 'Public', 'Everyone in this swarm'),
          ('private', 'Private', 'Only people you invite to this project'),
        ])
          SizedBox(
            width: width,
            child: Tooltip(
              message: detail,
              child: AppMenuItem(
                label: title,
                detail: detail,
                icon: id == 'private' ? AppIcons.lock : AppIcons.users,
                selected: id == widget.value,
                expandLabel: true,
                onPressed: () {
                  _menu.close();
                  widget.onChanged?.call(id);
                },
              ),
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
          label: widget.value == 'private' ? 'Private' : 'Public',
          semanticLabel: 'Project visibility',
          semanticHint: widget.disabledReason,
          icon: widget.value == 'private' ? AppIcons.lock : AppIcons.users,
          menu: true,
          quiet: true,
          textSize: 13,
          tooltip:
              widget.disabledReason ??
              (widget.value == 'private'
                  ? 'Only people you invite to this project'
                  : 'Everyone in this swarm'),
          onPressed: widget.onChanged == null
              ? null
              : () => menu.isOpen ? menu.close() : _open(),
        ),
      ),
    );
  }
}
