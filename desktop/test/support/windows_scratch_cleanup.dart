import 'dart:io';

/// Removes this fixture's scratch tree, allowing a short Windows sharing race.
Future<void> deleteWindowsScratch(
  Directory scratch, {
  Duration timeout = const Duration(seconds: 2),
  void Function(FileSystemException)? onSharingViolation,
}) async {
  if (!Platform.isWindows) {
    await scratch.delete(recursive: true);
    return;
  }

  final elapsed = Stopwatch()..start();
  while (true) {
    try {
      await scratch.delete(recursive: true);
      return;
    } on FileSystemException catch (error) {
      if (error.osError?.errorCode != 32) rethrow;
      onSharingViolation?.call(error);
      final remaining = timeout - elapsed.elapsed;
      if (remaining <= Duration.zero) rethrow;
      const interval = Duration(milliseconds: 20);
      await Future<void>.delayed(remaining < interval ? remaining : interval);
      if (elapsed.elapsed >= timeout) rethrow;
    }
  }
}
