import 'package:flutter/widgets.dart';

import '../shared/theme/app_icons.dart';

/// Four agents sharing one workspace. Native menus use the corresponding
/// `square.grid.2x2` symbol in SwarmTitlebar.swift.
class SwarmIcon extends StatelessWidget {
  const SwarmIcon({super.key, this.size = 19, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) =>
      Icon(AppIcons.layoutGrid, size: size, color: color);
}
