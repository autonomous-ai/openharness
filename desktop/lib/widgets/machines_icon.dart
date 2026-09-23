import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

class MachinesIcon extends StatelessWidget {
  const MachinesIcon({super.key});

  @override
  Widget build(BuildContext context) => SvgPicture.asset(
    'assets/machines.svg',
    width: 24,
    height: 24,
    semanticsLabel: 'Machines',
  );
}
