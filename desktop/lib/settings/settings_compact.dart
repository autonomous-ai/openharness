import 'dart:math' as math;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../shared/layouts/widgets/sidebar_item.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/section_scaffold.dart';
import '../widgets/finger_target.dart';
import 'settings_nav.dart';
import 'settings_section.dart';

/// One settings section on a narrow screen (the web on a phone): the section
/// takes the width, and the way back to the list of sections sits above it,
/// shaped like the list's own "Back to app" row and as easy to hit.
class SettingsCompactSection extends StatelessWidget {
  const SettingsCompactSection({
    super.key,
    required this.onBack,
    required this.child,
  });

  final VoidCallback onBack;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(
          SectionScaffold.contentPadding - SidebarItem.iconGutter,
          SectionScaffold.contentPadding / 2,
          SectionScaffold.contentPadding - SidebarItem.iconGutter,
          0,
        ),
        child: SizedBox(
          height: fingerHeight(
            SectionScaffold.headingHeight(context),
            enabled: true,
          ),
          child: Center(
            child: fingerTarget(
              enabled: true,
              SidebarItem(
                key: const Key('settings-compact-back'),
                icon: AppIcons.arrowLeft,
                label: 'Settings',
                onTap: onBack,
              ),
            ),
          ),
        ),
      ),
      Expanded(child: _FingerButtons(child: child)),
    ],
  );
}

/// A phone's section: its buttons a finger tall, and as wide as they were.
class _FingerButtons extends StatelessWidget {
  const _FingerButtons({required this.child});

  final Widget child;

  static ButtonStyle _tall(ButtonStyle? style) {
    final least = style?.minimumSize?.resolve(const {}) ?? Size.zero;
    return (style ?? const ButtonStyle()).copyWith(
      minimumSize: WidgetStatePropertyAll(
        Size(math.max(least.width, kFingerTarget), kFingerTarget),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Theme(
      data: theme.copyWith(
        filledButtonTheme: FilledButtonThemeData(
          style: _tall(theme.filledButtonTheme.style),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: _tall(theme.outlinedButtonTheme.style),
        ),
        textButtonTheme: TextButtonThemeData(
          style: _tall(theme.textButtonTheme.style),
        ),
      ),
      child: child,
    );
  }
}

/// Settings on a phone: the list of sections, or one open section. The
/// browser's (or Android's) Back leaves the section before it leaves Settings,
/// as the on-screen way back does.
class SettingsCompactScreen extends StatelessWidget {
  const SettingsCompactScreen({
    super.key,
    required this.section,
    required this.sectionOpen,
    required this.onSelect,
    required this.onBack,
    required this.onKeyEvent,
    required this.body,
  });

  final SettingsSection section;
  final bool sectionOpen;
  final ValueChanged<SettingsSection> onSelect;
  final VoidCallback onBack;
  final FocusOnKeyEventCallback onKeyEvent;
  final Widget body;

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !sectionOpen,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) onBack();
    },
    child: Focus(
      onKeyEvent: onKeyEvent,
      child: Scaffold(
        backgroundColor: grid.AppPalette.windowBg,
        body: sectionOpen
            ? SettingsCompactSection(onBack: onBack, child: body)
            : SettingsNav(
                section: section,
                onSelect: onSelect,
                railWidth: double.infinity,
                autofocusSearch: false,
                compact: true,
              ),
      ),
    ),
  );
}
