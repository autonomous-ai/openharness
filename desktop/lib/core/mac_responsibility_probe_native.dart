import 'dart:ffi';
import 'dart:io' show Platform;

import 'package:ffi/ffi.dart';

import 'process_responsibility.dart' show ResponsibilityProbe;

/// libSystem's answers. `responsibility_get_pid_responsible_for_pid` is private API, so every lookup
/// degrades to null — which the verdict below reads as "cannot tell", never as "restart".
class MacResponsibilityProbe implements ResponsibilityProbe {
  MacResponsibilityProbe();

  static const _maxPath = 4096;

  late final int Function(int)? _responsible = _lookup(
    () => DynamicLibrary.process()
        .lookupFunction<Int32 Function(Int32), int Function(int)>(
          'responsibility_get_pid_responsible_for_pid',
        ),
  );

  late final int Function(int, Pointer<Uint8>, int)? _pidPath = _lookup(
    () =>
        DynamicLibrary.process().lookupFunction<
          Int32 Function(Int32, Pointer<Uint8>, Uint32),
          int Function(int, Pointer<Uint8>, int)
        >('proc_pidpath'),
  );

  static T? _lookup<T>(T Function() find) {
    if (!Platform.isMacOS) return null;
    try {
      return find();
    } on ArgumentError {
      return null;
    }
  }

  @override
  int? responsiblePid(int pid) {
    final responsible = _responsible?.call(pid);
    return responsible == null || responsible <= 0 ? null : responsible;
  }

  @override
  String? executablePath(int pid) {
    final pidPath = _pidPath;
    if (pidPath == null) return null;
    final buffer = calloc<Uint8>(_maxPath);
    try {
      final length = pidPath(pid, buffer, _maxPath);
      return length <= 0
          ? null
          : buffer.cast<Utf8>().toDartString(length: length);
    } finally {
      calloc.free(buffer);
    }
  }
}
