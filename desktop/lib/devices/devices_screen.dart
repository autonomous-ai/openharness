import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../shared/widgets/app_icon_button.dart';
import '../core/test_run.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'device_artwork.dart';
import 'device_settings.dart';
import 'device_setup_dialog.dart';
import 'devices_controller.dart';

final harnessDeviceShopUrl = Uri.parse(
  'https://www.autonomous.ai/harness-device',
);

class DevicesTab extends StatefulWidget {
  const DevicesTab({super.key, required this.notifier});
  final AppNotifier notifier;
  @override
  State<DevicesTab> createState() => _DevicesTabState();
}

class _DevicesTabState extends State<DevicesTab> {
  late final controller = DevicesController(
    hosts: widget.notifier.deviceHosts,
    accountId: widget.notifier.currentUser?.id ?? 'guest',
    storage: widget.notifier.deviceLibraryStorage,
    sendHostSettings: widget.notifier.setHostDeviceSettings,
  );
  Timer? _refresh;
  @override
  void initState() {
    super.initState();
    unawaited(widget.notifier.refreshDevices());
    if (!kUnderTest) {
      _refresh = Timer.periodic(
        const Duration(seconds: 10),
        (_) => unawaited(widget.notifier.refreshDevices()),
      );
    }
  }

  @override
  void dispose() {
    _refresh?.cancel();
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => DevicesScreen(
    controller: controller,
    onRefresh: widget.notifier.refreshDevices,
  );
}

class DevicesScreen extends StatefulWidget {
  const DevicesScreen({
    super.key,
    required this.controller,
    this.openShop,
    this.onRefresh,
  });
  final DevicesController controller;
  final Future<bool> Function(Uri)? openShop;
  final Future<void> Function()? onRefresh;
  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  String? _selectedKey;
  String? _shopError;
  final _cards = ScrollController();

  @override
  void initState() {
    super.initState();
    unawaited(widget.controller.load());
  }

  @override
  void dispose() {
    _cards.dispose();
    super.dispose();
  }

  Future<void> _shop() async {
    var opened = false;
    try {
      opened =
          await (widget.openShop?.call(harnessDeviceShopUrl) ??
              launchUrl(
                harnessDeviceShopUrl,
                mode: LaunchMode.externalApplication,
              ));
    } catch (_) {
      /* The inline retry remains beside the action. */
    }
    if (mounted) {
      setState(
        () => _shopError = opened ? null : 'Couldn’t open the shop. Try again.',
      );
    }
  }

  Future<void> _setup({HarnessDevice? editing}) async {
    final key = await showDeviceSetup(
      context,
      widget.controller,
      editing: editing,
    );
    if (mounted && key != null) setState(() => _selectedKey = key);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ColoredBox(
      color: grid.AppPalette.windowBg,
      child: ListenableBuilder(
        listenable: widget.controller,
        builder: (context, _) => LayoutBuilder(
          builder: (context, bounds) {
            // Keep saved identities for reconnection, but only present devices
            // whose host has answered. Other machines do not belong in this UI.
            final devices = widget.controller.devices
                .where((device) => device.hostOnline && device.hostAvailable)
                .toList();
            final selected =
                devices.where((d) => d.key == _selectedKey).firstOrNull ??
                devices.where((d) => d.status.attached).firstOrNull ??
                devices.firstOrNull;
            _selectedKey = selected?.key;
            final pad = bounds.maxWidth < 640 ? 20.0 : 40.0;
            return SingleChildScrollView(
              key: const PageStorageKey('devices-page'),
              padding: EdgeInsets.fromLTRB(pad, 36, pad, 40),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1120),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Wrap(
                        alignment: WrapAlignment.spaceBetween,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 24,
                        runSpacing: 18,
                        children: [
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Devices', style: grid.AppType.display()),
                              const SizedBox(height: 7),
                              Text(
                                'All your devices. Across your computers.',
                                style: DesktopChrome.text(
                                  color: DesktopChrome.muted,
                                ),
                              ),
                            ],
                          ),
                          Wrap(
                            spacing: 10,
                            runSpacing: 10,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: [
                              if (widget.onRefresh != null)
                                AppIconButton(
                                  tooltip: 'Refresh devices',
                                  onPressed: widget.onRefresh,
                                  icon: AppIcons.refreshCw,
                                ),
                              TextButton(
                                onPressed: _shop,
                                child: const Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Text('Shop'),
                                    SizedBox(width: 7),
                                    Icon(AppIcons.arrowUpRight, size: 16),
                                  ],
                                ),
                              ),
                              FilledButton.icon(
                                key: const Key('devices-add'),
                                onPressed: () => _setup(),
                                icon: const Icon(AppIcons.plus, size: 16),
                                label: const Text('Add device'),
                              ),
                            ],
                          ),
                        ],
                      ),
                      if (_shopError != null) ...[
                        const SizedBox(height: 12),
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            _shopError!,
                            style: DesktopChrome.metadata(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ),
                      ],
                      if (widget.controller.error case final error?) ...[
                        const SizedBox(height: 16),
                        Wrap(
                          crossAxisAlignment: WrapCrossAlignment.center,
                          spacing: 12,
                          children: [
                            Text(error, style: DesktopChrome.metadata()),
                            TextButton(
                              onPressed: widget.controller.retrySave,
                              child: const Text('Retry'),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 32),
                      if (!widget.controller.loaded)
                        const SkeletonBlock(
                          child: Skeleton(
                            width: double.infinity,
                            height: 320,
                            radius: 18,
                          ),
                        )
                      else if (selected == null)
                        _EmptyDevices(
                          onAdd: () => _setup(),
                          onShop: _shop,
                          returning: widget.controller.devices.isNotEmpty,
                        )
                      else ...[
                        Text(
                          '${devices.length} ${devices.length == 1 ? 'device' : 'devices'}',
                          style: DesktopChrome.metadata(),
                        ),
                        const SizedBox(height: 12),
                        LayoutBuilder(
                          builder: (context, constraints) {
                            final scale = MediaQuery.textScalerOf(context)
                                .scale(1);
                            final cardWidth = math.max(
                              194.0,
                              math.min(220.0, (constraints.maxWidth - 64) / 5),
                            );
                            return Scrollbar(
                              controller: _cards,
                              child: SingleChildScrollView(
                                controller: _cards,
                                scrollDirection: Axis.horizontal,
                                padding: const EdgeInsets.only(bottom: 14),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    for (
                                      var i = 0;
                                      i < devices.length;
                                      i++
                                    ) ...[
                                      if (i > 0) const SizedBox(width: 16),
                                      SizedBox(
                                        width: cardWidth * math.min(scale, 1.4),
                                        child: _DeviceCard(
                                          device: devices[i],
                                          selected:
                                              devices[i].key == selected.key,
                                          onPressed: () => setState(
                                            () => _selectedKey = devices[i].key,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                        const SizedBox(height: 22),
                        Divider(color: DesktopChrome.rim, height: 1),
                        const SizedBox(height: 26),
                        Wrap(
                          alignment: WrapAlignment.spaceBetween,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          spacing: 20,
                          runSpacing: 8,
                          children: [
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  selected.name,
                                  style: grid.AppType.title(),
                                ),
                                const SizedBox(height: 5),
                                Text(
                                  '${selected.model.label} · ${selected.machineName} · ${selected.connectionLabel}',
                                  style: DesktopChrome.metadata(),
                                ),
                              ],
                            ),
                            TextButton(
                              onPressed: () => _setup(editing: selected),
                              child: const Text('Edit details'),
                            ),
                          ],
                        ),
                        const SizedBox(height: 24),
                        LayoutBuilder(
                          builder: (context, constraints) {
                            final showcase = _DeviceShowcase(device: selected);
                            final settings = DeviceSettingsPanel(
                              key: ValueKey(selected.key),
                              device: selected,
                              controller: widget.controller,
                            );
                            if (constraints.maxWidth < 850 ||
                                MediaQuery.textScalerOf(context).scale(1) >
                                    1.5) {
                              return Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  showcase,
                                  const SizedBox(height: 24),
                                  settings,
                                ],
                              );
                            }
                            return Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                SizedBox(width: 340, child: showcase),
                                const SizedBox(width: 36),
                                Expanded(child: settings),
                              ],
                            );
                          },
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _DeviceCard extends StatelessWidget {
  const _DeviceCard({
    required this.device,
    required this.selected,
    required this.onPressed,
  });
  final HarnessDevice device;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Semantics(
    selected: selected,
    button: true,
    label:
        '${device.name}, ${device.model.label}, ${device.machineName}, ${device.connectionLabel}',
    child: Material(
      color: selected ? DesktopChrome.selection : DesktopChrome.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(
          color: selected ? DesktopChrome.accent : DesktopChrome.rim,
          width: selected ? 1.5 : 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: ValueKey('device-card-${device.key}'),
        onTap: onPressed,
        child: ExcludeSemantics(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                height: 116,
                child: DeviceArtwork(
                  closeUp: true,
                  square: device.hasSquareDisplay,
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(15, 13, 15, 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Tooltip(
                            message: device.name,
                            child: Text(
                              device.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: DesktopChrome.text(medium: true),
                            ),
                          ),
                        ),
                        if (selected) ...[
                          const SizedBox(width: 5),
                          Icon(
                            AppIcons.circleCheck,
                            size: 16,
                            color: DesktopChrome.accent,
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(device.model.label, style: DesktopChrome.metadata()),
                    const SizedBox(height: 3),
                    Text(
                      device.machineName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(),
                    ),
                    const SizedBox(height: 9),
                    Text(
                      device.connectionLabel,
                      style: DesktopChrome.metadata(
                        color: device.status.attached
                            ? DesktopChrome.foreground
                            : DesktopChrome.muted,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _DeviceShowcase extends StatelessWidget {
  const _DeviceShowcase({required this.device});
  final HarnessDevice device;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: SizedBox(
          height: 205,
          child: DeviceArtwork(
            side: true,
            closeUp: true,
            square: device.hasSquareDisplay,
          ),
        ),
      ),
      const SizedBox(height: 16),
      Material(
        color: DesktopChrome.surface,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          key: const Key('devices-faces'),
          borderRadius: BorderRadius.circular(14),
          onTap: () => showDeviceFaces(context),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                const FocusFacePreview(size: 52),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Faces', style: DesktopChrome.control(medium: true)),
                      const SizedBox(height: 3),
                      Text('Focus', style: DesktopChrome.metadata()),
                    ],
                  ),
                ),
                Icon(
                  AppIcons.chevronRight,
                  size: 16,
                  color: DesktopChrome.muted,
                ),
              ],
            ),
          ),
        ),
      ),
      const SizedBox(height: 16),
      Text(
        [
          if (device.status.fw != null) 'Firmware ${device.status.fw}',
          if (device.status.settings != null)
            '${device.status.settings!.face} px display',
        ].join(' · '),
        style: DesktopChrome.metadata(),
      ),
      if (device.status.mac ?? device.status.id case final id?) ...[
        const SizedBox(height: 4),
        SelectableText(id, style: DesktopChrome.metadata()),
      ],
    ],
  );
}

class _EmptyDevices extends StatelessWidget {
  const _EmptyDevices({
    required this.onAdd,
    required this.onShop,
    this.returning = false,
  });
  final VoidCallback onAdd, onShop;
  final bool returning;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final copy = Padding(
        padding: const EdgeInsets.all(36),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              returning
                  ? 'No devices connected'
                  : 'A little closer\nto your work.',
              style: grid.AppType.display(),
            ),
            const SizedBox(height: 18),
            Text(
              returning
                  ? 'Connect a device by USB-C to a computer running Harness. It will appear here automatically.'
                  : 'Your agents, at a glance. A quiet chime when they need you. Make a home for every Harness on your desk.',
              style: DesktopChrome.text(color: DesktopChrome.muted),
            ),
            const SizedBox(height: 28),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                FilledButton(
                  onPressed: onAdd,
                  child: Text(
                    returning ? 'Add device' : 'Add your first device',
                  ),
                ),
                TextButton(
                  onPressed: onShop,
                  child: const Text('Shop Harness'),
                ),
              ],
            ),
            const SizedBox(height: 24),
            Text(
              'Have a device? Connect it with a USB-C cable to get started.',
              style: DesktopChrome.metadata(),
            ),
          ],
        ),
      );
      return Material(
        color: DesktopChrome.surface,
        borderRadius: BorderRadius.circular(24),
        clipBehavior: Clip.antiAlias,
        child:
            constraints.maxWidth < 760 ||
                MediaQuery.textScalerOf(context).scale(1) > 1.5
            ? Column(
                children: [
                  const SizedBox(height: 260, child: DeviceArtwork(desk: true)),
                  copy,
                ],
              )
            : Row(
                children: [
                  Expanded(
                    flex: 6,
                    child: SizedBox(
                      height: 440,
                      child: const DeviceArtwork(desk: true),
                    ),
                  ),
                  Expanded(flex: 5, child: copy),
                ],
              ),
      );
    },
  );
}
