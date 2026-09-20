import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';

/// Outside the page's scroll view, so finding a tool is always one click away.
class StoreSearch extends StatelessWidget {
  const StoreSearch({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.autofocus,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final bool autofocus;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final padding = box.maxWidth < 680 ? 20.0 : 36.0;
      final border = OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide(color: grid.AppPalette.divider),
      );
      return Container(
        key: const ValueKey('store-search-header'),
        color: grid.AppPalette.windowBg,
        padding: EdgeInsets.fromLTRB(padding, 20, padding, 16),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1440),
            child: TextField(
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
                  vertical: 19,
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
                suffixIcon: controller.text.isEmpty
                    ? null
                    : Padding(
                        padding: const EdgeInsets.only(right: 12),
                        child: AppIconButton(
                          icon: LucideIcons.x300,
                          tooltip: 'Clear search',
                          onPressed: () {
                            controller.clear();
                            onChanged('');
                            focusNode.requestFocus();
                          },
                        ),
                      ),
              ),
            ),
          ),
        ),
      );
    },
  );
}
