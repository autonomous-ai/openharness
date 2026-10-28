import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'identity.dart';
import 'model.dart';
import 'swarm_face.dart';
import 'swarm_profile.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// One photo from the person's library, or null when they back out. Asked
/// no larger than an avatar needs, so a 12-megapixel photo is never decoded
/// whole on the phone.
Future<Uint8List?> pickSwarmPhoto() async {
  final picked = await ImagePicker().pickImage(
    source: ImageSource.gallery,
    maxWidth: 1024,
    maxHeight: 1024,
  );
  return picked?.readAsBytes();
}

/// The person's own profile in the Swarm [swarmId], in a sheet over the
/// page: a built-in picture or a photo of theirs, and a status that clears
/// when they say — the desktop's profile (`profile_sheet.dart`) in the
/// phone's own way.
Future<void> showSwarmProfile(
  BuildContext context, {
  required String swarmId,
  Future<Uint8List?> Function() pickPhoto = pickSwarmPhoto,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  backgroundColor: AppGlass.rowFill,
  barrierColor: Colors.black.withValues(alpha: .55),
  shape: const RoundedRectangleBorder(
    borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
  ),
  // On the page's own navigator, under the shell's [SwarmScope].
  builder: (_) => SwarmProfileSheet(swarmId: swarmId, pickPhoto: pickPhoto),
);

/// When a status clears itself.
enum _Clears {
  never('Never'),
  hour('1 hour'),
  four('4 hours'),
  today('Today');

  const _Clears(this.label);
  final String label;

  DateTime? from(DateTime now) => switch (this) {
    never => null,
    hour => now.add(const Duration(hours: 1)),
    four => now.add(const Duration(hours: 4)),
    today => () {
      final local = now.toLocal();
      return DateTime(local.year, local.month, local.day + 1);
    }(),
  };
}

/// What [showSwarmProfile] shows.
class SwarmProfileSheet extends StatefulWidget {
  const SwarmProfileSheet({
    super.key,
    required this.swarmId,
    this.pickPhoto = pickSwarmPhoto,
  });

  final String swarmId;
  final Future<Uint8List?> Function() pickPhoto;

  @override
  State<SwarmProfileSheet> createState() => _SwarmProfileSheetState();
}

class _SwarmProfileSheetState extends State<SwarmProfileSheet> {
  final _text = TextEditingController();
  String? _emoji;
  _Clears _clears = _Clears.never;

  /// The editor took the person's status once, when it was first read.
  bool _seeded = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _run(Future<String?> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await action();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  Future<void> _photo(SwarmProfile profile) async {
    final Uint8List? picked;
    try {
      picked = await widget.pickPhoto();
    } on PlatformException {
      if (mounted) setState(() => _error = 'Could not open your photos.');
      return;
    }
    // Null is the person backing out, not a failure.
    if (picked == null || !mounted) return;
    await _run(() => profile.uploadAvatar(picked!));
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final inbox = SwarmScope.of(context)?.inbox;
    final upload = SwarmScope.uploadAvatarOf(context);
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .9,
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          // Above the keyboard while the status is typed.
          padding: EdgeInsets.fromLTRB(
            14,
            8,
            14,
            16 + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: inbox == null
              ? const SizedBox.shrink()
              : ListenableBuilder(
                  listenable: inbox,
                  builder: (context, _) =>
                      switch (inbox.reader(widget.swarmId)) {
                        final reader? => ListenableBuilder(
                          listenable: reader,
                          builder: (context, _) =>
                              _sheet(context, reader, upload),
                        ),
                        null => _sheet(context, null, null),
                      },
                ),
        ),
      ),
    );
  }

  Widget _sheet(
    BuildContext context,
    SwarmReader? reader,
    SwarmAvatarUpload? upload,
  ) {
    final me = reader?.snapshot?.person(reader.accountId);
    final profile = reader == null
        ? null
        : SwarmProfile(reader: reader, upload: upload);
    final now = clock.now();
    final status = me?.statusAt(now);
    if (me != null && !_seeded) {
      _seeded = true;
      _text.text = status?.text ?? '';
      _emoji = status?.emoji;
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Center(
          child: Container(
            width: 36,
            height: 5,
            margin: const EdgeInsets.only(bottom: 8),
            decoration: BoxDecoration(
              color: AppGlass.hair,
              borderRadius: BorderRadius.circular(3),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 2, 6),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Your profile',
                  style: TextStyle(
                    color: AppPalette.textPrimary,
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              SwarmIconButton(
                key: const ValueKey('swarm-profile-close'),
                icon: LucideIcons.x300,
                label: 'Close',
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
        ),
        Flexible(
          child: me == null || profile == null
              // Not read yet: rows on their way.
              ? SwarmSkeletonRows(id: 'swarm-profile-loading', round: true)
              : SingleChildScrollView(child: _body(me, status, profile)),
        ),
      ],
    );
  }

  Widget _body(
    SuperTabPerson me,
    SuperTabPersonStatus? status,
    SwarmProfile profile,
  ) {
    final name = superTabPersonName(me.email);
    final edit = profile.canEdit && !_busy;
    final current = me.avatar;
    final text = _text.text.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 8, 4, 4),
          child: Row(
            children: [
              SwarmAvatar(
                key: const ValueKey('swarm-profile-face'),
                id: me.id,
                name: name,
                size: 64,
                picture: current,
                status: status,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textPrimary,
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      status?.label ?? 'No status',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textSecondary,
                        fontSize: 14,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        if (!profile.canEdit) _Note('You have read-only access to this Swarm.'),
        const SwarmCaption('Picture'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final MapEntry(:key, :value) in superTabAvatarPresets.entries)
              _Picture(
                key: ValueKey('swarm-avatar-preset-$key'),
                glyph: value,
                label: key,
                selected: current is SuperTabPresetAvatar && current.key == key,
                onTap: edit
                    ? () => _run(
                        () => profile.setAvatar(SuperTabPresetAvatar(key)),
                      )
                    : null,
              ),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (profile.canUpload)
              SwarmButton(
                key: const ValueKey('swarm-avatar-photo'),
                icon: LucideIcons.image300,
                label: 'Choose photo',
                busy: _busy,
                busyLabel: 'Saving…',
                onPressed: edit ? () => unawaited(_photo(profile)) : null,
              ),
            if (current != null)
              SwarmButton(
                key: const ValueKey('swarm-avatar-default'),
                label: 'Use initials',
                style: SwarmButtonStyle.link,
                onPressed: edit
                    ? () => _run(() => profile.setAvatar(null))
                    : null,
              ),
          ],
        ),
        if (!profile.canUpload)
          _Note('Photos can’t be sent from this phone yet. Pick a picture.'),
        const SwarmCaption('Status'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final (emoji, words) in superTabStatusPresets)
              _Chip(
                key: ValueKey('swarm-status-$emoji'),
                label: '$emoji $words',
                selected: _emoji == emoji && text == words,
                onTap: edit
                    ? () => setState(() {
                        _emoji = emoji;
                        _text.text = words;
                      })
                    : null,
              ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          key: const ValueKey('swarm-status-text'),
          controller: _text,
          enabled: edit,
          maxLength: 80,
          textCapitalization: TextCapitalization.sentences,
          style: TextStyle(color: AppPalette.textPrimary, fontSize: 16),
          decoration: InputDecoration(
            hintText: 'What are you up to?',
            hintStyle: TextStyle(color: AppPalette.textFaint),
            filled: true,
            fillColor: AppPalette.swarmField,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide.none,
            ),
          ),
          onChanged: (_) => setState(() {
            // An emoji goes with its own words only.
            if (!superTabStatusPresets.any(
              (p) => p.$1 == _emoji && p.$2 == _text.text.trim(),
            )) {
              _emoji = null;
            }
          }),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 4, 4, 8),
          child: Text(
            'Clears',
            style: TextStyle(color: AppPalette.textSecondary, fontSize: 13),
          ),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final clears in _Clears.values)
              _Chip(
                key: ValueKey('swarm-status-clears-${clears.name}'),
                label: clears.label,
                selected: _clears == clears,
                onTap: edit ? () => setState(() => _clears = clears) : null,
              ),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            if (status != null)
              SwarmButton(
                key: const ValueKey('swarm-status-clear'),
                label: 'Clear status',
                style: SwarmButtonStyle.link,
                onPressed: edit
                    ? () => _run(() async {
                        final error = await profile.setStatus(null);
                        if (error == null && mounted) {
                          _text.clear();
                          _emoji = null;
                        }
                        return error;
                      })
                    : null,
              ),
            const Spacer(),
            SwarmButton(
              key: const ValueKey('swarm-status-save'),
              label: 'Save status',
              style: SwarmButtonStyle.fill,
              onPressed: edit && text.isNotEmpty
                  ? () => _run(
                      () => profile.setStatus(
                        SuperTabPersonStatus(
                          text: text,
                          emoji: _emoji,
                          until: _clears.from(clock.now()),
                        ),
                      ),
                    )
                  : null,
            ),
          ],
        ),
        if (_error case final error?)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
            child: Text(
              error,
              key: const ValueKey('swarm-profile-error'),
              style: TextStyle(color: AppColors.danger, fontSize: 14),
            ),
          ),
      ],
    );
  }
}

/// A quiet line under a section.
class _Note extends StatelessWidget {
  const _Note(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
    child: Text(
      text,
      style: TextStyle(color: AppPalette.textSecondary, fontSize: 13.5),
    ),
  );
}

/// One built-in picture to wear: a 52-point round button, ringed when worn.
class _Picture extends StatelessWidget {
  const _Picture({
    super.key,
    required this.glyph,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String glyph, label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    label: label,
    excludeSemantics: true,
    child: Material(
      color: AppPalette.swarmField,
      shape: CircleBorder(
        side: BorderSide(
          color: selected ? AppPalette.swarmAccent : AppGlass.hair,
          width: selected ? 2 : 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap == null
            ? null
            : () {
                unawaited(HapticFeedback.selectionClick());
                onTap!();
              },
        child: SizedBox.square(
          dimension: 52,
          child: Center(
            child: Text(
              glyph,
              textScaler: TextScaler.noScaling,
              style: const TextStyle(fontSize: 26, height: 1),
            ),
          ),
        ),
      ),
    ),
  );
}

/// A choice in words, 44 points tall, filled when chosen.
class _Chip extends StatelessWidget {
  const _Chip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    child: Material(
      color: selected
          ? AppPalette.swarmAccent.withValues(alpha: .18)
          : AppPalette.swarmField,
      shape: StadiumBorder(
        side: BorderSide(
          color: selected ? AppPalette.swarmAccent : AppGlass.hair,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    color: AppPalette.textPrimary,
                    fontSize: 14.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
