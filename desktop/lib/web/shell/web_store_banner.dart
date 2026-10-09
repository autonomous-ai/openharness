import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import '../../core/phone_app_links.dart';
import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/app_type.dart';
import '../../widgets/web_download_button.dart' show openInNewTab;
import 'web_hidden_under_keyboard.dart';

final _appStore = Uri.parse(kAppStoreUrl);
final _googlePlay = Uri.parse(kGooglePlayUrl);

/// The Harness app's store page for the phone or tablet this browser runs on;
/// null on a computer, which has no store app to send anyone to.
Uri? webStoreLink([TargetPlatform? platform]) =>
    switch (platform ?? defaultTargetPlatform) {
      TargetPlatform.iOS => _appStore,
      TargetPlatform.android => _googlePlay,
      _ => null,
    };

/// Everything a browser build draws, under a bar that sends a phone's browser
/// to the Harness app in its store. It stands over every screen — sign-in, a
/// shared harness, the workspace — until it is closed, and that is remembered.
/// A computer's browser gets [child] alone.
class WebStoreFrame extends StatefulWidget {
  const WebStoreFrame({
    super.key,
    required this.child,
    this.storage,
    this.open = openInNewTab,
  });

  final Widget child;

  /// Where a closed bar is remembered; the browser's own store when absent.
  final LocalKeyValueStore? storage;

  /// How the store page is opened; tests pass a recorder.
  final Future<bool> Function(Uri uri) open;

  @override
  State<WebStoreFrame> createState() => _WebStoreFrameState();
}

class _WebStoreFrameState extends State<WebStoreFrame> {
  static const _dismissedKey = 'web_store_banner_dismissed';

  late final Uri? _link = webStoreLink();
  late final LocalKeyValueStore _storage =
      widget.storage ?? HarnessFileStore.shared;

  /// Unknown until the saved answer is read: the bar never flashes up only to
  /// leave for someone who closed it before.
  bool? _dismissed;

  @override
  void initState() {
    super.initState();
    if (_link != null) unawaited(_restore());
  }

  Future<void> _restore() async {
    // A browser that refuses storage still gets the bar, every visit.
    final saved = await _storage.read(_dismissedKey).catchError((_) => null);
    if (mounted) setState(() => _dismissed = saved != null);
  }

  void _dismiss() {
    setState(() => _dismissed = true);
    unawaited(_storage.write(_dismissedKey, '1').catchError((_) {}));
  }

  @override
  Widget build(BuildContext context) {
    final link = _link;
    final shown = link != null && _dismissed == false;
    final media = MediaQuery.of(context);
    // One shape whether or not the bar shows: the app below must never be
    // remounted by a bar coming or going.
    return Column(
      children: [
        if (shown)
          WebHiddenUnderKeyboard(
            child: _WebStoreBar(
              onOpen: () => unawaited(widget.open(link)),
              onDismiss: _dismiss,
            ),
          ),
        Expanded(
          key: const ValueKey('web-store-frame-app'),
          child: MediaQuery(
            // The bar took the top inset; the app below starts under it.
            data: shown ? media.removePadding(removeTop: true) : media,
            child: widget.child,
          ),
        ),
      ],
    );
  }
}

/// Close, what the app is for, and the way to it.
class _WebStoreBar extends StatelessWidget {
  const _WebStoreBar({required this.onOpen, required this.onDismiss});

  final VoidCallback onOpen;
  final VoidCallback onDismiss;

  static const _iconSize = 40.0;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      key: const ValueKey('web-store-banner'),
      color: grid.AppPalette.swarmTabBar,
      child: SafeArea(
        bottom: false,
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(4, 8, 12, 8),
            child: Row(
              children: [
                // No tooltip: this bar sits above the app's overlay.
                Semantics(
                  button: true,
                  label: 'Close',
                  child: IconButton(
                    key: const ValueKey('web-store-banner-close'),
                    onPressed: onDismiss,
                    icon: const Icon(AppIcons.close, size: 16),
                    color: grid.AppPalette.textSecondary,
                    visualDensity: VisualDensity.compact,
                  ),
                ),
                // The app's own icon, as its store page shows it: what makes
                // this bar read as an app to get, not a line of chrome. The
                // asset carries its rounded corners, so it is drawn bare.
                Image.asset(
                  'assets/app_icon.png',
                  key: const ValueKey('web-store-banner-icon'),
                  width: _iconSize,
                  height: _iconSize,
                  filterQuality: FilterQuality.medium,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        'Harness',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.label(
                          color: grid.AppPalette.textPrimary,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      // Wraps on a narrow phone rather than losing its end.
                      Text(
                        'Run your fleet from your phone',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.caption(
                          color: grid.AppPalette.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const ValueKey('web-store-banner-open'),
                  onPressed: onOpen,
                  // Narrower than a form's button: the words beside it need
                  // the width on a phone.
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                  ),
                  child: const Text('Get the app'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
