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
    this.petRequest,
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

  /// Pet requests to the machine's daemon (local connection only). Null hides
  /// the Pet section: there is nobody to ask.
  final Future<Map<String, dynamic>> Function(
    String machineId,
    String type,
    Map<String, Object?> payload,
  )?
  petRequest;
  final _petStatus = <String, PetStatus>{};
  final _polls = <String, Timer>{};
  final _pollTicks = <String, int>{};
  final _petUnavailable = <String>{};

  /// How long a pet may stay pending before the poll gives up.
  static const petPollLimit = Duration(seconds: 120);
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

  PetStatus? petStatus(String key) => _petStatus[key];

  Future<Map<String, dynamic>> _pet(
    String key,
    String type, [
    Map<String, Object?> payload = const {},
  ]) async {
    final device = _devices[key];
    final send = petRequest;
    if (device == null || send == null) {
      return {
        'error': 'LOCAL_ONLY',
        'message': 'Pets are set on this computer.',
      };
    }
    try {
      return await send(device.machineId, type, payload);
    } catch (_) {
      return {
        'error': 'UNREACHABLE',
        'message': 'Couldn’t reach Harness on this computer. Try again.',
      };
    }
  }

  /// True when the daemon answered a pet request with UNSUPPORTED: it predates
  /// custom pets and the section stays locked.
  bool petUnavailable(String key) => _petUnavailable.contains(key);

  /// Whether the dial still has to take (or refuse) a mapped pet.
  bool _petPending(String key, PetStatus status) {
    final device = _devices[key];
    if (device == null || !device.status.attached || !status.supported) {
      return false;
    }
    if (status.sendingId != null) return true;
    return status.mapped.any(
      (id) => !status.held.contains(id) && !status.errors.containsKey(id),
    );
  }

  void _stopPoll(String key) {
    _polls.remove(key)?.cancel();
    _pollTicks.remove(key);
  }

  /// Reads the mapping and the dial's pet state; polls every second while the
  /// dial still has a mapped pet to take, for at most [petPollLimit].
  Future<void> refreshPetStatus(String key, {bool restart = false}) async {
    final reply = await _pet(key, 'pet_status');
    if (_disposed) return;
    if (reply['error'] != null) {
      // Nobody answered: stop asking and forget the stale progress.
      _stopPoll(key);
      if (reply['error'] == 'UNSUPPORTED') _petUnavailable.add(key);
      final old = _petStatus[key];
      if (old != null) _petStatus[key] = old.withoutSending();
      notifyListeners();
      return;
    }
    _petUnavailable.remove(key);
    final status = PetStatus.fromJson(reply);
    _petStatus[key] = status;
    if (restart) _stopPoll(key);
    if (_petPending(key, status)) {
      _polls[key] ??= Timer.periodic(const Duration(seconds: 1), (_) {
        final ticks = _pollTicks[key] = (_pollTicks[key] ?? 0) + 1;
        if (ticks >= petPollLimit.inSeconds) {
          _stopPoll(key);
        } else {
          unawaited(refreshPetStatus(key));
        }
      });
    } else {
      _stopPoll(key);
    }
    notifyListeners();
  }

  /// Converts [path] on the daemon without saving it. [rows] picks the sheet
  /// row (by petdex row name) for each state (`rest`, `working`, `listening`,
  /// `sending`, `asking`); the daemon fills in the rest. Null when it failed;
  /// [petError] then holds why.
  Future<PetPreview?> previewPet(
    String key,
    String path, {
    String? name,
    Map<String, String>? rows,
  }) async {
    final reply = await _pet(key, 'pet_preview', {
      'path': path,
      'name': ?name,
      'rows': ?rows,
    });
    if (reply['error'] != null || reply['ok'] != true) {
      _petErrors[key] = '${reply['message'] ?? reply['error'] ?? 'Failed'}';
      return null;
    }
    _petErrors.remove(key);
    return PetPreview.fromJson(reply);
  }

  final _petErrors = <String, String>{};
  String? petError(String key) => _petErrors[key];

  /// Engine keys the mapping holds a pet of their own for, from [reply]'s
  /// mapping and the last known status.
  Set<String> _engineKeys(String key, Map<String, dynamic> reply) => {
    ..._petStatus[key]?.engines.keys ?? const <String>[],
    if (reply['mapping'] case {'engines': final Map engines})
      for (final engine in engines.keys) '$engine',
  };

  /// Makes [id] the pet of every agent: sets 'all', then drops each engine's
  /// own pet so a leftover one no longer overrides it (the protocol keeps
  /// per-engine pets; the app offers one pet only). Null when applied, else
  /// the message to show in the row.
  Future<String?> applyPet(String key, String id) async {
    final reply = await _pet(key, 'pet_apply', {'target': 'all', 'id': id});
    if (reply['error'] != null) {
      return '${reply['message'] ?? reply['error']}';
    }
    for (final engine in _engineKeys(key, reply)) {
      await _pet(key, 'pet_reset', {'target': engine});
    }
    await refreshPetStatus(key, restart: true);
    return null;
  }

  /// Back to the built-in pet for every agent: 'all' and each engine entry.
  Future<void> resetPet(String key) async {
    final reply = await _pet(key, 'pet_reset', {'target': 'all'});
    for (final engine in _engineKeys(key, reply)) {
      await _pet(key, 'pet_reset', {'target': engine});
    }
    await refreshPetStatus(key, restart: true);
  }

  @override
  void dispose() {
    _disposed = true;
    for (final timer in _polls.values) {
      timer.cancel();
    }
    dial?.removeListener(_sync);
    hosts?.removeListener(_sync);
    for (final timer in _timers.values) {
      timer.cancel();
    }
    super.dispose();
  }
}

/// What the daemon converted a sprite sheet into: the frames the dial will draw
/// (decoded once from the PNG data URLs) and how fast each scene steps.
@immutable
class PetPreview {
  const PetPreview({
    required this.id,
    required this.bytes,
    required this.colours,
    required this.warnings,
    required this.frames,
    required this.stepMs,
    this.rows = const {},
    this.sheetRows = const [],
  });

  final String id;
  final int bytes, colours;
  final List<String> warnings;

  /// The row (by petdex row name) each state plays, defaults filled in. Empty
  /// from a daemon that predates row choice.
  final Map<String, String> rows;

  /// The sheet's non-empty rows in sheet order, to choose from.
  final List<PetSheetRow> sheetRows;

  /// Scene (`small`, `working`, `listening`, `sending`) to decoded PNG frames.
  final Map<String, List<Uint8List>> frames;
  final Map<String, int> stepMs;

  static PetPreview fromJson(Map<String, dynamic> json) {
    final frames = <String, List<Uint8List>>{};
    if (json['frames'] case final Map raw) {
      for (final entry in raw.entries) {
        frames['${entry.key}'] = [
          for (final url in (entry.value as List? ?? const []))
            if (url is String && url.contains(','))
              base64Decode(url.substring(url.indexOf(',') + 1)),
        ];
      }
    }
    final step = <String, int>{};
    if (json['stepMs'] case final Map raw) {
      for (final entry in raw.entries) {
        if (entry.value is num) {
          step['${entry.key}'] = (entry.value as num).toInt();
        }
      }
    }
    final rows = <String, String>{};
    if (json['rows'] case final Map raw) {
      for (final entry in raw.entries) {
        if (entry.value is String) rows['${entry.key}'] = entry.value as String;
      }
    }
    return PetPreview(
      id: '${json['id']}',
      bytes: (json['bytes'] as num?)?.toInt() ?? 0,
      colours: (json['colours'] as num?)?.toInt() ?? 0,
      warnings: [for (final w in (json['warnings'] as List? ?? const [])) '$w'],
      frames: frames,
      stepMs: step,
      rows: rows,
      sheetRows: [
        for (final raw in (json['sheetRows'] as List? ?? const []))
          if (raw is Map && raw['row'] is String)
            PetSheetRow(
              row: raw['row'] as String,
              frames: (raw['frames'] as num?)?.toInt() ?? 0,
              strip: switch (raw['strip']) {
                final String url when url.contains(',') => base64Decode(
                  url.substring(url.indexOf(',') + 1),
                ),
                _ => null,
              },
            ),
      ],
    );
  }
}

/// One non-empty row of a previewed sheet: its petdex name, how many frames
/// it holds and those frames side by side (a PNG), when the daemon sent them.
@immutable
class PetSheetRow {
  const PetSheetRow({required this.row, required this.frames, this.strip});
  final String row;
  final int frames;
  final Uint8List? strip;
}

/// A pet the daemon knows by id: its display name and a still thumbnail.
@immutable
class PetInfo {
  const PetInfo(this.name, this.thumb);
  final String name;
  final Uint8List? thumb;
}

/// The pet mapping (which pet each engine shows) and the dial's pet state.
@immutable
class PetStatus {
  const PetStatus({
    this.all,
    this.engines = const {},
    this.supported = false,
    this.held = const [],
    this.sendingId,
    this.percent = 0,
    this.errors = const {},
    this.pets = const {},
  });

  final String? all;
  final Map<String, String> engines;
  final bool supported;
  final List<String> held;

  /// Why the dial refused a pet: `memory`, `busy`, `crc`, `version`, `shape`
  /// or `timeout`, by pet id. Absent from an older daemon.
  final Map<String, String> errors;
  final Map<String, PetInfo> pets;

  /// The pet going to the dial right now, and how far it is; null when idle.
  final String? sendingId;
  final int percent;
  PetSending? get sending =>
      sendingId == null ? null : PetSending(sendingId!, percent);

  /// Every pet id the mapping points at.
  Set<String> get mapped => {?all, ...engines.values};

  PetStatus withoutSending() => PetStatus(
    all: all,
    engines: engines,
    supported: supported,
    held: held,
    errors: errors,
    pets: pets,
  );

  static PetStatus fromJson(Map<String, dynamic> json) {
    final mapping = json['mapping'] is Map ? json['mapping'] as Map : const {};
    final dial = json['dial'] is Map ? json['dial'] as Map : const {};
    final sending = dial['sending'] is Map ? dial['sending'] as Map : null;
    final pets = <String, PetInfo>{};
    if (json['pets'] case final Map raw) {
      for (final e in raw.entries) {
        if (e.value is! Map) continue;
        final v = e.value as Map;
        Uint8List? thumb;
        if (v['thumb'] case final String url when url.contains(',')) {
          try {
            thumb = base64Decode(url.substring(url.indexOf(',') + 1));
          } catch (_) {}
        }
        pets['${e.key}'] = PetInfo(
          v['name'] is String && (v['name'] as String).isNotEmpty
              ? v['name'] as String
              : 'Custom pet',
          thumb,
        );
      }
    }
    return PetStatus(
      all: mapping['all'] is String ? mapping['all'] as String : null,
      engines: {
        if (mapping['engines'] is Map)
          for (final e in (mapping['engines'] as Map).entries)
            if (e.value is String) '${e.key}': e.value as String,
      },
      supported: dial['supported'] == true,
      held: [for (final id in (dial['held'] as List? ?? const [])) '$id'],
      sendingId: sending?['id'] is String ? sending!['id'] as String : null,
      percent: (sending?['percent'] as num?)?.toInt() ?? 0,
      errors: {
        if (dial['errors'] is Map)
          for (final e in (dial['errors'] as Map).entries)
            if (e.value is String) '${e.key}': e.value as String,
      },
      pets: pets,
    );
  }
}

@immutable
class PetSending {
  const PetSending(this.id, this.percent);
  final String id;
  final int percent;
}
