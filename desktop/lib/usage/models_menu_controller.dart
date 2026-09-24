import 'dart:async';

import 'package:flutter/foundation.dart';

import '../widgets/engine_identity.dart';
import 'usage_accounts.dart';
import 'usage_controller.dart';
import 'usage_window.dart';

/// Subscription readings for the Models panel. Opening the panel reads
/// the cached snapshot immediately and refreshes at most once per minute.
/// No polling, credential reads or requests run on startup or tab changes.
class ModelsMenuController extends ChangeNotifier {
  ModelsMenuController({
    UsageController? usage,
    Future<List<MachineUsage>> Function()? remote,
    DateTime Function()? now,
  }) : _usage = usage ?? UsageController(remote: remote, autoStart: false),
       _ownsUsage = usage == null,
       _now = now ?? DateTime.now {
    _usage.addListener(_changed);
  }

  final UsageController _usage;
  final bool _ownsUsage;
  final DateTime Function() _now;
  Future<void>? _pending;
  DateTime? _lastAttempt;
  bool _failed = false;
  bool _disposed = false;

  List<Map<String, Object?>> get rows => [
    for (final account in _usage.accounts)
      _row(account, _now(), failed: _failed),
  ];

  /// The subscription the selected agent machine can actually use. An account
  /// seen only on another computer must not be presented as this one's login.
  Map<String, Object?>? subscriptionFor(
    String engine, {
    required bool local,
    required String machineName,
  }) {
    for (final account in _usage.accounts) {
      if (account.provider.engineId == engine &&
          (local ? account.isLocal : account.machines.contains(machineName))) {
        return _row(account, _now(), failed: _failed);
      }
    }
    return null;
  }

  Future<void> refresh() {
    if (_disposed) return Future.value();
    // Re-evaluate expired windows even if another request is already running.
    _changed();
    if (_pending case final pending?) return pending;
    final last = _lastAttempt;
    if (last != null && _now().difference(last) < const Duration(minutes: 1)) {
      return Future.value();
    }
    _lastAttempt = _now();
    _failed = false;
    return _pending = _refresh();
  }

  Future<void> _refresh() async {
    try {
      await _usage.refresh();
    } catch (_) {
      // A credential/source failure must never escape into a menu callback.
      // Never include a raw exception: it could contain authentication data.
      _failed = true;
    } finally {
      _pending = null;
      _changed();
    }
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _usage.removeListener(_changed);
    if (_ownsUsage) _usage.dispose();
    super.dispose();
  }

  static Map<String, Object?> _row(
    UsageAccount account,
    DateTime now, {
    required bool failed,
  }) {
    final reading = account.reading;
    final provider = switch (reading.provider) {
      UsageProvider.claude => 'Anthropic',
      UsageProvider.codex => 'OpenAI',
    };
    final windows = reading.windows;
    final expired =
        (reading.fetchedAt != null &&
            now.difference(reading.fetchedAt!) > const Duration(minutes: 2)) ||
        windows.any((w) => w.resetsAt != null && !w.resetsAt!.isAfter(now));
    final valid =
        !failed &&
        !expired &&
        reading.hasFigures &&
        windows.every((w) => w.usedPercent.isFinite);
    final String status;
    final details = <String>[];
    // The figure behind the sentence, for a meter the words alone cannot draw. Null whenever the
    // sentence is not a figure ("Usage unavailable", "Checking usage…"), so a caller cannot mistake
    // "we could not read it" for "nothing left".
    double? remainingPercent;
    if (valid) {
      // Show the limit that will stop work first. Weekly-only summaries can
      // look healthy while a shorter window is already exhausted.
      final limiting = reading.tightest!;
      status = '${_remaining(limiting)} remaining';
      remainingPercent = (100 - limiting.usedPercent).clamp(0, 100).toDouble();
      details.add('Limiting window: ${limiting.label}');
      for (final window in windows) {
        final reset = window.resetsInLabel(now: now);
        details.add(
          '${window.label} — ${_remaining(window)} remaining'
          '${reset == null ? '' : ' · resets in $reset'}',
        );
      }
    } else {
      status = failed || expired
          ? 'Usage unavailable'
          : switch (reading.status) {
              UsageStatus.loading => 'Checking usage…',
              UsageStatus.signedOut => 'Not signed in',
              _ => 'Usage unavailable',
            };
      details.add(
        expired
            ? 'The last reading has expired. Reopen Models to refresh.'
            : reading.message ?? status,
      );
    }
    return {
      'title': provider,
      'account': _accountLabel(reading),
      'status': status,
      'remainingPercent': remainingPercent,
      'details': details,
      'engine': reading.provider.engineId,
      'iconAsset': engineIdentity(reading.provider.engineId).asset,
    };
  }

  static String _accountLabel(ProviderUsage reading) {
    // The same opaque identity is available locally and across machines.
    // Use it consistently instead of mixing emails with fallback IDs.
    final key = reading.account;
    if (key != null && RegExp(r'^[0-9a-f]{16}$').hasMatch(key)) {
      return key.substring(0, 6);
    }
    return '';
  }

  static String _remaining(UsageWindow window) {
    final left = (100 - window.usedPercent).clamp(0, 100);
    // Never round a positive remainder to zero (or a partial balance to 100).
    if (left > 0 && left < 1) return '<1%';
    return '${left.floor()}%';
  }
}
