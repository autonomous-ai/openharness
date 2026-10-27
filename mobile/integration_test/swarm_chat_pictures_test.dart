import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// A picture in a Swarm chat on a simulator, a screenshot at each step: its
/// skeleton while it loads, the picture in place beside a PDF's chip, and the
/// picture full screen.
///
/// The Swarm is scripted in memory ([FakeSwarm]) and Harness's file storage
/// is answered in the app ([HttpOverrides]) with a picture drawn here: nothing
/// reaches an account, a machine, the backend or the network. The files are
/// kept in the app's real private temporary folder and emptied at the end.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_chat_pictures_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a picture in a chat, in place and full screen', (tester) async {
    final storage = _Storage(await _picture());
    final before = HttpOverrides.current;
    HttpOverrides.global = storage;
    addTearDown(() => HttpOverrides.global = before);
    await swarmAttachments.keepOnly(me);
    addTearDown(() => swarmAttachments.keepOnly(null));

    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: _swarm().request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    );
    addTearDown(host.dispose);
    final brightness = grid.AppTheme.palette.value.brightness;
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => grid.BrightnessScope(
          child: SwarmScope(notifier: host, child: child!),
        ),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      ),
    );

    Future<void> wait(int ms) async {
      for (var elapsed = 0; elapsed < ms; elapsed += 100) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> waitFor(Finder finder) async {
      for (var i = 0; i < 200 && finder.evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(finder, findsWidgets);
    }

    var step = 0;
    Future<void> shot(String name) async {
      await wait(900);
      step++;
      await binding.takeScreenshot(
        'swarm-pictures-${step.toString().padLeft(2, '0')}-$name',
      );
    }

    final preview = find.byKey(const ValueKey('swarm-attachment-preview-f1'));

    // ① Loading: a skeleton in the picture's box, beside the PDF's chip.
    await waitFor(preview);
    await waitFor(find.textContaining('plan.pdf'));
    await shot('loading');

    // ② The picture in the same box.
    storage.hold.complete();
    await waitFor(
      find.descendant(of: preview, matching: find.byType(RawImage)),
    );
    await shot('picture');
    expect(storage.asked, hasLength(1));
    expect(storage.credentials, isEmpty, reason: 'fetched as the chip opens');

    // ③ A tap: full screen, to pinch and zoom.
    await tester.tap(preview);
    await waitFor(find.byKey(const ValueKey('swarm-attachment-viewer')));
    await shot('full-screen');

    await tester.tap(find.byKey(const ValueKey('swarm-attachment-close')));
    await wait(900);
    expect(preview, findsOneWidget);
  }, timeout: const Timeout(Duration(minutes: 2)));
}

/// A chat whose one message carries a screenshot and a PDF.
FakeSwarm _swarm() {
  Map<String, dynamic> file(String id, String name, String mime) => {
    'id': id,
    'name': name,
    'mime': mime,
    'size': 184320,
    'url': 'https://$swarmAttachmentHost/$id/$name',
  };
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
    ...firstLoad(
      groups: [
        groupData(
          'g1',
          title: 'Sign in with passkeys',
          agentIds: ['agent-builder'],
          lastMessageSequence: 1,
        ),
      ],
      agents: [agent('agent-builder', displayName: 'Nova')],
    ),
    'members': [part(me, 1, person(me))],
  };
  fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
  fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
    'decisions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
    'mentions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/conversations/g1/messages'] = (_) => {
    'messages': [
      {
        'id': 'm1',
        'conversationId': 'g1',
        'text': 'The new sign-in sheet on the simulator, and the plan.',
        'sequence': 1,
        'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
        'attachments': [
          file('f1', 'sign-in-sheet.png', 'image/png'),
          file('f2', 'plan.pdf', 'application/pdf'),
        ],
        'createdAt': DateTime.now().toUtc().toIso8601String(),
      },
    ],
    'next': null,
  };
  return fake;
}

/// A screenshot-like picture, 1200 × 1600: a sign-in sheet in outline.
Future<List<int>> _picture() async {
  const size = Size(1200, 1600);
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Offset.zero & size,
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, Offset(0, size.height), [
        const Color(0xFF1F3A5F),
        const Color(0xFF0E1726),
      ]),
  );
  final card = RRect.fromRectAndRadius(
    const Rect.fromLTWH(120, 420, 960, 900),
    const Radius.circular(48),
  );
  canvas.drawRRect(card, Paint()..color = const Color(0xFFF5F7FA));
  final bar = Paint()..color = const Color(0xFFD5DCE6);
  for (final (top, width) in [(520.0, 520.0), (620.0, 760.0), (700.0, 640.0)]) {
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(200, top, width, 36),
        const Radius.circular(18),
      ),
      bar,
    );
  }
  canvas.drawRRect(
    RRect.fromRectAndRadius(
      const Rect.fromLTWH(200, 1100, 800, 120),
      const Radius.circular(60),
    ),
    Paint()..color = const Color(0xFF3B82F6),
  );
  final image = await recorder.endRecording().toImage(
    size.width.toInt(),
    size.height.toInt(),
  );
  final png = await image.toByteData(format: ui.ImageByteFormat.png);
  return png!.buffer.asUint8List();
}

/// Harness's file storage, answered in the app: [picture] for every link,
/// once [hold] completes; what was asked and with which credentials.
class _Storage extends HttpOverrides {
  _Storage(this.picture);

  final List<int> picture;
  final hold = Completer<void>();
  final asked = <Uri>[];
  final credentials = <String>[];

  @override
  HttpClient createHttpClient(SecurityContext? context) => _Client(this);
}

class _Client extends Fake implements HttpClient {
  _Client(this.storage);

  final _Storage storage;

  @override
  bool autoUncompress = true;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async {
    storage.asked.add(url);
    return _Request(storage);
  }

  @override
  void close({bool force = false}) {}
}

class _Request extends Fake implements HttpClientRequest {
  _Request(this.storage);

  final _Storage storage;

  @override
  bool followRedirects = true;

  @override
  int maxRedirects = 5;

  @override
  int contentLength = -1;

  @override
  bool persistentConnection = true;

  @override
  final HttpHeaders headers = _Headers();

  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.drain<void>();

  @override
  Future<HttpClientResponse> close() async {
    final auth = (headers as _Headers).values['authorization'];
    if (auth != null) storage.credentials.add(auth);
    await storage.hold.future;
    return _Response(storage.picture);
  }
}

class _Headers extends Fake implements HttpHeaders {
  final values = <String, String>{};

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) =>
      values[name.toLowerCase()] = '$value';

  @override
  void forEach(void Function(String name, List<String> values) action) =>
      values.forEach((name, value) => action(name, [value]));
}

class _Response extends Stream<List<int>> implements HttpClientResponse {
  _Response(this._bytes);

  final List<int> _bytes;

  @override
  int get statusCode => 200;

  @override
  int get contentLength => _bytes.length;

  @override
  final HttpHeaders headers = _Headers()
    ..set('content-type', 'image/png')
    ..set('cache-control', 'public, max-age=31536000, immutable');

  @override
  bool get isRedirect => false;

  @override
  bool get persistentConnection => false;

  @override
  String get reasonPhrase => 'OK';

  @override
  List<RedirectInfo> get redirects => const [];

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream.value(_bytes).listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
