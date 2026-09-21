import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_select_field.dart';
import '../../usage/ledger/usage_report.dart';

double usageControlWidth(BuildContext context, double width) => math.max(
  width,
  width *
      MediaQuery.textScalerOf(context).scale(AppControl.fontSize) /
      AppControl.fontSize,
);

/// Keep the controls together, below the caption when larger text needs room.
class UsageHeader extends StatelessWidget {
  const UsageHeader({super.key, required this.title, required this.controls});

  final Widget title;
  final List<Widget> controls;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final actions = Wrap(
        spacing: 4,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: controls,
      );
      if (constraints.maxWidth < usageControlWidth(context, 520)) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [title, const SizedBox(height: 10), actions],
        );
      }
      return Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(child: title),
          const SizedBox(width: 12),
          actions,
        ],
      );
    },
  );
}

class UsageRangeField extends StatelessWidget {
  const UsageRangeField({
    super.key,
    required this.value,
    required this.onChanged,
  });

  final UsageRange value;
  final ValueChanged<UsageRange> onChanged;

  @override
  Widget build(BuildContext context) => AppSelectField<UsageRange>(
    value: value,
    width: usageControlWidth(context, 150),
    options: [
      for (final range in UsageRange.values)
        SelectOption(value: range, label: range.label),
    ],
    onChanged: onChanged,
  );
}
