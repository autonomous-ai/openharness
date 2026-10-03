import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;

/// A hairline with OR in the middle of it: what follows is another way to do the same thing,
/// not a second step. The login screen's, between the two accounts and the phone's QR, as on the
/// Autonomous storefront's sign-in.
class OrDivider extends StatelessWidget {
  const OrDivider({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final line = Expanded(
      child: Divider(height: 1, color: grid.AppPalette.divider),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          line,
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text(
              'OR',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: grid.AppPalette.textFaint,
                letterSpacing: .8,
              ),
            ),
          ),
          line,
        ],
      ),
    );
  }
}
