import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import '../state/dial_status.dart';
import 'device_hosts.dart';

enum HarnessDeviceModel {
  harness('Harness'),
  pro('Harness Pro');

  const HarnessDeviceModel(this.label);
  final String label;
}

/// A saved identity and the latest state of that particular piece of hardware.
/// Retail models are labels chosen during setup: production USB firmware does
/// not report a retail SKU, so a touch-controller name must not imply Pro.
class HarnessDevice {
  const HarnessDevice({
    required this.key,
    required this.name,
    required this.model,
    required this.status,
    this.machineId = 'local',
    this.machineName = 'This computer',
    this.hostOnline = true,
    this.hostAvailable = true,
    this.local = true,
  });

  final String key, name;
  final HarnessDeviceModel model;
  final DialStatus status;
  final String machineId, machineName;
  final bool hostOnline, hostAvailable, local;

  /// Use the reported screen shape, not its resolution or the saved model
  /// label. Older Pro firmware identifies itself before it reports settings.
  bool get hasSquareDisplay => status.settings?.round != null
      ? !status.settings!.round
      : status.hw == 'harness-pro';

  bool get canEdit =>
      hostOnline &&
      hostAvailable &&
      status.attached &&
      status.id != null &&
      status.settings != null &&
      status.updating == null;
  String get connectionLabel => !hostOnline
      ? 'Computer offline'
      : !hostAvailable
      ? 'Unavailable'
      : status.updating != null
      ? 'Updating'
      : status.attached
      ? 'Connected'
      : 'Disconnected';

  HarnessDevice copyWith({
    String? name,
    HarnessDeviceModel? model,
    DialStatus? status,
    String? machineId,
    String? machineName,
    bool? hostOnline,
    bool? hostAvailable,
    bool? local,
  }) => HarnessDevice(
    key: key,
    name: name ?? this.name,
    model: model ?? this.model,
    status: status ?? this.status,
    machineId: machineId ?? this.machineId,
    machineName: machineName ?? this.machineName,
    hostOnline: hostOnline ?? this.hostOnline,
    hostAvailable: hostAvailable ?? this.hostAvailable,
    local: local ?? this.local,
  );

  Map<String, Object?> toJson() => {
    'key': key,
    'name': name,
    'model': model.name,
    'machineId': machineId,
    'machineName': machineName,
    'status': {
      'attached': false,
      'id': status.id,
      'mac': status.mac,
      'fw': status.fw,
      'hw': status.hw,
      if (status.settings != null) 'settings': status.settings!.toJson(),
    },
  };

  static HarnessDevice? fromJson(Object? raw) {
    if (raw is! Map ||
        raw['key'] is! String ||
        raw['name'] is! String ||
        raw['status'] is! Map) {
      return null;
    }
    final key = raw['key'] as String;
    final name = raw['name'] as String;
    if (key.isEmpty || name.trim().isEmpty) return null;
    return HarnessDevice(
      key: key,
      name: name,
      machineId: raw['machineId'] is String
          ? raw['machineId'] as String
          : 'local',
      machineName: raw['machineName'] is String
          ? raw['machineName'] as String
          : 'This computer',
      hostOnline: false,
      local: raw['machineId'] == null || raw['machineId'] == 'local',
      model: raw['model'] == 'pro'
          ? HarnessDeviceModel.pro
          : HarnessDeviceModel.harness,
      status: DialStatus.fromJson({
        ...Map<String, dynamic>.from(raw['status'] as Map),
        'attached': false,
        'updating': null,
      }),
    );
  }
}

/// Local, account-scoped device names and last readings. USB discovery owns
/// connection state; reopening a saved library cannot manufacture a device.
class DevicesController extends ChangeNotifier {
  DevicesController({
    this.dial,
    this.hosts,
    required String accountId,
    this.sendSettings,
    this.sendHostSettings,
    this.storage,
    this.confirmationTimeout = const Duration(seconds: 8),
  }) : storageKey = 'harness_devices_v1.${Uri.encodeComponent(accountId)}' {
    assert(dial != null || hosts != null);
    assert(sendSettings != null || sendHostSettings != null);
    dial?.addListener(_sync);
    hosts?.addListener(_sync);
  }

  final DialState? dial;
  final DeviceHosts? hosts;
  final LocalKeyValueStore? storage;
  final String storageKey;
  final Future<bool> Function(String id, Map<String, Object?> patch)?
  sendSettings;
  final Future<bool> Function(
    String machineId,
    String id,
    Map<String, Object?> patch,
  )?
  sendHostSettings;
  final Duration confirmationTimeout;
  final _devices = <String, HarnessDevice>{};
  final _pending = <String, Map<String, Object?>>{};
  final _timers = <String, Timer>{};
  final _errors = <String, String>{};
  Future<void> _writes = Future.value();
  Future<void>? _loading;
  bool loaded = false, _disposed = false, _readFailed = false;
  String? error;

  List<HarnessDevice> get devices => List.unmodifiable(_devices.values);
  List<DeviceHost> get computers => hosts?.hosts ?? const [];
  HarnessDevice? device(String key) => _devices[key];
  bool saving(String key) => _pending.containsKey(key);
  String? deviceError(String key) => _errors[key];
  Future<void> get settled => _writes;

  Future<void> load() => _loading ??= _load();
  Future<void> _load() async {
    try {
      final raw = await storage?.read(storageKey);
      if (_disposed) return;
      if (raw != null) {
        final rows = jsonDecode(raw);
        if (rows is! List) {
          throw const FormatException('Invalid device library');
        }
        for (final row in rows) {
          final device = HarnessDevice.fromJson(row);
          if (device != null) _devices.putIfAbsent(device.key, () => device);
        }
      }
      _readFailed = false;
      error = null;
    } catch (_) {
      if (_disposed) return;
      _readFailed = true;
      error =
          'Couldn’t load saved devices. Connected devices are still available.';
    }
    if (_disposed) return;
    loaded = true;
    _sync();
  }

  static String identity(DialStatus status) => status.mac != null
      ? 'mac:${status.mac!.toLowerCase()}'
      : status.id != null
      ? 'usb:${status.id}'
      : 'legacy';

  void _sync() {
    if (_disposed || !loaded) return;
    final before = jsonEncode(_devices.values.map((d) => d.toJson()).toList());
    final seen = <String>{};
    final sources =
        hosts?.hosts ??
        [
          DeviceHost(
            id: 'local',
            name: 'This computer',
            online: true,
            local: true,
            available: true,
            status: DialStatus(
              attached: dial!.status.attached,
              devices: dial!.devices,
            ),
          ),
        ];
    for (final host in sources) {
      for (final live in host.devices) {
        final identityKey = identity(live);
        // The greeting can add a MAC after the USB identity was first reported.
        // Keep the saved key (and selection) when that happens, or ports change.
        final known = _devices.values
            .where(
              (d) =>
                  (d.machineId == host.id ||
                      (d.machineId == 'local' && host.local)) &&
                  (d.key == identityKey ||
                      (live.mac != null &&
                          d.status.mac?.toLowerCase() ==
                              live.mac!.toLowerCase()) ||
                      (live.id != null &&
                          d.status.id == live.id &&
                          (live.mac == null || d.status.mac == null))),
            )
            .firstOrNull;
        final key =
            known?.key ??
            (host.id == 'local'
                ? identityKey
                : '${Uri.encodeComponent(host.id)}/$identityKey');
        seen.add(key);
        final number = _devices.length + 1;
        final observed = DialStatus(
          attached: host.online && live.attached,
          id: live.id,
          mac: live.mac ?? known?.status.mac,
          fw: live.fw ?? known?.status.fw,
          hw: live.hw ?? known?.status.hw,
          updating: live.updating,
          // A disconnect frame may omit readings. Preserve them for reference,
          // but require fresh settings when a connected device greets us again.
          settings:
              live.settings ?? (live.attached ? null : known?.status.settings),
        );
        _devices[key] =
            known?.copyWith(
              status: observed,
              machineId: host.id,
              machineName: host.name,
              hostOnline: host.online,
              hostAvailable: host.available,
              local: host.local,
            ) ??
            HarnessDevice(
              key: key,
              name: number == 1 ? 'My Harness' : 'Harness $number',
              model: HarnessDeviceModel.harness,
              status: observed,
              machineId: host.id,
              machineName: host.name,
              hostOnline: host.online,
              hostAvailable: host.available,
              local: host.local,
            );
        final pending = _pending[key];
        final held = live.settings?.toJson();
        if (pending != null &&
            (!host.online ||
                !host.available ||
                !live.attached ||
                live.updating != null)) {
          _finish(
            key,
            live.updating != null
                ? 'The device started updating before confirming the change. Try again after the update.'
                : 'Device disconnected. Reconnect to change its settings.',
          );
        } else if (pending != null &&
            held != null &&
            pending.entries.every((e) => held[e.key] == e.value)) {
          _finish(key);
        }
      }
    }
    for (final key in _devices.keys.toList()) {
      if (seen.contains(key)) continue;
      final device = _devices[key]!;
      final status = device.status;
      _devices[key] = device.copyWith(
        hostOnline: sources.any((h) => h.id == device.machineId && h.online),
        status: DialStatus(
          attached: false,
          id: status.id,
          mac: status.mac,
          fw: status.fw,
          hw: status.hw,
          settings: status.settings,
        ),
      );
      if (_pending.containsKey(key)) {
        _finish(key, 'Device disconnected. Reconnect to change its settings.');
      }
    }
    final after = jsonEncode(_devices.values.map((d) => d.toJson()).toList());
    if (before != after) _save(after);
    notifyListeners();
  }

  void rename(String key, String name, HarnessDeviceModel model) {
    final device = _devices[key];
    final clean = name.trim();
    if (device == null || clean.isEmpty || clean.length > 60 || _disposed) {
      return;
    }
    _devices[key] = device.copyWith(name: clean, model: model);
    _save(jsonEncode(_devices.values.map((d) => d.toJson()).toList()));
    notifyListeners();
  }

  void _save(String encoded) {
    final store = storage;
    if (store == null || _readFailed) return;
    _writes = _writes
        .then((_) => store.write(storageKey, encoded))
        .then((_) {
          if (!_disposed && error != null) {
            error = null;
            notifyListeners();
          }
        })
        .catchError((Object _) {
          if (_disposed) return;
          error = 'Couldn’t save your device library. Try again.';
          notifyListeners();
        });
  }

  Future<void> retrySave() async {
    if (_readFailed) {
      _loading = null;
      await load();
    }
    if (!_disposed) {
      _save(jsonEncode(_devices.values.map((d) => d.toJson()).toList()));
    }
  }

  Future<void> update(String key, Map<String, Object?> patch) async {
    final device = _devices[key];
    if (_disposed ||
        device == null ||
        !device.canEdit ||
        saving(key) ||
        patch.isEmpty) {
      return;
    }
    final held = device.status.settings!.toJson();
    if (patch.entries.every((e) => held[e.key] == e.value)) return;
    final request = Map<String, Object?>.of(patch);
    _pending[key] = request;
    _errors.remove(key);
    _timers[key] = Timer(confirmationTimeout, () {
      _finish(
        key,
        'The change wasn’t confirmed. Check the connection and try again.',
      );
      if (!_disposed) notifyListeners();
    });
    notifyListeners();
    try {
      final sent =
          await (sendHostSettings?.call(
                device.machineId,
                device.status.id!,
                patch,
              ) ??
              sendSettings!(device.status.id!, patch));
      if (_disposed || !identical(_pending[key], request)) return;
      if (!sent) {
        _finish(
          key,
          'Couldn’t reach this device. Check the connection and try again.',
        );
        notifyListeners();
      }
    } catch (_) {
      if (_disposed || !identical(_pending[key], request)) return;
      _finish(
        key,
        'Couldn’t reach this device. Check the connection and try again.',
      );
      notifyListeners();
    }
  }

  void _finish(String key, [String? message]) {
    _pending.remove(key);
    _timers.remove(key)?.cancel();
    if (message != null) _errors[key] = message;
  }

  @override
  void dispose() {
    _disposed = true;
    dial?.removeListener(_sync);
    hosts?.removeListener(_sync);
    for (final timer in _timers.values) {
      timer.cancel();
    }
    super.dispose();
  }
}
