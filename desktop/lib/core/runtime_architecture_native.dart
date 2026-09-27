import 'dart:ffi' show Abi;

String get runtimeAbi => Abi.current().toString();

String get runtimeArchitecture => switch (Abi.current()) {
  Abi.linuxArm64 || Abi.macosArm64 || Abi.windowsArm64 => 'arm64',
  Abi.linuxX64 || Abi.macosX64 || Abi.windowsX64 => 'x64',
  _ => throw UnsupportedError(
    'Harness updates do not support ${Abi.current()}',
  ),
};
