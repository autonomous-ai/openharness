import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// Shared vector marks inherit the toolbar button's quiet or notified tint.
class ToolbarIcon extends StatelessWidget {
  const ToolbarIcon({super.key, required this.name});

  final String name;

  @override
  Widget build(BuildContext context) => SvgPicture.asset(
    'assets/${name.toLowerCase()}.svg',
    width: 20,
    height: 20,
    colorFilter: ColorFilter.mode(
      IconTheme.of(context).color ?? const Color(0xff999999),
      BlendMode.srcIn,
    ),
    semanticsLabel: name,
  );
}
