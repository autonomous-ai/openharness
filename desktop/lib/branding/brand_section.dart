// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/section_heading.dart';
import 'brand_mark.dart';
import 'brand_prefs.dart';
import '../fleet/neon.dart';

/// Picks an image file; replaced in tests.
typedef ImagePicker = Future<String?> Function();

Future<String?> pickSvgOrPng() async {
  final file = await openFile(acceptedTypeGroups: const [XTypeGroup(label: 'SVG or PNG image', extensions: ['svg', 'png'])]);
  return file?.path;
}

/// Settings, Appearance: the boot logo and the avatar shown to agents waiting on you.
class BrandSection extends StatefulWidget {
  const BrandSection({super.key, this.store, this.pick = pickSvgOrPng});

  final BrandPrefsStore? store;
  final ImagePicker pick;

  @override
  State<BrandSection> createState() => _BrandSectionState();
}

class _BrandSectionState extends State<BrandSection> {
  BrandPrefsStore get _store => widget.store ?? brandPrefsStore;
  String? _logoError, _avatarError;
  late final _initials = TextEditingController(text: _store.value.initials);

  @override
  void dispose() {
    _initials.dispose();
    super.dispose();
  }

  Future<void> _pickLogo() async {
    final path = await widget.pick();
    if (path == null) return;
    final error = await _store.setCustomLogo(path);
    if (mounted) setState(() => _logoError = error);
  }

  Future<void> _pickAvatar() async {
    final path = await widget.pick();
    if (path == null) return;
    final error = await _store.setCustomAvatar(path);
    if (mounted) setState(() => _avatarError = error);
  }

  Widget _chip(String label, bool selected, VoidCallback? onTap, {String? tooltip}) {
    final chip = ChoiceChip(label: Text(label), selected: selected, onSelected: onTap == null ? null : (_) => onTap());
    return tooltip == null ? chip : Tooltip(message: tooltip, child: chip);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final neon = Neon.current();
    final muted = TextStyle(fontSize: 12, color: neon.foreground.withValues(alpha: 0.6));
    final error = TextStyle(fontSize: 12, color: neon.red);
    return ValueListenableBuilder<BrandPrefs>(
      valueListenable: _store,
      builder: (context, prefs, _) {
        final logo = _store.resolveBootLogo();
        final avatar = _store.resolveAvatar();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SectionHeading('Boot logo'),
            const SizedBox(height: 6),
            Text('Off by default. Pick a logo to show it for about a second and a half when the app starts; click or press any key to skip it.', style: muted),
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Wrap(spacing: 8, runSpacing: 8, children: [
                    // Offered only where Omarchy is installed: its wordmark is read from the system.
                    if (_store.omarchyAvailable)
                      _chip('Omarchy', logo.kind == BootLogo.omarchy, () => unawaited(_store.setBootLogo(BootLogo.omarchy))),
                    _chip('Harness', logo.kind == BootLogo.harness, () => unawaited(_store.setBootLogo(BootLogo.harness))),
                    _chip('Custom…', logo.kind == BootLogo.custom, () => unawaited(_pickLogo()), tooltip: 'An SVG or PNG, up to 2 MB'),
                    _chip('None', logo.kind == BootLogo.none, () => unawaited(_store.setBootLogo(BootLogo.none))),
                  ]),
                ),
                const SizedBox(width: 16),
                // Preview with the same glow the splash uses.
                Container(
                  width: 200,
                  height: 72,
                  color: neon.background,
                  alignment: Alignment.center,
                  child: logo.kind == BootLogo.none
                      ? Text('no splash', style: muted)
                      : FittedBox(child: Padding(padding: const EdgeInsets.all(14), child: BrandLogo(logo: logo, accent: neon.accent, height: 44))),
                ),
              ],
            ),
            if (_logoError != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_logoError!, style: error)),
            const SizedBox(height: 24),
            const SectionHeading('Your avatar'),
            const SizedBox(height: 6),
            Text('Drawn inside the ring of any agent that is waiting on you.', style: muted),
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                    _chip('Generic', avatar.kind == AvatarSource.generic, () => unawaited(_store.setAvatar(AvatarSource.generic))),
                    _chip('Initials', prefs.avatar == AvatarSource.initials, () => unawaited(_store.setAvatar(AvatarSource.initials))),
                    if (_store.systemAvatarAvailable)
                      _chip('System avatar', avatar.kind == AvatarSource.system, () => unawaited(_store.setAvatar(AvatarSource.system)), tooltip: 'Use ${_store.systemAvatarPath}'),
                    _chip('Custom image…', avatar.kind == AvatarSource.custom, () => unawaited(_pickAvatar()), tooltip: 'An SVG or PNG, up to 2 MB, cropped to a circle'),
                    if (prefs.avatar == AvatarSource.initials)
                      SizedBox(
                        width: 90,
                        child: TextField(
                          controller: _initials,
                          maxLength: 3,
                          decoration: const InputDecoration(isDense: true, counterText: '', hintText: 'AB'),
                          onChanged: (v) => unawaited(_store.setInitials(v)),
                        ),
                      ),
                  ]),
                ),
                const SizedBox(width: 16),
                SizedBox(
                  width: 200,
                  child: Center(
                    child: DecoratedBox(
                      decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: neon.yellow, width: 2)),
                      child: Padding(padding: const EdgeInsets.all(3), child: AvatarBadge(avatar: avatar, size: 40, color: neon.yellow, background: neon.background)),
                    ),
                  ),
                ),
              ],
            ),
            if (_avatarError != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_avatarError!, style: error)),
            const SizedBox(height: 24),
          ],
        );
      },
    );
  }
}
