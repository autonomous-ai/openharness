import 'package:flutter_test/flutter_test.dart';
import 'package:harness/browser/browser_settings.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

void main() {
  Agent agent([Object? browser]) =>
      Agent.fromJson({'id': 'a1', 'name': 'Faye', 'browser': ?browser});

  test('Agent.fromJson keeps known browser values and drops unknown ones', () {
    expect(agent().browser, isNull);
    expect(
      agent({'state': 'setup', 'step': 'starting_podman'}).browser,
      const AgentBrowser(state: 'setup', step: 'starting_podman'),
    );
    expect(
      agent({'state': 'failed', 'error': 'podman_down'}).browser,
      const AgentBrowser(state: 'failed', error: 'podman_down'),
    );
    expect(
      agent({'state': 'ready'}).browser,
      const AgentBrowser(state: 'ready'),
    );
    // A step only in setup, an error only in failed, and only known ones.
    expect(
      agent({'state': 'ready', 'step': 'building', 'error': 'podman_down'})
          .browser,
      const AgentBrowser(state: 'ready'),
    );
    expect(
      agent({'state': 'setup', 'step': 'unknown_step'}).browser,
      const AgentBrowser(state: 'setup'),
    );
    expect(
      agent({'state': 'failed', 'error': 'Podman exploded'}).browser,
      const AgentBrowser(state: 'failed'),
    );
    expect(agent({'state': 'flying'}).browser, isNull);
    expect(agent('ready').browser, isNull);
    // A rename keeps it.
    expect(
      agent({'state': 'ready'}).copyWith(name: 'Juno').browser,
      const AgentBrowser(state: 'ready'),
    );
  });

  test('agentsEqual sees a browser state change', () {
    final starting = agent({'state': 'starting'});
    expect(
      AppNotifier.agentsEqual(
        [starting],
        [
          agent({'state': 'starting'}),
        ],
      ),
      isTrue,
    );
    expect(
      AppNotifier.agentsEqual(
        [starting],
        [
          agent({'state': 'ready'}),
        ],
      ),
      isFalse,
    );
    expect(
      AppNotifier.agentsEqual(
        [
          agent({'state': 'setup', 'step': 'installing'}),
        ],
        [
          agent({'state': 'setup', 'step': 'building'}),
        ],
      ),
      isFalse,
    );
    expect(AppNotifier.agentsEqual([agent()], [starting]), isFalse);
  });

  test('settings read what the machine sends and save with a password only '
      'when one is given', () {
    final settings = BrowserSettings.fromJson({
      'proxy': {
        'scheme': 'https',
        'host': 'proxy.example',
        'port': 443,
        'username': 'ken',
        'passwordSet': true,
      },
      'timeZone': 'Asia/Ho_Chi_Minh',
      'languages': 'vi-VN, en-US',
      'screen': '1366x768',
      'humanInput': false,
      'humanSpeed': 'fast',
      'device': {
        'gpuVendor': 'Apple',
        'gpuRenderer': 'Apple M3',
        'cpuCores': 8,
        'memoryGb': 16,
      },
    });
    final saved = settings.toSave();
    expect(saved, {
      'proxy': {
        'scheme': 'https',
        'host': 'proxy.example',
        'port': 443,
        'username': 'ken',
      },
      'timeZone': 'Asia/Ho_Chi_Minh',
      'languages': 'vi-VN, en-US',
      'screen': '1366x768',
      'humanInput': false,
      'humanSpeed': 'fast',
      'device': {
        'gpuVendor': 'Apple',
        'gpuRenderer': 'Apple M3',
        'cpuCores': 8,
        'memoryGb': 16,
      },
    });
    expect(
      (settings.toSave(password: 'secret')['proxy'] as Map)['password'],
      'secret',
    );
    // What the machine sends that this build does not know falls back to the defaults.
    final odd = BrowserSettings.fromJson({
      'proxy': {'scheme': 'ftp', 'host': 'x', 'port': 1},
      'screen': '800x600',
      'humanSpeed': 'warp',
    });
    expect(odd.proxy, isNull);
    expect(odd.screen, '1920x1080');
    expect(odd.humanInput, isTrue);
    expect(odd.humanSpeed, 'normal');
    expect(odd.device, isNull);
  });
}
