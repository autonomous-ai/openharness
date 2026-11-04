import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/ssh_hosts.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory home;
  late List<List<String>> ran;
  late Map<String, String> hostnames;

  setUp(() async {
    home = await Directory.systemTemp.createTemp('harness-ssh-hosts-');
    await Directory(p.join(home.path, '.ssh')).create();
    ran = [];
    hostnames = {};
  });
  tearDown(() => home.delete(recursive: true));

  SshHosts hosts() => SshHosts(
    home: home.path,
    runSsh: (arguments) async {
      ran.add(arguments);
      final host = hostnames[arguments.last];
      return host == null ? null : 'user git\nhostname $host\nport 22\n';
    },
  );

  Future<void> config(String text, [String name = 'config']) =>
      File(p.join(home.path, '.ssh', name)).writeAsString(text);

  test('reads the host an alias stands for, from ssh -G', () async {
    hostnames['gh-work'] = 'github.com';
    expect(await hosts().resolveHost('gh-work'), 'github.com');
    expect(ran.single, ['-G', 'gh-work']);
  });

  test('never hands ssh a name that could be an option', () async {
    expect(await hosts().resolveHost('-oProxyCommand=evil'), isNull);
    expect(ran, isEmpty);
  });

  test('lists the GitHub aliases in config order, at most three', () async {
    await config('''
Host gh-a
  HostName github.com
Host *.internal !bad
  User me
Host gitlab-work gh-b
  HostName whatever
Host="gh-c"
Host gh-d gh-e
''');
    hostnames.addAll({
      'gh-a': 'github.com',
      'gitlab-work': 'gitlab.com',
      'gh-b': 'github.com',
      'gh-c': 'github.com',
      'gh-d': 'github.com',
    });
    expect(await hosts().githubAliases(), ['gh-a', 'gh-b', 'gh-c']);
    // Wildcards and negations are patterns, never asked about.
    expect(ran.map((a) => a.last), isNot(contains('*.internal')));
  });

  test('follows Include one level, relative to ~/.ssh', () async {
    await Directory(p.join(home.path, '.ssh', 'config.d')).create();
    await config('Include config.d/*\nHost gh-a\n');
    await config('Host gh-included\nInclude deeper\n', 'config.d/work');
    await config('Host gh-too-deep\n', 'deeper');
    hostnames.addAll({
      'gh-a': 'github.com',
      'gh-included': 'github.com',
      'gh-too-deep': 'github.com',
    });
    expect(await hosts().githubAliases(), ['gh-included', 'gh-a']);
  });

  test('a computer without an SSH config has no aliases', () async {
    expect(await hosts().githubAliases(), isEmpty);
  });

  test('GitHub over port 443 is GitHub, and ? globs an Include', () async {
    await Directory(p.join(home.path, '.ssh', 'conf.d')).create();
    await config('Include conf.d/work?\n');
    await config('Host gh-443\n', 'conf.d/work1');
    hostnames['gh-443'] = 'ssh.github.com';
    expect(await hosts().githubAliases(), ['gh-443']);
  });
}
