import 'dart:ffi';

import 'package:ffi/ffi.dart';

/// The same FOLDERID_UserProgramFiles lookup and DONT_VERIFY flag as Harness.exe.
String? userProgramFilesFolder() {
  try {
    final shell32 = DynamicLibrary.open('shell32.dll');
    final ole32 = DynamicLibrary.open('ole32.dll');
    final getPath = shell32
        .lookupFunction<
          Int32 Function(
            Pointer<_Guid>,
            Uint32,
            IntPtr,
            Pointer<Pointer<Utf16>>,
          ),
          int Function(Pointer<_Guid>, int, int, Pointer<Pointer<Utf16>>)
        >('SHGetKnownFolderPath');
    final free = ole32
        .lookupFunction<
          Void Function(Pointer<Void>),
          void Function(Pointer<Void>)
        >('CoTaskMemFree');
    final id = calloc<_Guid>();
    final out = calloc<Pointer<Utf16>>();
    try {
      // {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}
      id.ref
        ..data1 = 0x5CD7AEE2
        ..data2 = 0x2219
        ..data3 = 0x4A67;
      const tail = [0xB8, 0x5D, 0x6C, 0x9C, 0xE1, 0x56, 0x60, 0xCB];
      for (var i = 0; i < tail.length; i++) {
        id.ref.data4[i] = tail[i];
      }
      const kfFlagDontVerify = 0x4000;
      final hr = getPath(id, kfFlagDontVerify, 0, out);
      return hr >= 0 && out.value != nullptr ? out.value.toDartString() : null;
    } finally {
      free(out.value.cast());
      calloc.free(out);
      calloc.free(id);
    }
  } catch (_) {
    return null;
  }
}

final class _Guid extends Struct {
  @Uint32()
  external int data1;
  @Uint16()
  external int data2;
  @Uint16()
  external int data3;
  @Array(8)
  external Array<Uint8> data4;
}
