import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../shared/widgets/setting_row.dart';
import '../widgets/desktop_chrome.dart';
import 'devices_controller.dart';
import 'pet_settings.dart';

/// Face ids belong to the firmware (character.h), not screen dimensions.
/// Add future faces here only when production firmware can actually select them.
const deviceFaces = [
  SelectOption(value: 2, label: 'Focus', detail: 'Your agents, at a glance.'),
];

class DeviceSettingsPanel extends StatefulWidget {
  const DeviceSettingsPanel({
    super.key,
    required this.device,
    required this.controller,
    this.petEditor,
    this.petViewerBeside = false,
    this.petKey,
    this.petGap = 0,
    this.pickPetFile,
  });
  final HarnessDevice device;
  final DevicesController controller;

  /// The dial's pet edit, when the screen shares it with a viewer of its own.
  final PetEditor? petEditor;

  /// Whether the screen draws [petEditor]'s row viewer beside this panel, so
  /// the Pet section leaves it out.
  final bool petViewerBeside;

  /// Marks the Pet section, so the screen can line the viewer up with it.
  final Key? petKey;

  /// Extra room above the Pet section, so it starts level with the viewer
  /// beside it.
  final double petGap;

  /// Replaces the pet file chooser (tests).
  final Future<String?> Function()? pickPetFile;
  @override
  State<DeviceSettingsPanel> createState() => _DeviceSettingsPanelState();
}

class _DeviceSettingsPanelState extends State<DeviceSettingsPanel> {
  double? _brightness;

  @override
  void didUpdateWidget(DeviceSettingsPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.device.key != widget.device.key || !widget.device.canEdit) {
      _brightness = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final device = widget.device;
    final settings = device.status.settings;
    final controller = widget.controller;
    if (settings == null) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          device.status.attached
              ? 'Waiting for your device’s settings. If they don’t appear, check that its firmware is up to date.'
              : 'Connect this device to see its settings.',
          style: DesktopChrome.text(color: DesktopChrome.muted),
        ),
      );
    }
    final enabled = device.canEdit && !controller.saving(device.key);
    void change(Map<String, Object?> patch) {
      controller.update(device.key, patch);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!device.hostOnline ||
            !device.hostAvailable ||
            !device.status.attached ||
            device.status.updating != null ||
            device.status.id == null) ...[
          Text(
            !device.hostOnline
                ? '${device.machineName} is offline. Showing last reported settings.'
                : !device.hostAvailable
                ? 'Reconnect or update Harness on ${device.machineName} to change settings.'
                : device.status.updating != null
                ? 'Updating to ${device.status.updating}. Keep your device connected.'
                : device.status.attached
                ? 'Update the Harness app and reconnect to change settings.'
                : 'Showing saved settings. Connect this device to ${device.machineName} to make changes.',
            style: DesktopChrome.text(color: DesktopChrome.muted),
          ),
          const SizedBox(height: 16),
        ],
        SettingRow(
          title: 'Brightness',
          detail: '${(_brightness ?? settings.brightness).round()}%',
          controlSemanticLabel: 'Device brightness',
          control: SizedBox(
            width: SettingRow.controlWidth,
            child: Slider(
              key: ValueKey('devices-brightness-${device.key}'),
              value: _brightness ?? settings.brightness.toDouble(),
              min: 0,
              max: 100,
              divisions: 20,
              semanticFormatterCallback: (value) => '${value.round()} percent',
              onChanged: enabled
                  ? (value) => setState(() => _brightness = value)
                  : null,
              onChangeEnd: enabled
                  ? (value) {
                      setState(() => _brightness = null);
                      change({'brightness': value.round()});
                    }
                  : null,
            ),
          ),
        ),
        const SizedBox(height: 10),
        SettingRow(
          title: 'Sound',
          detail: 'A quiet chime when your attention is needed.',
          controlSemanticLabel: 'Device sound',
          control: Switch(
            key: ValueKey('devices-sound-${device.key}'),
            value: !settings.muted,
            onChanged: enabled ? (value) => change({'muted': !value}) : null,
          ),
        ),
        const SizedBox(height: 10),
        SettingRow(
          title: 'Reverse scrolling',
          detail: 'Change the direction of a vertical swipe.',
          controlSemanticLabel: 'Reverse scrolling',
          control: Switch(
            key: ValueKey('devices-scroll-${device.key}'),
            value: settings.scrollReversed,
            onChanged: enabled
                ? (value) => change({'scrollReversed': value})
                : null,
          ),
        ),
        const SizedBox(height: 10),
        SettingRow(
          title: 'Voice language',
          detail: 'The language you speak to this device.',
          control: SizedBox(
            width: SettingRow.controlWidth,
            child: enabled
                ? AppSelectField<String>(
                    semanticLabel: 'Device voice language',
                    value: settings.voiceLang,
                    options: [
                      const SelectOption(value: 'en', label: 'English'),
                      const SelectOption(value: 'vi', label: 'Tiếng Việt'),
                      const SelectOption(value: 'es', label: 'Español'),
                      const SelectOption(value: 'fr', label: 'Français'),
                      const SelectOption(value: 'ja', label: '日本語'),
                      const SelectOption(value: 'it', label: 'Italiano'),
                      if (!const [
                        'en',
                        'vi',
                        'es',
                        'fr',
                        'ja',
                        'it',
                      ].contains(settings.voiceLang))
                        SelectOption(
                          value: settings.voiceLang,
                          label: settings.voiceLang,
                        ),
                    ],
                    onChanged: (value) => change({'voiceLang': value}),
                  )
                : Text(
                    _languageLabel(settings.voiceLang),
                    style: DesktopChrome.control(),
                  ),
          ),
        ),
        SizedBox(height: 10 + widget.petGap),
        KeyedSubtree(
          key: widget.petKey,
          child: PetSettingsSection(
            device: device,
            controller: controller,
            editor: widget.petEditor,
            showViewer: !widget.petViewerBeside,
            pickFile: widget.pickPetFile,
          ),
        ),
        const SizedBox(height: 12),
        Semantics(
          liveRegion: true,
          child: Text(
            controller.saving(device.key)
                ? 'Saving to ${device.name}…'
                : controller.deviceError(device.key) ??
                      'Settings are saved on this device.',
            style: DesktopChrome.metadata(
              color: controller.deviceError(device.key) == null
                  ? DesktopChrome.muted
                  : Theme.of(context).colorScheme.error,
            ),
          ),
        ),
      ],
    );
  }
}

String _languageLabel(String code) =>
    const {
      'en': 'English',
      'vi': 'Tiếng Việt',
      'es': 'Español',
      'fr': 'Français',
      'ja': '日本語',
      'it': 'Italiano',
    }[code] ??
    code;

Future<void> showDeviceFaces(BuildContext context) => showAppDialog<void>(
  context: context,
  builder: (context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: DesktopDialogSurface(
          child: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  DesktopDialogHeader(
                    title: 'Faces',
                    padding: EdgeInsets.zero,
                    onClose: () => Navigator.of(context).pop(),
                  ),
                  const SizedBox(height: 28),
                  for (final face in deviceFaces) ...[
                    const Center(child: FocusFacePreview()),
                    const SizedBox(height: 22),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(face.label, style: DesktopChrome.heading()),
                        const SizedBox(width: 8),
                        Icon(
                          AppIcons.circleCheck,
                          color: DesktopChrome.accent,
                          size: 20,
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      face.detail!,
                      textAlign: TextAlign.center,
                      style: DesktopChrome.text(color: DesktopChrome.muted),
                    ),
                  ],
                  const SizedBox(height: 20),
                  Text(
                    'Focus is the included face. New faces will appear here as they become available.',
                    textAlign: TextAlign.center,
                    style: DesktopChrome.metadata(),
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Done'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

/// A quiet, schematic preview, not fabricated live agent telemetry.
class FocusFacePreview extends StatelessWidget {
  const FocusFacePreview({super.key, this.size = 156});
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: const Color(0xff141414),
      shape: BoxShape.circle,
      border: Border.all(color: const Color(0xff393939), width: 3),
    ),
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            AppIcons.circle,
            size: size * .16,
            color: const Color(0xffbababa),
          ),
          SizedBox(height: size * .065),
          Text(
            'Focus',
            style: DesktopChrome.text(
              color: Colors.white,
              size: size * .14,
              medium: true,
            ),
          ),
        ],
      ),
    ),
  );
}
