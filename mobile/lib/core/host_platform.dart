import 'dart:io';

/// True where the app is a guest inside a sandboxed container rather than a
/// desktop process of its own: iOS and Android.
bool get isMobileHost => Platform.isIOS || Platform.isAndroid;

/// The app's own container, on the platforms that give a process no `HOME`.
///
/// An app on iOS or Android does not live in a user's home directory; it lives
/// in a private container, and `Platform.environment` there carries no `HOME`
/// to point at it. The container root is the parent of the temporary directory
/// the platform DOES name — `NSTemporaryDirectory()` is `<container>/tmp`, and
/// Android's cache directory is `<data dir>/cache` — which makes it reachable
/// synchronously, without a plugin.
///
/// Synchronously matters: the callers read it from field initializers and from
/// `installFileLogs`, which is deliberately not `async` so that the first lines
/// about starting up are not lost to a directory probe. Not adding a plugin
/// matters too — registering one rewrites the macOS SPM package list for every
/// desktop build as well (see CLAUDE.md).
///
/// `null` off those platforms, so a desktop host with no `HOME` still fails the
/// way it always has rather than quietly writing somewhere unexpected.
///
String? get containerHome {
  if (!isMobileHost) return null;
  final container = Directory.systemTemp.parent.path;
  // An iOS app's container ROOT is not writable; `Library/Application Support`
  // is, and is where Apple expects state that is not user documents. Android's
  // data directory root is writable, so it takes the container as it is.
  return Platform.isIOS
      ? '$container/Library/Application Support'
      : container;
}
