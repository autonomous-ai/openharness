import 'dart:ffi';

import 'package:ffi/ffi.dart';

/// Where Harness Device's Windows installer installed it: its uninstall
/// entry's `InstallLocation`, which Tauri's installer writes, quoted, under
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harness Device`
/// and its uninstaller removes. Null when none is registered or it cannot be
/// read. Through the registry's own API, which keeps a folder named in any
/// language whole.
String? windowsDeviceAppInstallLocation() {
  // (HKEY)(LONG)0x80000001, sign-extended to the pointer's width.
  const hkeyCurrentUser = -0x7fffffff;
  const rrfRtRegSz = 0x2;
  try {
    final getValue = DynamicLibrary.open('advapi32.dll')
        .lookupFunction<
          Int32 Function(
            IntPtr,
            Pointer<Utf16>,
            Pointer<Utf16>,
            Uint32,
            Pointer<Uint32>,
            Pointer<Void>,
            Pointer<Uint32>,
          ),
          int Function(
            int,
            Pointer<Utf16>,
            Pointer<Utf16>,
            int,
            Pointer<Uint32>,
            Pointer<Void>,
            Pointer<Uint32>,
          )
        >('RegGetValueW');
    final key =
        r'Software\Microsoft\Windows\CurrentVersion\Uninstall\Harness Device'
            .toNativeUtf16(allocator: calloc);
    final name = 'InstallLocation'.toNativeUtf16(allocator: calloc);
    final size = calloc<Uint32>();
    Pointer<Uint8> data = nullptr;
    try {
      // The size first, then the value; ERROR_SUCCESS is 0.
      if (getValue(
            hkeyCurrentUser,
            key,
            name,
            rrfRtRegSz,
            nullptr,
            nullptr,
            size,
          ) !=
          0) {
        return null;
      }
      data = calloc<Uint8>(size.value);
      if (getValue(
            hkeyCurrentUser,
            key,
            name,
            rrfRtRegSz,
            nullptr,
            data.cast(),
            size,
          ) !=
          0) {
        return null;
      }
      // RRF_RT_REG_SZ ends the value with a NUL.
      return data.cast<Utf16>().toDartString();
    } finally {
      calloc.free(key);
      calloc.free(name);
      calloc.free(size);
      if (data != nullptr) calloc.free(data);
    }
  } catch (_) {
    // No advapi32 (not Windows), or no such function: nothing registered.
    return null;
  }
}
