import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart';

/// One optional action inside a toolbar panel, never a modal or focus trap.
class OnboardingCard extends StatelessWidget {
  const OnboardingCard({
    super.key,
    required this.title,
    required this.description,
    required this.action,
    required this.onAction,
    required this.onDismiss,
  });
  final String title, description, action;
  final VoidCallback? onAction;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 12),
      decoration: BoxDecoration(
        color: AppPalette.textPrimary.withValues(alpha: .04),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: AppPalette.textPrimary.withValues(alpha: .09),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(title, style: AppType.label()),
                ),
              ),
              IconButton(
                tooltip: 'Dismiss suggestion',
                onPressed: onDismiss,
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.close, size: 14),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8, bottom: 12),
            child: Text(
              description,
              style: AppType.body(color: AppPalette.textSecondary),
            ),
          ),
          FilledButton.tonal(onPressed: onAction, child: Text(action)),
        ],
      ),
    ),
  );
}
