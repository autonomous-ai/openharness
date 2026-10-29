import 'dart:async';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/theme/swarm_tokens_set_a.dart';
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
  return readPickedSwarmPhoto(picked);
}

/// The bytes of a [picked] photo, or null when they backed out. The picker's
/// copy of it in the app's temporary folder is deleted as soon as it is read,
/// so a private photo does not stay on the phone.
Future<Uint8List?> readPickedSwarmPhoto(XFile? picked) async {
  if (picked == null) return null;
  try {
    return await picked.readAsBytes();
  } finally {
    try {
      await File(picked.path).delete();
    } on FileSystemException {
      // Already gone: nothing is left to delete.
    }
  }
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
  barrierColor: SwarmTokensSetA.sheetBarrier,
  shape: AppControl.sheetShape,
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

  /// When the status clears; null keeps the end it has ([_keptUntil]).
  _Clears? _clears = _Clears.never;
  DateTime? _keptUntil;

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
            AppSpace.l,
            AppSpace.s,
            AppSpace.l,
            AppSpace.l + MediaQuery.viewInsetsOf(context).bottom,
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
      if (status?.until case final until?) {
        _keptUntil = until;
        _clears = null;
      }
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The grabber: a capsule as wide as the two largest steps.
        Center(
          child: Container(
            width: AppSpace.xl + AppSpace.m,
            height: AppSpace.xs,
            margin: const EdgeInsets.only(bottom: AppSpace.s),
            decoration: ShapeDecoration(
              color: AppGlass.hair,
              shape: const StadiumBorder(),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.xs,
            0,
            AppSpace.xs,
            AppSpace.s,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Your profile',
                  style: AppType.heading(color: AppPalette.textPrimary),
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
          padding: const EdgeInsets.fromLTRB(
            AppSpace.xs,
            AppSpace.s,
            AppSpace.xs,
            AppSpace.xs,
          ),
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
                      style: AppType.heading(color: AppPalette.textPrimary),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      status?.label ?? 'No status',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.caption(color: AppPalette.textSecondary),
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
          style: AppType.body(color: AppPalette.textPrimary),
          decoration: InputDecoration(
            hintText: 'What are you up to?',
            hintStyle: TextStyle(color: AppPalette.textFaint),
            filled: true,
            fillColor: AppPalette.swarmField,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppControl.radius),
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
          padding: const EdgeInsets.fromLTRB(
            AppSpace.xs,
            AppSpace.xs,
            AppSpace.xs,
            AppSpace.s,
          ),
          child: Text(
            'Clears',
            style: AppType.caption(color: AppPalette.textSecondary),
          ),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (_keptUntil case final until?)
              _Chip(
                key: const ValueKey('swarm-status-clears-kept'),
                label: 'At ${SwarmPersonSheet._time(context, until)}',
                selected: _clears == null,
                onTap: edit ? () => setState(() => _clears = null) : null,
              ),
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
        SwarmButton(
          key: const ValueKey('swarm-status-save'),
          label: 'Save status',
          style: SwarmButtonStyle.fill,
          wide: true,
          onPressed: edit && text.isNotEmpty
              ? () => _run(
                  () => profile.setStatus(
                    SuperTabPersonStatus(
                      text: text,
                      emoji: _emoji,
                      until: switch (_clears) {
                        final clears? => clears.from(clock.now()),
                        null => _keptUntil,
                      },
                    ),
                  ),
                )
              : null,
        ),
        if (status != null) ...[
          const SizedBox(height: 4),
          Center(
            child: SwarmButton(
              key: const ValueKey('swarm-status-clear'),
              label: 'Clear status',
              style: SwarmButtonStyle.link,
              onPressed: edit
                  ? () => _run(() async {
                      final error = await profile.setStatus(null);
                      if (error == null && mounted) {
                        _text.clear();
                        _emoji = null;
                        _keptUntil = null;
                        _clears = _Clears.never;
                      }
                      return error;
                    })
                  : null,
            ),
          ),
        ],
        if (_error case final error?)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.m,
              AppSpace.xs,
              0,
            ),
            child: Text(
              error,
              key: const ValueKey('swarm-profile-error'),
              style: AppType.caption(color: AppColors.danger),
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
    padding: const EdgeInsets.fromLTRB(AppSpace.xs, AppSpace.m, AppSpace.xs, 0),
    child: Text(text, style: AppType.caption(color: AppPalette.textSecondary)),
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
              style: const TextStyle(
                fontSize: AppIconSize.standalone,
                height: 1,
              ),
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
            padding: AppControl.padding,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  style: AppType.caption(color: AppPalette.textPrimary),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// Who the member [personId] of the Swarm [swarmId] is, in a sheet over the
/// page: their face, name, email, role and status while it lasts. One's own
/// has Edit profile, which opens [showSwarmProfile].
Future<void> showSwarmPerson(
  BuildContext context, {
  required String swarmId,
  required String personId,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  backgroundColor: AppGlass.rowFill,
  barrierColor: SwarmTokensSetA.sheetBarrier,
  shape: AppControl.sheetShape,
  builder: (sheet) => SwarmPersonSheet(
    swarmId: swarmId,
    personId: personId,
    onEdit: () {
      Navigator.of(sheet).pop();
      unawaited(showSwarmProfile(context, swarmId: swarmId));
    },
  ),
);

/// What [showSwarmPerson] shows.
class SwarmPersonSheet extends StatelessWidget {
  const SwarmPersonSheet({
    super.key,
    required this.swarmId,
    required this.personId,
    required this.onEdit,
  });

  final String swarmId, personId;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final reader = SwarmScope.of(context)?.inbox.reader(swarmId);
    return SafeArea(
      top: false,
      child: Padding(
        key: const ValueKey('swarm-person'),
        padding: const EdgeInsets.fromLTRB(
          AppSpace.l,
          AppSpace.s,
          AppSpace.l,
          AppSpace.xl,
        ),
        child: reader == null
            ? const SizedBox.shrink()
            : ListenableBuilder(
                listenable: reader,
                builder: (context, _) => _sheet(context, reader),
              ),
      ),
    );
  }

  Widget _sheet(BuildContext context, SwarmReader reader) {
    final person = reader.snapshot?.person(personId);
    final mine = personId == reader.accountId;
    final name = person == null ? 'Someone' : superTabPersonName(person.email);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The grabber: a capsule as wide as the two largest steps.
        Center(
          child: Container(
            width: AppSpace.xl + AppSpace.m,
            height: AppSpace.xs,
            margin: const EdgeInsets.only(bottom: AppSpace.l),
            decoration: ShapeDecoration(
              color: AppGlass.hair,
              shape: const StadiumBorder(),
            ),
          ),
        ),
        if (person == null)
          _Note('They are no longer in this Swarm.')
        else
          SwarmUntil(
            until: person.status?.until,
            builder: (context) {
              final status = person.statusAt(clock.now());
              return Row(
                children: [
                  SwarmAvatar(
                    id: person.id,
                    name: name,
                    size: 64,
                    picture: person.avatar,
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
                          style: AppType.heading(color: AppPalette.textPrimary),
                        ),
                        if (status != null) ...[
                          const SizedBox(height: 2),
                          Text(
                            status.label,
                            style: AppType.body(color: AppPalette.textPrimary),
                          ),
                          if (status.until case final until?)
                            Text(
                              'Clears at ${_time(context, until)}',
                              style: AppType.caption(
                                color: AppPalette.textFaint,
                              ),
                            ),
                        ],
                        const SizedBox(height: 4),
                        Text(
                          person.email,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppType.caption(
                            color: AppPalette.textSecondary,
                          ),
                        ),
                        Text(
                          _role(person.role),
                          style: AppType.caption(color: AppPalette.textFaint),
                        ),
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
        if (mine && person != null && person.canWrite) ...[
          const SizedBox(height: 18),
          SwarmButton(
            key: const ValueKey('swarm-person-edit'),
            label: 'Edit profile',
            style: SwarmButtonStyle.fill,
            wide: true,
            onPressed: onEdit,
          ),
        ],
      ],
    );
  }

  static String _role(String role) => switch (role) {
    'owner' => 'Owner',
    'collaborator' => 'Collaborator',
    'viewer' => 'Viewer',
    _ => role,
  };

  static String _time(BuildContext context, DateTime at) =>
      MaterialLocalizations.of(context).formatTimeOfDay(
        TimeOfDay.fromDateTime(at.toLocal()),
        alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
      );
}
