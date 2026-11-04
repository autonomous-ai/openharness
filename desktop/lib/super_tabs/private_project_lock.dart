import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';

/// The channel mark and its accessible name for a private project.
class PrivateProjectLock extends StatelessWidget {
  const PrivateProjectLock({super.key, this.size = 14, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: 'Private project',
    child: Semantics(
      label: 'Private project',
      child: Icon(AppIcons.lock, size: size, color: color),
    ),
  );
}
