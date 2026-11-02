import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/github_repository.dart';

/// The CLI's vectors (cli/src/lib/__fixtures__/github-repository-vectors.json):
/// the daemon clones another computer's harness and this app clones this
/// computer's, so both must read a pasted address the same way.
void main() {
  final vectors = jsonDecode(
    File('../cli/src/lib/__fixtures__/github-repository-vectors.json')
        .readAsStringSync(),
  ) as Map<String, dynamic>;

  test('parses every vector as the daemon does', () {
    for (final vector in vectors['parse'] as List) {
      final input = vector['input'] as String;
      final expected = vector['expect'] as Map<String, dynamic>?;
      final parsed = GitHubRepository.parse(input);
      if (expected == null) {
        expect(parsed, isNull, reason: input);
        continue;
      }
      expect(parsed, isNotNull, reason: input);
      expect(parsed!.url, expected['url'], reason: input);
      expect(parsed.owner, expected['owner'], reason: input);
      expect(parsed.name, expected['name'], reason: input);
      expect(parsed.transport.name, expected['transport'], reason: input);
      expect(parsed.alias, expected['alias'], reason: input);
    }
  });

  test('names one repository however its address is spelled', () async {
    for (final vector in vectors['identity'] as List) {
      final hosts = (vector['hosts'] as Map).cast<String, String>();
      final address = vector['address'] as String;
      expect(
        await resolvedRepositoryIdentity(address, (host) async => hosts[host]),
        vector['expect'],
        reason: address,
      );
    }
  });

  test('tries the addresses in the daemon\'s order', () {
    for (final vector in vectors['attempts'] as List) {
      final repository = GitHubRepository.parse(vector['input'] as String)!;
      expect(
        cloneAttempts(repository, (vector['aliases'] as List).cast<String>()),
        vector['expect'],
        reason: vector['input'] as String,
      );
    }
  });
}
