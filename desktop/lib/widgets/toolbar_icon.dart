import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';

/// Toolbar destinations use the same outline vocabulary as menus and search.
class ToolbarIcon extends StatelessWidget {
  const ToolbarIcon({super.key, required this.name});

  final String name;

  @override
  Widget build(BuildContext context) => Icon(
    switch (name.toLowerCase()) {
      'machines' => AppIcons.monitor,
      'models' => AppIcons.brainCircuit,
      _ => AppIcons.squareTerminal,
    },
    size: AppIcons.controlSize,
    semanticLabel: name,
  );
}
