@TestOn('browser')
library;

import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/web/notify/browser_system_notifier.dart';

/// Headless Chrome will not grant notifications, so the page's `Notification`
/// is swapped for a fake that records what the notifier asked of it.
void _installFakeNotification({
  required String permission,
  bool throws = false,
}) {
  globalContext.callMethod<JSAny?>(
    'eval'.toJS,
    '''
    window.__realNotification ??= window.Notification;
    window.__shown = [];
    window.__permission = '$permission';
    window.Notification = class {
      constructor(title, options) {
        if ($throws) throw new TypeError('Illegal constructor');
        this.title = title;
        this.options = options;
        this.closed = false;
        window.__shown.push(this);
      }
      close() { this.closed = true; }
      static get permission() { return window.__permission; }
      static requestPermission() {
        window.__permission = 'granted';
        return Promise.resolve('granted');
      }
    };
    '''
        .toJS,
  );
}

JSArray<JSObject> get _shown => globalContext['__shown'] as JSArray<JSObject>;

JSObject _shownAt(int index) => _shown.toDart[index];

String _string(JSObject object, String path) {
  JSObject target = object;
  final parts = path.split('.');
  for (final part in parts.take(parts.length - 1)) {
    target = target[part] as JSObject;
  }
  return (target[parts.last] as JSString).toDart;
}

bool _closed(JSObject notification) =>
    (notification['closed'] as JSBoolean).toDart;

void _click(JSObject notification) =>
    (notification['onclick'] as JSFunction).callAsFunction(
      notification,
      JSObject(),
    );

Future<NotificationPermission> _show(
  BrowserSystemNotifier notifier, {
  String id = 'harness-agent:m1/a1',
  String title = 'GroupMe',
  String body = 'is waiting for you',
}) => notifier.show(
  id: id,
  title: title,
  body: body,
  machineId: 'm1',
  agentId: 'a1',
);

void main() {
  tearDown(() {
    globalContext.callMethod<JSAny?>(
      'eval'.toJS,
      'if (window.__realNotification) window.Notification = window.__realNotification;'
          .toJS,
    );
  });

  test('the browser build posts through the browser', () {
    expect(platformSystemNotifier(), isA<BrowserSystemNotifier>());
    final notifier = BrowserSystemNotifier();
    expect(notifier.supported, isTrue);
    expect(notifier.clickOpensAgent, isTrue);
    expect(notifier.deniedAdvice, contains('site settings'));
  });

  test('asks once when nobody has, and reads an answer already given', () async {
    _installFakeNotification(permission: 'default');
    expect(
      await BrowserSystemNotifier().authorize(),
      NotificationPermission.granted,
    );

    _installFakeNotification(permission: 'denied');
    expect(
      await BrowserSystemNotifier().authorize(),
      NotificationPermission.denied,
    );
  });

  test('posts nothing without permission', () async {
    _installFakeNotification(permission: 'denied');

    expect(await _show(BrowserSystemNotifier()), NotificationPermission.denied);
    expect(_shown.length, 0);
  });

  test('one per agent: the next replaces the last', () async {
    _installFakeNotification(permission: 'granted');
    final notifier = BrowserSystemNotifier();

    expect(await _show(notifier, body: 'finished'), NotificationPermission.granted);
    await _show(notifier, body: 'is waiting for you');

    expect(_shown.length, 2);
    expect(_closed(_shownAt(0)), isTrue);
    expect(_closed(_shownAt(1)), isFalse);
    expect(_string(_shownAt(1), 'title'), 'GroupMe');
    expect(_string(_shownAt(1), 'options.body'), 'is waiting for you');
    expect(_string(_shownAt(1), 'options.tag'), 'harness-agent:m1/a1');
  });

  test('a click opens its agent and closes the notification', () async {
    _installFakeNotification(permission: 'granted');
    final notifier = BrowserSystemNotifier();
    final opened = <String>[];
    notifier.onTap = (machineId, agentId) => opened.add('$machineId/$agentId');

    await _show(notifier);
    _click(_shownAt(0));

    expect(opened, ['m1/a1']);
    expect(_closed(_shownAt(0)), isTrue);
  });

  test('withdraw takes it down once the agent is seen', () async {
    _installFakeNotification(permission: 'granted');
    final notifier = BrowserSystemNotifier();

    await _show(notifier);
    await notifier.withdraw('harness-agent:m1/a1');

    expect(_closed(_shownAt(0)), isTrue);
  });

  test("a phone's browser, which only posts from a service worker", () async {
    _installFakeNotification(permission: 'granted', throws: true);

    expect(
      await _show(BrowserSystemNotifier()),
      NotificationPermission.unavailable,
    );
  });
}
