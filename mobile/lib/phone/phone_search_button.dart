import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_search_page.dart';

/// The way into [PhoneSearchPage], drawn in a tab header's `trailing`.
///
/// One widget for both tabs rather than the same four lines written twice: the
/// search it opens spans agents AND machines, so the two tabs must offer it
/// identically. A glyph that sat at a different size or opened a differently
/// configured page on one of them would read as two different features.
class PhoneSearchButton extends StatelessWidget {
  const PhoneSearchButton({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      // Clear of the header's own right padding, so the glyph sits on the same
      // vertical as the large title beside it rather than jammed to the edge.
      padding: const EdgeInsets.only(right: 2),
      child: AppIconButton(
        icon: LucideIcons.search300,
        size: 22,
        tooltip: 'Search',
        color: AppPalette.textSecondary,
        onPressed: () => openPhoneSearch(context, notifier),
      ),
    );
  }
}
