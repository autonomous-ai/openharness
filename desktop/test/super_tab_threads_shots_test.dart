import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_THREAD_SHOTS'];

/// Threads as the PR shows them: the main chat with a root's reply line, and
/// the thread open beside it, in both appearances.
void main() {
  setUpAll(() async {
    if (shots == null) return;
    await loadPreviewFonts();
    // Uploaded pictures, served from memory: the test fonts draw no emoji,
    // so presets would show as boxes.
    HttpOverrides.global = _Pictures({
      'ken': await _disc(const Color(0xFFE07A2E), const Color(0xFF7A3A10)),
      'pm': await _disc(const Color(0xFF3FA37A), const Color(0xFF1D5A42)),
    });
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer()..threads = true;
      // Faces as each wears them on their own messages: a person's picture,
      // the PM's avatar.
      (server.state['people'] as List)
        ..add({'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'})
        ..add({
          'id': 'ken',
          'email': 'ken@example.com',
          'role': 'owner',
          'avatar': {'kind': 'upload', 'url': superTabSignedAvatar('ken')},
        });
      (server.state['agents'] as List).add({
        'id': 'pm',
        'projectId': 'lead',
        'name': 'Lead',
        'displayName': 'River',
        'machineId': 'studio',
        'harnessId': 'h-pm',
        'contributorId': 'ken',
        'configuration': {'engine': 'claude', 'model': 'opus'},
        'avatar': {'kind': 'upload', 'url': superTabSignedAvatar('pm')},
      });
      const pm = {
        'kind': 'agent',
        'id': 'pm',
        'name': 'Lead',
        'displayName': 'River',
      };
      const dee = {'kind': 'person', 'id': 'dee', 'name': 'dee@example.com'};
      const ken = {'kind': 'person', 'id': 'ken', 'name': 'ken@example.com'};
      final now = DateTime.now().toUtc();
      void say(
        String text,
        Map<String, Object> author, {
        String? thread,
        bool alsoSend = false,
        int minutesAgo = 0,
      }) {
        server.append(text);
        server.messages.last
          ..['author'] = author
          ..['createdAt'] = now
              .subtract(Duration(minutes: minutesAgo))
              .toIso8601String();
        if (thread != null) {
          server.messages.last
            ..['thread'] = thread
            ..['replyTo'] = thread;
        }
        if (alsoSend) server.messages.last['alsoInChat'] = true;
      }

      say(
        'Should we do thread replies like Slack? Appending makes it hard to '
        'follow when we all talk to the PM at once.',
        dee,
        minutesAgo: 30,
      );
      say(
        'Yes. Each top-level message stays once in the chat, with its replies '
        'in a thread beside it.',
        pm,
        thread: 'message-1',
        minutesAgo: 20,
      );
      say(
        'Agents still read every reply in one feed.',
        ken,
        thread: 'message-1',
        minutesAgo: 9,
      );
      say(
        'Shipping it in wave 1 today.',
        pm,
        thread: 'message-1',
        alsoSend: true,
        minutesAgo: 2,
      );
      say('Morning digest is up for review.', ken, minutesAgo: 1);
      // A chat with a Lead, so messages read as sent.
      ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
      final c = server.controller(account: 'dee');
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1280, 720));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // The pictures arrive over (fake) HTTP.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 200)),
      );
      await tester.pumpAndSettle();

      Future<void> shot(String name) => tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/threads-$name-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });

      await shot('chat');
      await tester.tap(
        find.byKey(const ValueKey('super-thread-line-message-1')),
      );
      await tester.pumpAndSettle();
      await shot('panel');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}

/// A round picture in two tones, as someone might upload.
Future<Uint8List> _disc(Color light, Color dark) async {
  final recorder = ui.PictureRecorder();
  const size = 96.0;
  Canvas(recorder)
    ..drawRect(const Rect.fromLTWH(0, 0, size, size), Paint()..color = light)
    ..drawCircle(
      const Offset(size / 2, size * .42),
      size * .2,
      Paint()..color = dark,
    )
    ..drawOval(
      const Rect.fromLTWH(size * .18, size * .66, size * .64, size * .6),
      Paint()..color = dark,
    );
  final image = await recorder.endRecording().toImage(96, 96);
  final png = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return png!.buffer.asUint8List();
}

/// Serves each avatar link's picture by the id in its path.
class _Pictures extends HttpOverrides {
  _Pictures(this.byId);
  final Map<String, Uint8List> byId;
  @override
  HttpClient createHttpClient(SecurityContext? context) => _Client(byId);
}

class _Client implements HttpClient {
  _Client(this.byId);
  final Map<String, Uint8List> byId;
  @override
  bool autoUncompress = false;
  @override
  Future<HttpClientRequest> getUrl(Uri url) async =>
      _Request(byId[url.pathSegments.last] ?? Uint8List(0));
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Request implements HttpClientRequest {
  _Request(this.bytes);
  final Uint8List bytes;
  @override
  HttpHeaders get headers => _Headers();
  @override
  Future<HttpClientResponse> close() async => _Response(bytes);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Headers implements HttpHeaders {
  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Response extends Stream<List<int>> implements HttpClientResponse {
  _Response(this.bytes);
  final Uint8List bytes;
  @override
  int get statusCode => bytes.isEmpty ? 404 : 200;
  @override
  int get contentLength => bytes.length;
  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;
  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream.value(bytes as List<int>).listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
