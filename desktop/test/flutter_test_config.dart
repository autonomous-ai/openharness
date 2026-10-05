import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Runs before every test file under `test/`.
///
/// A `testWidgets` that never finishes waits the binding's own default — ten minutes — and ignores
/// `flutter test --timeout` (measured): a handful of hung tests turned a five-minute suite into
/// forty to sixty. Two minutes is far above anything that passes here; a test that really needs
/// longer (the e2e suites) says so with its own `timeout:`, which still wins.
///
/// ⚠️ Setting it means creating the test binding for EVERY file, and the binding installs
/// flutter_test's `HttpClient` mock — every request answers 400 — process-wide. Files that are not
/// widget tests never used to get it, and theirs talk to real loopback servers (the daemon's status,
/// the updater's manifest, the API client): over a hundred of them failed. [_LoopbackOnly] replaces
/// the mock with what it was for: no request leaves the machine, and loopback works as it did.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  if (binding is AutomatedTestWidgetsFlutterBinding) {
    binding.defaultTestTimeout = const Timeout(Duration(minutes: 2));
  }
  HttpOverrides.global = _LoopbackOnly();
  await testMain();
}

class _LoopbackOnly extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = super.createHttpClient(context);
    // A test that needs its own connection (the daemon's Unix socket) sets its own factory, which
    // replaces this one — so only plain host connections are checked here.
    client.connectionFactory = (uri, proxyHost, proxyPort) {
      final host = proxyHost ?? uri.host;
      final port = proxyPort ?? uri.port;
      if (!_isLoopback(host)) {
        throw SocketException(
          'Network is disabled in tests ($host). Use a loopback server or inject a transport.',
        );
      }
      return uri.isScheme('https') || uri.isScheme('wss')
          ? SecureSocket.startConnect(host, port, context: context)
          : Socket.startConnect(host, port);
    };
    return client;
  }
}

bool _isLoopback(String host) {
  if (host == 'localhost') return true;
  final address = InternetAddress.tryParse(host);
  return address != null && address.isLoopback;
}
