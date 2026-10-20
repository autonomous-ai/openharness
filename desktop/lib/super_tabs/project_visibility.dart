import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../widgets/desktop_chrome.dart';

class ProjectVisibility extends StatelessWidget {
  const ProjectVisibility({
    super.key,
    required this.value,
    required this.onChanged,
  });
  final String value;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) => MenuAnchor(
    menuChildren: [
      for (final (id, title, detail) in const [
        ('public', 'Public', 'Everyone in this swarm'),
        ('private', 'Private', 'Only people you invite to this project'),
      ])
        MenuItemButton(
          onPressed: onChanged == null ? null : () => onChanged!(id),
          leadingIcon: Icon(
            id == 'private' ? AppIcons.lock : AppIcons.users,
            size: 16,
          ),
          trailingIcon: id == value
              ? const Icon(AppIcons.check, size: 16)
              : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: DesktopChrome.control()),
                Text(detail, style: DesktopChrome.metadata()),
              ],
            ),
          ),
        ),
    ],
    builder: (context, menu, _) => DesktopPill(
      label: value == 'private' ? 'Private' : 'Public',
      semanticLabel: 'Project visibility',
      icon: value == 'private' ? AppIcons.lock : AppIcons.users,
      capsule: true,
      textSize: 13,
      tooltip: value == 'private'
          ? 'Only invited project members'
          : 'Everyone in this swarm',
      onPressed: onChanged == null
          ? null
          : () => menu.isOpen ? menu.close() : menu.open(),
    ),
  );
}
