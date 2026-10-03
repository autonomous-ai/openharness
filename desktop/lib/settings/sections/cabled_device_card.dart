import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_select_field.dart';
import '../../shared/widgets/setting_row.dart';
import '../../state/dial_status.dart';

/// The robot on a cable at this desk, and everything it persists.
///
/// It lives in Settings ▸ Autonomous robots rather than in a section of its own because somebody
/// looking for their robot's settings looks under "Autonomous robots"; what sits below it is a
/// different thing wearing the same word — robots paired over the network, managed through the CLI.
///
/// **The pane says which robot it is changing, out loud and first.** That is not decoration. These
/// rows look exactly like the app's own preferences — same [SettingRow], same controls, same column —
/// and read as settings for *Harness* unless something says otherwise. So the first thing on the
/// pane is "These settings apply to" and a card naming the robot, what it is running and whether it
/// is here. With two on the desk that card is also the picker, because a setting belongs to one
/// robot: reading them as account-wide would silently overwrite one device with the other's taste
/// the first time somebody touched a row.
///
/// Two more rules it is built on:
///
/// * **The device owns the values.** Nothing is written here optimistically. A change is sent and the
///   pane moves when the device answers with what it now holds, so a refusal corrects the window
///   instead of leaving it showing its own hope.
/// * **Read-only while unplugged.** The rows stay — a person should be able to read what their robot
///   is set to with it in a drawer — but nothing can be changed, because there is nothing on the
///   other end to agree.
class CabledDeviceCard extends StatefulWidget {
  const CabledDeviceCard({
    super.key,
    required this.devices,
    required this.onChanged,
    this.showCompanion = false,
  });

  /// Every robot on this desk, plugged in or lately seen.
  final List<DialStatus> devices;
  final bool showCompanion;

  /// Send a patch to one robot. Only the named field travels.
  final void Function(String id, Map<String, Object?> patch) onChanged;

  @override
  State<CabledDeviceCard> createState() => _CabledDeviceCardState();
}

class _CabledDeviceCardState extends State<CabledDeviceCard> {
  /// Which robot the rows below are about. Held by identity rather than index so a device going away
  /// does not silently hand the rows to its neighbour.
  String? _selected;

  DialStatus? get _device {
    if (widget.devices.isEmpty) return null;
    for (final device in widget.devices) {
      if (device.id != null && device.id == _selected) return device;
    }
    // Prefer one that is actually here: a pane opening on the robot in the drawer while another is
    // plugged in would be read-only for no reason a person could see.
    for (final device in widget.devices) {
      if (device.attached) return device;
    }
    return widget.devices.first;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final device = _device;
    if (device == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 2, bottom: 8),
          child: Text(
            'These settings apply to',
            style: theme.textTheme.bodySmall,
          ),
        ),
        for (final each in widget.devices) ...[
          _DeviceChip(
            device: each,
            selected: each.id != null && each.id == device.id,
            // A single robot is a statement, not a choice: the card still names it, but tapping it
            // would suggest there is something else to tap.
            onTap: widget.devices.length > 1 && each.id != null
                ? () => setState(() => _selected = each.id)
                : null,
          ),
          const SizedBox(height: 8),
        ],
        const SizedBox(height: 6),
        _Rows(
          device: device,
          onChanged: widget.onChanged,
          showCompanion: widget.showCompanion,
        ),
      ],
    );
  }
}

/// One robot, named: what it is, what it runs, and whether it is here.
class _DeviceChip extends StatelessWidget {
  const _DeviceChip({
    required this.device,
    required this.selected,
    required this.onTap,
  });

  final DialStatus device;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final theme = Theme.of(context);
    final settings = device.settings;
    final detail = [
      if (settings != null)
        '${settings.face} ${settings.round ? 'round' : 'square'}',
      if (device.fw case final fw?) 'habitat $fw',
      ?device.mac,
    ].join(' · ');
    return Semantics(
      selected: selected,
      button: onTap != null,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: grid.AppGlass.surfaceFill,
              borderRadius: BorderRadius.circular(14),
              boxShadow: grid.AppGlass.cardShadow,
              border: Border.all(
                color: selected
                    ? theme.colorScheme.primary
                    : theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
                width: selected ? 1.6 : 1,
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(device.name, style: theme.textTheme.titleSmall),
                      if (detail.isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(detail, style: theme.textTheme.bodySmall),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  device.attached ? 'connected' : 'unplugged',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: device.attached
                        ? theme.colorScheme.primary
                        : theme.textTheme.bodySmall?.color,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The settings themselves, grouped the way a person looks for them rather than the way the device
/// stores them: what it looks like, how it answers a finger, and what it says out loud.
class _Rows extends StatelessWidget {
  const _Rows({
    required this.device,
    required this.onChanged,
    required this.showCompanion,
  });

  final DialStatus device;
  final bool showCompanion;
  final void Function(String id, Map<String, Object?> patch) onChanged;

  /// The languages the microphone can be transcribed as, each named in itself. The codes are what
  /// the dial sends with every capture and what the backend accepts — VOICE_LANGS in
  /// backend/src/lib/deepgram.ts; edit the two together, or a language offered here is quietly
  /// transcribed as English there. The LVGL firmware offered the same six.
  static const _voiceLangs = [
    SelectOption(value: 'en', label: 'English'),
    SelectOption(value: 'vi', label: 'Tiếng Việt'),
    SelectOption(value: 'es', label: 'Español'),
    SelectOption(value: 'fr', label: 'Français'),
    SelectOption(value: 'ja', label: '日本語'),
    SelectOption(value: 'it', label: 'Italiano'),
  ];

  /// Whether the robot offers a choice of who is on the screen. Off while the companion skins are
  /// unfinished (owner, 2026-09-30): the firmware wears Focus whatever it is asked, so a Skin row or a
  /// companion switch would be a control that does nothing. Flip it with HABITAT_FOCUS_ONLY.
  static const _petSkins = false;

  /// The characters this firmware ships. Ids are the device's own, from character.h.
  static const _skins = [
    SelectOption(value: 0, label: 'Tim', note: 'The octopus'),
    SelectOption(value: 1, label: 'Tux', note: 'The penguin'),
    SelectOption(value: 2, label: 'Focus', note: 'No companion — the work'),
  ];

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final settings = device.settings;
    final id = device.id;
    if (settings == null) {
      return SettingRow(
        title: 'This robot has not said what it holds yet.',
        detail: device.fw == null
            ? 'It is still greeting the daemon.'
            : 'Its firmware (${device.fw}) keeps its settings on the glass.',
        control: const SizedBox(width: SettingRow.controlWidth),
      );
    }
    // No id means a daemon that predates per-device addressing: it can report, but nothing here can be
    // addressed to a particular robot, so the rows are readable and not writable.
    final live = device.attached && id != null;
    void set(Map<String, Object?> patch) {
      if (live) onChanged(id, patch);
    }

    Widget toggle(
      String key,
      bool value,
      String label, {
      bool invert = false,
    }) => Semantics(
      label: label,
      child: Align(
        alignment: Alignment.centerLeft,
        child: Switch(
          key: ValueKey('device-$key-${device.id ?? device.mac ?? ''}'),
          value: invert ? !value : value,
          onChanged: live ? (on) => set({key: invert ? !on : on}) : null,
        ),
      ),
    );

    Widget field<T>(
      T value,
      List<SelectOption<T>> options,
      void Function(T) apply,
    ) => SizedBox(
      width: SettingRow.controlWidth,
      child: AppSelectField<T>(
        value: value,
        options: options,
        onChanged: live ? apply : (_) {},
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!device.attached) ...[
          SettingRow(
            title: 'Unplugged',
            detail: 'These are the settings it last reported. Plug it in to change them.',
            control: const SizedBox(width: SettingRow.controlWidth),
          ),
          const SizedBox(height: 10),
        ],
        _Group(
          title: 'Appearance',
          children: [
            if (_petSkins && showCompanion && settings.followCompanion != null)
              SettingRow(
                title: 'Follow desktop companion',
                detail: settings.companion == null
                    ? 'Show the companion paired in your Zoo.'
                    : 'Showing ${settings.companion == 'gnu' ? 'GNU' : settings.companion!} from your Zoo.',
                control: toggle(
                  'followCompanion',
                  settings.followCompanion!,
                  'Follow desktop companion',
                ),
              ),
            if (_petSkins)
              SettingRow(
                title: 'Skin',
                detail: settings.companion == null
                    ? 'Who lives on the screen.'
                    : 'Used when you stop following the desktop companion.',
                control: field(
                  settings.character,
                  _skins,
                  (v) => set({'character': v}),
                ),
              ),
            SettingRow(
              title: 'Brightness',
              detail: '${settings.brightness}%',
              control: SizedBox(
                width: SettingRow.controlWidth,
                child: Slider(
                  key: ValueKey('device-brightness-${device.id ?? ''}'),
                  value: settings.brightness.toDouble(),
                  min: 0,
                  max: 100,
                  divisions: 20,
                  // On change END, not on every frame: each one is a frame over the cable and a write to
                  // the device's flash, and a dragged slider would spend a thousand of both.
                  onChanged: live ? (_) {} : null,
                  onChangeEnd: live
                      ? (v) => set({'brightness': v.round()})
                      : null,
                ),
              ),
            ),
            SettingRow(
              title: 'Still companion',
              detail: 'Stops the artwork animating. Nothing else changes.',
              control: toggle('quiet', settings.quiet, 'Still companion'),
            ),
            // No Edge text row: the robot draws its titles straight across (owner, 2026-10-01), and
            // a Focus-only firmware ignores the field — a choice here would change nothing.
          ],
        ),
        _Group(
          title: 'Gestures',
          children: [
            SettingRow(
              title: 'Reverse scrolling',
              detail: 'Which way a drag moves the text under it.',
              control: field(settings.scrollReversed, const [
                SelectOption(
                  value: false,
                  label: 'Natural',
                  note: 'The text follows your finger',
                ),
                SelectOption(
                  value: true,
                  label: 'Reversed',
                  note: 'The view follows your finger',
                ),
              ], (v) => set({'scrollReversed': v})),
            ),
          ],
        ),
        _Group(
          title: 'Sound & voice',
          children: [
            SettingRow(
              title: 'Notification sound',
              detail: 'The chime when a turn finishes or a question arrives.',
              // Stated as "sound on", which is what the switch position means to a person; the wire
              // field is its opposite, and the flip belongs here rather than in anyone's head.
              control: toggle(
                'muted',
                settings.muted,
                'Notification sound',
                invert: true,
              ),
            ),
            SettingRow(
              title: 'Voice language',
              detail:
                  'What the microphone is transcribed as. The robot’s own choice, not this '
                  'computer’s.',
              control: field(
                _voiceLangs.any((o) => o.value == settings.voiceLang)
                    ? settings.voiceLang
                    : 'en',
                _voiceLangs,
                (v) => set({'voiceLang': v}),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// A run of rows under a caption. The grouping is presentation only, but it says something true:
/// what the robot looks like, how it answers a finger, and what it says out loud.
class _Group extends StatelessWidget {
  const _Group({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    if (children.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 2, top: 10, bottom: 8),
          child: Text(title, style: Theme.of(context).textTheme.labelLarge),
        ),
        for (final child in children) ...[child, const SizedBox(height: 10)],
      ],
    );
  }
}
