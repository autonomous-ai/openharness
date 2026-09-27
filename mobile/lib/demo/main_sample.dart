import 'package:flutter/material.dart';

import 'package:harness_mobile/core/startup.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';

import 'sample_mode.dart';

/// The phone app in sample mode and nothing else — no sign-in under it, no account, no network:
///
///     flutter run -t lib/demo/main_sample.dart
///
/// For walking the app the way somebody new to it would, on a phone or a simulator, without a
/// machine to link. The saved appearance and terminal settings are read (never written), so the
/// sample looks like the app it stands in for.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await loadPersistedSettings();
  runApp(const SampleApp());
}

class SampleApp extends StatelessWidget {
  const SampleApp({super.key});

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<AppearancePrefs>(
    valueListenable: appearancePrefsStore,
    builder: (context, prefs, _) {
      // What `HarnessApp` does before it builds its theme: the palette and the type settings go
      // on first, because the theme bakes them in.
      grid.AppTheme.palette.value = prefs.palette;
      grid.AppTheme.fonts.apply(
        uiFamily: prefs.uiFamily,
        uiScale: prefs.uiSize / grid.AppFont.uiSizeDefault,
        codeSize: grid.AppFont.codeSize,
      );
      grid.AppTheme.brightness.value = Brightness.dark;
      return MaterialApp(
        title: 'Harness sample',
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) =>
            grid.BrightnessScope(child: child ?? const SizedBox.shrink()),
        home: const _Launcher(),
      );
    },
  );
}

/// Opens the sample as the app starts, and again from its button after it is left.
class _Launcher extends StatefulWidget {
  const _Launcher();

  @override
  State<_Launcher> createState() => _LauncherState();
}

class _LauncherState extends State<_Launcher> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) openSampleMode(context);
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: TextButton(
        onPressed: () => openSampleMode(context),
        child: const Text('Open the sample'),
      ),
    ),
  );
}
