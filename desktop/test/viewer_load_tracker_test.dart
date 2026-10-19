// What a viewer pane makes of its webview's navigation reports: which ones fail a load, which put
// the "Waiting for the viewer" notice up, and when it tries again by itself.

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/state/viewer_load_tracker.dart';

const _viewer = 'http://127.0.0.1:4179/';

class _Rig {
  _Rig() {
    tracker = ViewerLoadTracker(
      begin: () {
        begun++;
        return outcomes.add;
      },
      load: loads.add,
      changed: () => changes++,
    );
  }

  late final ViewerLoadTracker tracker;
  int begun = 0, changes = 0;
  final outcomes = <ProductOutcome>[];
  final loads = <String>[];

  /// The app asks for [url] and the webview starts on it.
  void open(String url) {
    tracker
      ..request(url)
      ..started(url);
  }

  void refused(String url) => tracker.failed(
    code: -1004,
    domain: 'NSURLErrorDomain',
    url: url,
    description: 'Could not connect to the server.',
  );
}

void main() {
  test(
    'a navigation cancelled by the next one fails nothing and shows nothing',
    () {
      final r = _Rig()..open(_viewer);

      r.tracker.failed(
        code: -999,
        domain: 'NSURLErrorDomain',
        url: _viewer,
        description: 'cancelled',
      );
      r.tracker.failed(
        code: 102,
        domain: 'WebKitErrorDomain',
        url: _viewer,
        description: 'Frame load interrupted',
      );

      expect(r.tracker.failure, isNull);
      expect(r.outcomes, isEmpty);
      expect(r.tracker.measuring, isTrue, reason: 'what replaced it reports');
      r.tracker
        ..started(_viewer)
        ..finished(_viewer);
      expect(r.outcomes, [ProductOutcome.ok]);
      expect(r.begun, 1);
    },
  );

  test(
    'a late error about an earlier address leaves the current load alone',
    () {
      final r = _Rig()..open('http://127.0.0.1:4179/deck');
      // The daemon names the viewer's new address (another gateway port) while the first is loading.
      r.open('http://127.0.0.1:5200/__harness_viewer/t?path=%2F');

      r.refused('http://127.0.0.1:4179/deck');
      r.tracker.failed(
        code: -1100,
        domain: 'NSURLErrorDomain',
        url: 'http://127.0.0.1:4179/deck',
        description: 'The requested URL was not found on this server.',
      );

      expect(r.tracker.failure, isNull);
      expect(r.loads, isEmpty, reason: 'nothing to retry');
      r.tracker.finished('http://127.0.0.1:5200/');
      expect(r.outcomes, [ProductOutcome.ok]);
      expect(
        r.begun,
        1,
        reason: 'one viewer, still loading when its address moved',
      );
    },
  );

  test('a finished load takes the notice down', () {
    final r = _Rig()..open(_viewer);
    r.tracker.failed(
      code: 2,
      domain: 'WKErrorDomain',
      description: 'The web content process ended.',
    );
    expect(r.tracker.failure, 'The web content process ended.');
    expect(r.outcomes, [ProductOutcome.failed]);

    r.tracker
      ..started(_viewer)
      ..finished(_viewer);

    expect(r.tracker.failure, isNull);
    expect(r.tracker.loading, isFalse);
  });

  test('a refused viewer is retried on the same load, and fails once when the retries run out', () {
    fakeAsync((async) {
      final r = _Rig()..open(_viewer);
      final waits = <Duration>[];
      var waited = Duration.zero;

      r.refused(_viewer);
      for (var retry = 0; retry < 20 && r.tracker.measuring; retry++) {
        expect(r.tracker.failure, 'Could not connect to the server.');
        expect(r.tracker.loading, isTrue, reason: 'waiting to try again');
        final before = r.loads.length;
        var wait = Duration.zero;
        while (r.loads.length == before && wait < const Duration(minutes: 1)) {
          async.elapse(const Duration(milliseconds: 500));
          wait += const Duration(milliseconds: 500);
        }
        if (r.loads.length == before) break;
        waits.add(wait);
        waited += wait;
        expect(r.loads.last, _viewer);
        r.tracker.started(_viewer);
        r.refused(_viewer);
      }

      expect(waits, const [
        Duration(seconds: 1),
        Duration(seconds: 2),
        Duration(seconds: 4),
        Duration(seconds: 8),
        Duration(seconds: 8),
        Duration(seconds: 8),
      ]);
      expect(waited, const Duration(seconds: 31));
      expect(r.begun, 1);
      expect(r.outcomes, [ProductOutcome.failed]);
      expect(r.tracker.loading, isFalse);
      expect(r.tracker.failure, isNotNull);
      async.elapse(const Duration(minutes: 1));
      expect(r.loads, hasLength(6), reason: 'no retry after the last');
    });
  });

  test('a retry that loads counts the load once, ok', () {
    fakeAsync((async) {
      final r = _Rig()..open(_viewer);
      r.tracker.failed(
        code: -1005,
        domain: 'NSURLErrorDomain',
        url: _viewer,
        description: 'The network connection was lost.',
      );
      async.elapse(const Duration(seconds: 1));
      expect(r.loads, [_viewer]);

      r.tracker
        ..started(_viewer)
        ..finished(_viewer);

      expect(r.outcomes, [ProductOutcome.ok]);
      expect(r.tracker.failure, isNull);
      expect(r.begun, 1);
    });
  });

  test('a new address stops the old retries and carries on the same load', () {
    fakeAsync((async) {
      final r = _Rig()..open(_viewer);
      r.refused(_viewer);
      const moved = 'http://127.0.0.1:5200/';
      r.open(moved);
      expect(r.tracker.failure, isNull);

      async.elapse(const Duration(minutes: 1));
      expect(r.loads, isEmpty);
      r.tracker.finished(moved);
      expect(r.begun, 1);
      expect(r.outcomes, [ProductOutcome.ok]);
    });
  });

  test("a remote viewer's redirect belongs to its navigation", () {
    fakeAsync((async) {
      // The CLI's gateway answers its bootstrap address with a redirect to the viewer's own path.
      final r = _Rig()
        ..open('http://127.0.0.1:5200/__harness_viewer/t?path=%2F');

      r.tracker.failed(
        code: -1005,
        domain: 'NSURLErrorDomain',
        url: 'http://127.0.0.1:5200/',
        description: 'The network connection was lost.',
      );
      async.elapse(const Duration(seconds: 1));

      expect(r.loads, ['http://127.0.0.1:5200/__harness_viewer/t?path=%2F']);
    });
  });

  test("the page's own navigations and a Reload after a load start no new observation until asked", () {
    final r = _Rig()..open(_viewer);
    r.tracker.finished(_viewer);
    r.tracker
      ..started('${_viewer}page2')
      ..finished('${_viewer}page2');
    expect(r.begun, 1);

    // A person's Reload is a load of its own.
    r.open(_viewer);
    r.tracker.finished(_viewer);
    expect(r.begun, 2);
    expect(r.outcomes, [ProductOutcome.ok, ProductOutcome.ok]);
  });

  test('a pane closed mid-load ends its load unfinished', () {
    fakeAsync((async) {
      final r = _Rig()..open(_viewer);
      r.refused(_viewer);

      r.tracker.dispose();
      async.elapse(const Duration(minutes: 1));

      expect(r.outcomes, [ProductOutcome.cancelled]);
      expect(r.loads, isEmpty);
    });
  });
}
