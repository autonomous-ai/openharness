import 'dart:math' as math;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import '../../core/desktop_window.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/appearance_prefs_store.dart';
import '../../shared/theme/custom_background.dart';
import '../../shared/theme/harness_background.dart';
import '../../widgets/swarm_wallpaper.dart';

class WallpaperSection extends StatelessWidget {
  const WallpaperSection({super.key, this.store, this.pickImage});
  final AppearancePrefsStore? store;

  /// Opens the file chooser; replaced in tests, which have no native dialog.
  final Future<String?> Function()? pickImage;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final prefs = store ?? appearancePrefsStore;
    return ValueListenableBuilder<AppearancePrefs>(
      valueListenable: prefs,
      builder: (context, value, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Background',
            style: grid.AppType.heading(color: grid.AppPalette.textPrimary),
          ),
          const SizedBox(height: 8),
          Text(
            'Shown behind the panes of running harness tabs.',
            style: grid.AppType.body(color: grid.AppPalette.textSecondary),
          ),
          const SizedBox(height: 16),
          LayoutBuilder(
            builder: (context, constraints) {
              final columns =
                  constraints.maxWidth >=
                      300 * math.max(1, grid.appTextScaleOf(context))
                  ? 2
                  : 1;
              final width =
                  (constraints.maxWidth - (columns - 1) * 12) / columns;
              return Wrap(
                spacing: 12,
                runSpacing: 16,
                children: [
                  for (final choice in HarnessBackground.gallery)
                    SizedBox(
                      width: width,
                      child: _BackgroundCard(
                        key: ValueKey('wallpaper-${choice.name}'),
                        label: choice.label,
                        selected: value.background == choice,
                        onTap: () => prefs.setBackground(choice),
                        preview: SwarmWallpaper(
                          background: choice,
                          thumbnail: true,
                          store: prefs,
                        ),
                      ),
                    ),
                  // The browser has no folder to keep a copy in.
                  if (!kIsWeb)
                    SizedBox(
                      width: width,
                      child: _CustomCard(
                        prefs: prefs,
                        value: value,
                        pickImage: pickImage ?? _pickImage,
                      ),
                    ),
                ],
              );
            },
          ),
          if (!kIsWeb && value.background == HarnessBackground.custom) ...[
            const SizedBox(height: 20),
            _CustomControls(prefs: prefs, custom: value.custom),
          ],
          // Blank has nothing to show through.
          if (value.showsBackground) ...[
            const SizedBox(height: 20),
            _PaneOpacityControl(prefs: prefs, value: value),
          ],
        ],
      ),
    );
  }

  static Future<String?> _pickImage() async {
    final file = await whileNativePicker(
      () => openFile(
        acceptedTypeGroups: const [
          XTypeGroup(label: 'Images', extensions: customBackgroundExtensions),
        ],
      ),
    );
    return file?.path;
  }
}

class _BackgroundCard extends StatelessWidget {
  const _BackgroundCard({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    required this.preview,
    this.highlighted = false,
    this.footer,
  });
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final Widget preview;

  /// A file is being dragged over the card.
  final bool highlighted;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: '$label background',
      child: Material(
        color: Colors.transparent,
        child: TextButton(
          onPressed: onTap,
          style: ButtonStyle(
            padding: const WidgetStatePropertyAll(EdgeInsets.zero),
            side: WidgetStateProperty.resolveWith(
              (states) => BorderSide(
                color: states.contains(WidgetState.focused)
                    ? grid.AppDesktop.focus
                    : Colors.transparent,
                width: grid.AppDesktop.focusWidth,
              ),
            ),
            shape: WidgetStatePropertyAll(
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.all(3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: selected || highlighted
                          ? grid.AppPalette.swarmAccent
                          : grid.AppPalette.divider,
                      width: 2,
                    ),
                  ),
                  child: AspectRatio(
                    aspectRatio: 16 / 9,
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        preview,
                        if (selected)
                          Positioned(
                            right: 8,
                            bottom: 8,
                            // White vanishes on a light palette's plain field
                            // (1.25:1); its deep accent holds 5.1:1 or better.
                            child: Icon(
                              AppIcons.circleCheck,
                              color: grid.AppTheme.pick(
                                grid.AppPalette.swarmAccent,
                                Colors.white,
                              ),
                              size: 20,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  label,
                  style: grid.AppType.label(color: grid.AppPalette.textPrimary),
                ),
                ?footer,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The user's own image: empty until one is chosen or dropped, then a card
/// like the rest with Replace and Remove beneath it.
class _CustomCard extends StatefulWidget {
  const _CustomCard({
    required this.prefs,
    required this.value,
    required this.pickImage,
  });
  final AppearancePrefsStore prefs;
  final AppearancePrefs value;
  final Future<String?> Function() pickImage;

  @override
  State<_CustomCard> createState() => _CustomCardState();
}

class _CustomCardState extends State<_CustomCard> {
  bool _hovering = false;
  bool _busy = false;
  String? _error;

  bool get _hasImage => widget.value.custom.image != null;

  Future<void> _choose() async {
    if (_busy) return;
    final String? path;
    try {
      path = await widget.pickImage();
    } catch (_) {
      return;
    }
    if (path != null) await _use(path);
  }

  Future<void> _use(String path) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.prefs.chooseCustomBackground(path);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final muted = grid.AppType.label(color: grid.AppPalette.textSecondary);
    return DropTarget(
      key: const ValueKey('custom-background-drop'),
      enable: !_busy,
      onDragEntered: (_) => setState(() => _hovering = true),
      onDragExited: (_) => setState(() => _hovering = false),
      onDragDone: (details) async {
        setState(() => _hovering = false);
        if (details.files.isNotEmpty) await _use(details.files.first.path);
      },
      child: _BackgroundCard(
        key: const ValueKey('wallpaper-custom'),
        label: HarnessBackground.custom.label,
        selected: widget.value.background == HarnessBackground.custom,
        highlighted: _hovering,
        onTap: _hasImage
            ? () => widget.prefs.setBackground(HarnessBackground.custom)
            : _choose,
        preview: _busy
            ? ColoredBox(
                color: grid.AppPalette.swarmField,
                child: const Center(
                  child: SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            : _hasImage
            ? SwarmWallpaper(
                background: HarnessBackground.custom,
                thumbnail: true,
                store: widget.prefs,
              )
            : ColoredBox(
                key: const ValueKey('custom-background-empty'),
                color: grid.AppPalette.panelBg,
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        AppIcons.imagePlus,
                        color: grid.AppPalette.textSecondary,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Choose image…',
                        style: grid.AppType.label(
                          color: grid.AppPalette.textPrimary,
                        ),
                      ),
                      Text('or drop one here', style: muted),
                    ],
                  ),
                ),
              ),
        footer: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_hasImage)
              Wrap(
                spacing: 8,
                children: [
                  TextButton(
                    key: const ValueKey('custom-background-replace'),
                    onPressed: _busy ? null : _choose,
                    child: const Text('Replace…'),
                  ),
                  TextButton(
                    key: const ValueKey('custom-background-remove'),
                    onPressed: _busy
                        ? null
                        : () {
                            setState(() => _error = null);
                            widget.prefs.removeCustomBackground();
                          },
                    child: const Text('Remove'),
                  ),
                ],
              ),
            if (_error case final error?)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  error,
                  key: const ValueKey('custom-background-error'),
                  style: grid.AppType.label(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Dim and fit, shown only while the custom background is selected: the
/// built-in ones were drawn to be readable as they are.
class _CustomControls extends StatelessWidget {
  const _CustomControls({required this.prefs, required this.custom});
  final AppearancePrefsStore prefs;
  final CustomBackground custom;

  @override
  Widget build(BuildContext context) {
    final label = grid.AppType.label(color: grid.AppPalette.textPrimary);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Dim', style: label),
        Row(
          children: [
            Expanded(
              child: Slider(
                key: const ValueKey('custom-background-dim'),
                value: custom.dim,
                max: CustomBackground.dimMax,
                divisions: 16,
                label: '${(custom.dim * 100).round()}%',
                onChanged: (dim) => prefs.setCustomBackground(dim: dim),
              ),
            ),
            SizedBox(
              width: 44,
              child: Text(
                '${(custom.dim * 100).round()}%',
                textAlign: TextAlign.end,
                style: grid.AppType.label(color: grid.AppPalette.textSecondary),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Text('Fit', style: label),
        const SizedBox(height: 8),
        SegmentedButton<BackgroundFit>(
          key: const ValueKey('custom-background-fit'),
          showSelectedIcon: false,
          segments: [
            for (final fit in BackgroundFit.values)
              ButtonSegment(
                value: fit,
                label: Text(fit.label, key: ValueKey('fit-${fit.name}')),
              ),
          ],
          selected: {custom.fit},
          onSelectionChanged: (selection) =>
              prefs.setCustomBackground(fit: selection.first),
        ),
      ],
    );
  }
}

/// How solid the panes stay while the background shows through them.
class _PaneOpacityControl extends StatelessWidget {
  const _PaneOpacityControl({required this.prefs, required this.value});
  final AppearancePrefsStore prefs;
  final AppearancePrefs value;

  @override
  Widget build(BuildContext context) {
    final label = grid.AppType.label(color: grid.AppPalette.textPrimary);
    final percent = '${(value.paneOpacity * 100).round()}%';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Pane opacity', style: label),
        Row(
          children: [
            Expanded(
              child: Slider(
                key: const ValueKey('background-pane-opacity'),
                value: value.paneOpacity,
                min: AppearancePrefs.paneOpacityMin,
                divisions: 20,
                label: percent,
                onChanged: prefs.setPaneOpacity,
              ),
            ),
            SizedBox(
              width: 44,
              child: Text(
                percent,
                textAlign: TextAlign.end,
                style: grid.AppType.label(color: grid.AppPalette.textSecondary),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
