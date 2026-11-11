import 'package:flutter/widgets.dart';

import 'appearance_prefs_store.dart';
import 'color_palette.dart';

/// Builds the app on its appearance: [store]'s choices, put on `AppTheme` by [applyAppearance]
/// for this phone's own light or dark before [builder] runs — the order the theme needs, since
/// `buildAppTheme` bakes the palette in.
///
/// It hears both: a choice in Settings, and the phone itself turning light or dark, which is what
/// Theme's System follows. The phone's side is read from the [MediaQuery] the root `View` puts
/// above the app, so it is there before `MaterialApp` is.
class AppearanceBuilder extends StatelessWidget {
  const AppearanceBuilder({super.key, this.store, required this.builder});

  /// [appearancePrefsStore] unless a test hands in its own.
  final AppearancePrefsStore? store;

  /// The app, with the choices and the palette it wears for them.
  final Widget Function(
    BuildContext context,
    AppearancePrefs prefs,
    HarnessPalette palette,
  )
  builder;

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<AppearancePrefs>(
    valueListenable: store ?? appearancePrefsStore,
    builder: (context, prefs, _) => builder(
      context,
      prefs,
      applyAppearance(
        prefs,
        platform:
            MediaQuery.maybePlatformBrightnessOf(context) ?? Brightness.dark,
      ),
    ),
  );
}
