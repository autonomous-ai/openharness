import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import 'device_artwork.dart';
import 'devices_controller.dart';

Future<String?> showDeviceSetup(
  BuildContext context,
  DevicesController controller, {
  HarnessDevice? editing,
}) => showAppDialog<String>(
  context: context,
  builder: (_) => _DeviceSetup(controller: controller, editing: editing),
);

class _DeviceSetup extends StatefulWidget {
  const _DeviceSetup({required this.controller, this.editing});
  final DevicesController controller;
  final HarnessDevice? editing;
  @override
  State<_DeviceSetup> createState() => _DeviceSetupState();
}

class _DeviceSetupState extends State<_DeviceSetup> {
  late final _name = TextEditingController(text: widget.editing?.name ?? '');
  late final Set<String> _initial;
  late var _model = widget.editing?.model ?? HarnessDeviceModel.harness;
  String? _selected, _validation;

  @override
  void initState() {
    super.initState();
    _initial = widget.controller.devices.map((d) => d.key).toSet();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _finish(HarnessDevice device) {
    final name = _name.text.trim().isEmpty ? device.name : _name.text.trim();
    if (name.length > 60) {
      setState(() => _validation = 'Use 60 characters or fewer.');
      return;
    }
    widget.controller.rename(device.key, name, _model);
    Navigator.of(context).pop(device.key);
  }

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 500),
        child: DesktopDialogSurface(
          child: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: ListenableBuilder(
                listenable: widget.controller,
                builder: (context, _) {
                  final connected = widget.controller.devices
                      .where(
                        (d) =>
                            d.hostOnline &&
                            d.hostAvailable &&
                            d.status.attached,
                      )
                      .toList();
                  final selected =
                      widget.editing ??
                      connected.where((d) => d.key == _selected).firstOrNull ??
                      connected
                          .where((d) => !_initial.contains(d.key))
                          .firstOrNull;
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      DesktopDialogHeader(
                        title: widget.editing == null
                            ? 'Add a device'
                            : 'Device details',
                        padding: EdgeInsets.zero,
                        onClose: () => Navigator.of(context).pop(),
                      ),
                      if (widget.editing == null) ...[
                        const SizedBox(height: 20),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(16),
                          child: const SizedBox(
                            height: 172,
                            child: DeviceArtwork(side: true),
                          ),
                        ),
                        const SizedBox(height: 20),
                        Text(
                          'Plug in. Make it yours.',
                          style: DesktopChrome.heading(),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Connect your device by USB-C to any computer in your account. Keep Harness running on that computer; the device will appear here automatically.',
                          style: DesktopChrome.text(color: DesktopChrome.muted),
                        ),
                        const SizedBox(height: 20),
                      ] else
                        const SizedBox(height: 20),
                      Text('Model', style: DesktopChrome.control(medium: true)),
                      const SizedBox(height: 6),
                      AppSelectField<HarnessDeviceModel>(
                        semanticLabel: 'Device model',
                        value: _model,
                        options: [
                          for (final model in HarnessDeviceModel.values)
                            SelectOption(value: model, label: model.label),
                        ],
                        onChanged: (value) => setState(() => _model = value),
                      ),
                      if (widget.editing == null) ...[
                        const SizedBox(height: 18),
                        if (connected.isEmpty)
                          Semantics(
                            liveRegion: true,
                            child: Text(
                              'Waiting for a USB connection…',
                              style: DesktopChrome.text(
                                color: DesktopChrome.muted,
                              ),
                            ),
                          )
                        else ...[
                          Text(
                            'Connected devices',
                            style: DesktopChrome.control(medium: true),
                          ),
                          const SizedBox(height: 6),
                          for (final device in connected)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              title: Text(device.name),
                              subtitle: Text(
                                '${device.machineName} · ${device.status.mac ?? device.status.id ?? 'USB device'}',
                              ),
                              trailing: Icon(
                                selected?.key == device.key
                                    ? AppIcons.circleCheck
                                    : AppIcons.circle,
                                size: 20,
                                color: selected?.key == device.key
                                    ? DesktopChrome.accent
                                    : DesktopChrome.muted,
                              ),
                              onTap: () =>
                                  setState(() => _selected = device.key),
                              selected: selected?.key == device.key,
                            ),
                        ],
                      ],
                      if (selected != null) ...[
                        const SizedBox(height: 18),
                        TextField(
                          controller: _name,
                          autofocus: widget.editing != null,
                          maxLength: 60,
                          textInputAction: TextInputAction.done,
                          decoration: InputDecoration(
                            labelText: 'Device name',
                            hintText: selected.name,
                            errorText: _validation,
                            counterText: '',
                          ),
                          onSubmitted: (_) => _finish(selected),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Name and model are saved on this computer.',
                          style: DesktopChrome.metadata(),
                        ),
                      ] else ...[
                        const SizedBox(height: 12),
                        Text(
                          'Not appearing? Try a data cable instead of a charging-only cable, or connect directly to a USB port.',
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                      const SizedBox(height: 24),
                      Wrap(
                        alignment: WrapAlignment.end,
                        spacing: 10,
                        runSpacing: 8,
                        children: [
                          TextButton(
                            onPressed: () => Navigator.of(context).pop(),
                            child: const Text('Cancel'),
                          ),
                          FilledButton(
                            onPressed: selected == null
                                ? null
                                : () => _finish(selected),
                            child: Text(
                              widget.editing == null ? 'Finish setup' : 'Save',
                            ),
                          ),
                        ],
                      ),
                    ],
                  );
                },
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
