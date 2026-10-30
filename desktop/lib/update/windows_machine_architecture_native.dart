import 'dart:ffi';

import 'package:ffi/ffi.dart';

import '../core/runtime_architecture.dart';

String windowsMachineArchitecture() {
  const imageFileMachineArm64 = 0xAA64;
  try {
    final kernel32 = DynamicLibrary.open('kernel32.dll');
    final isWow64Process2 = kernel32
        .lookupFunction<
          Int32 Function(IntPtr, Pointer<Uint16>, Pointer<Uint16>),
          int Function(int, Pointer<Uint16>, Pointer<Uint16>)
        >('IsWow64Process2');
    final process = calloc<Uint16>();
    final native = calloc<Uint16>();
    try {
      if (isWow64Process2(-1, process, native) != 0) {
        return native.value == imageFileMachineArm64 ? 'arm64' : 'x64';
      }
    } finally {
      calloc.free(process);
      calloc.free(native);
    }
  } catch (_) {
    // Older Windows lacks IsWow64Process2; use the process architecture.
  }
  return runtimeArchitecture;
}
