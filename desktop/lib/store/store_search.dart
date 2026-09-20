import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shortcuts/app_keymap.dart';

/// Search and orientation stay in view while the destination scrolls below.
class StoreSearch extends StatelessWidget {
  const StoreSearch({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.autofocus,
    required this.onClear,
    required this.onBack,
    required this.onForward,
    required this.onDiscover,
    required this.location,
    this.category,
    this.onCategory,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final bool autofocus;
  final VoidCallback onClear;
  final VoidCallback? onBack;
  final VoidCallback? onForward;
  final VoidCallback onDiscover;
  final String location;
  final String? category;
  final VoidCallback? onCategory;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final padding = box.maxWidth < 680 ? 20.0 : 36.0;
      final border = OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide(color: grid.AppPalette.divider),
      );
      final searchHint = effectiveCommandHint(context, 'terminal.find');
      return Container(
        key: const ValueKey('store-search-header'),
        color: grid.AppPalette.windowBg,
        padding: EdgeInsets.fromLTRB(padding, 18, padding, 4),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1440),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  key: const ValueKey('store-search'),
                  controller: controller,
                  focusNode: focusNode,
                  autofocus: autofocus,
                  onChanged: onChanged,
                  textInputAction: TextInputAction.search,
                  style: TextStyle(
                    fontSize: 16,
                    color: grid.AppPalette.textPrimary,
                  ),
                  decoration: InputDecoration(
                    hintText: 'Search harnesses, tools, or ideas…',
                    hintStyle: TextStyle(
                      fontSize: 16,
                      color: grid.AppPalette.textSecondary,
                    ),
                    filled: true,
                    fillColor: grid.AppSurface.recess,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 18,
                    ),
                    border: border,
                    enabledBorder: border,
                    focusedBorder: border.copyWith(
                      borderSide: BorderSide(
                        color: grid.AppPalette.accentOnSurface,
                        width: 1.5,
                      ),
                    ),
                    prefixIcon: Icon(
                      LucideIcons.search300,
                      size: 22,
                      color: grid.AppPalette.textSecondary,
                    ),
                    prefixIconConstraints: const BoxConstraints(minWidth: 56),
                    suffixIcon: controller.text.isNotEmpty
                        ? Padding(
                            padding: const EdgeInsets.only(right: 12),
                            child: AppIconButton(
                              icon: LucideIcons.x300,
                              tooltip: 'Clear search',
                              onPressed: onClear,
                            ),
                          )
                        : box.maxWidth > 650 && searchHint != null
                        ? Padding(
                            padding: const EdgeInsets.only(right: 18),
                            child: Center(
                              widthFactor: 1,
                              child: Text(
                                searchHint,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: grid.AppPalette.textFaint,
                                ),
                              ),
                            ),
                          )
                        : null,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    TextButton.icon(
                      key: const ValueKey('store-back'),
                      onPressed: onBack,
                      icon: const Icon(LucideIcons.arrowLeft300, size: 16),
                      label: const Text('Back'),
                      style: TextButton.styleFrom(
                        foregroundColor: grid.AppPalette.textSecondary,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        minimumSize: const Size(0, 34),
                      ),
                    ),
                    AppIconButton(
                      key: const ValueKey('store-nav-forward'),
                      icon: LucideIcons.arrowRight300,
                      tooltip: 'Forward',
                      onPressed: onForward,
                      size: 16,
                    ),
                    Container(
                      height: 16,
                      width: 1,
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      color: grid.AppPalette.divider,
                    ),
                    if (location != 'Discover') ...[
                      TextButton(
                        key: const ValueKey('store-breadcrumb-discover'),
                        onPressed: onDiscover,
                        style: TextButton.styleFrom(
                          foregroundColor: grid.AppPalette.textSecondary,
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          minimumSize: const Size(0, 34),
                        ),
                        child: const Text('Discover'),
                      ),
                      Icon(
                        LucideIcons.chevronRight300,
                        size: 13,
                        color: grid.AppPalette.textFaint,
                      ),
                    ],
                    if (category != null && box.maxWidth > 650) ...[
                      TextButton(
                        key: const ValueKey('store-breadcrumb-category'),
                        onPressed: onCategory,
                        style: TextButton.styleFrom(
                          foregroundColor: grid.AppPalette.textSecondary,
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          minimumSize: const Size(0, 34),
                        ),
                        child: Text(category!),
                      ),
                      Icon(
                        LucideIcons.chevronRight300,
                        size: 13,
                        color: grid.AppPalette.textFaint,
                      ),
                    ],
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        location,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: grid.AppPalette.textPrimary,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
