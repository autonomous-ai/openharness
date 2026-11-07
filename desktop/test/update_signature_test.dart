import 'package:flutter_test/flutter_test.dart';
import 'package:harness/update/update_signature.dart';

/// `codesign -dv --verbose=2` of the published 1.3.89 Apple Silicon bundle.
const _released = '''
Executable=/Applications/Harness.app/Contents/MacOS/Harness
Identifier=ai.autonomous.harness
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=23009 flags=0x10000(runtime) hashes=708+7 location=embedded
Signature size=8980
Authority=Developer ID Application: Autonomous Inc. (54DJVWMJCC)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 7, 2026 at 1:30:44 PM
Notarization Ticket=stapled
Info.plist entries=31
TeamIdentifier=54DJVWMJCC
Runtime Version=15.5.0
Sealed Resources version=2 rules=13 files=20
Internal requirements count=1 size=216
''';

/// The same bundle re-signed ad hoc, as a local build is.
const _adHoc = '''
Executable=/tmp/x/Harness.app/Contents/MacOS/Harness
Identifier=ai.autonomous.harness
CodeDirectory v=20400 size=5870 flags=0x2(adhoc) hashes=177+3 location=embedded
Signature=adhoc
TeamIdentifier=not set
''';

const _ours = WindowsSigner(
  status: 'Valid',
  subject:
      'CN=AUTONOMOUS INC., O=AUTONOMOUS INC., L=Redlands, S=California, C=US',
  identity: '1.3.6.1.4.1.311.97.585055327.208923272.208213867.148721407',
);
const _microsoft = WindowsSigner(
  status: 'Valid',
  subject:
      'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  identity: '',
);
const _unsigned = WindowsSigner(status: 'NotSigned', subject: '', identity: '');

/// The 1.3.89 package's shape, with the catalog the release now signs.
WindowsSignatureReport _report({
  WindowsSigner running = _ours,
  Map<String, WindowsSigner>? files,
  WindowsCatalog? catalog = const WindowsCatalog(status: 'Valid', signer: _ours),
}) => WindowsSignatureReport(
  running: running,
  runningFolder: const {
    'harness-desktop.exe': _ours,
    'flutter_windows.dll': _ours,
    'WebView2Loader.dll': _microsoft,
  },
  files:
      files ??
      const {
        'Harness.exe': _ours,
        'harness-desktop.exe': _ours,
        'flutter_windows.dll': _ours,
        'WebView2Loader.dll': _microsoft,
      },
  catalog: catalog,
);

void main() {
  group('the running macOS app', () {
    test('a released build names its team, identifier and publisher', () {
      final signer = parseMacSigner(_released)!;
      expect(signer.team, '54DJVWMJCC');
      expect(signer.identifier, 'ai.autonomous.harness');
      expect(signer.name, 'Autonomous Inc.');
    });

    test('an ad-hoc or unsigned build has no signer to match', () {
      expect(parseMacSigner(_adHoc), isNull);
      expect(
        parseMacSigner('/x/Harness.app: code object is not signed at all\n'),
        isNull,
      );
    });

    test('output it cannot read refuses rather than passing as unsigned', () {
      expect(
        () => parseMacSigner('/x/Harness.app: No such file or directory\n'),
        throwsA(isA<UpdateRefused>()),
      );
      expect(() => parseMacSigner(''), throwsA(isA<UpdateRefused>()));
    });

    test('the requirement pins Developer ID, the team, the app and notarization', () {
      final requirement = macUpdateRequirement(parseMacSigner(_released)!);
      expect(requirement, startsWith('anchor apple generic'));
      expect(
        requirement,
        contains('certificate 1[field.1.2.840.113635.100.6.2.6]'),
      );
      expect(
        requirement,
        contains('certificate leaf[field.1.2.840.113635.100.6.1.13]'),
      );
      expect(requirement, contains('certificate leaf[subject.OU] = "54DJVWMJCC"'));
      expect(requirement, contains('identifier "ai.autonomous.harness"'));
      expect(requirement, endsWith('and notarized'));
    });
  });

  group('the Windows rule', () {
    test('the released shape passes: our files, Microsoft\'s WebView2 loader, a valid catalog', () {
      expect(windowsUpdateRefusal(_report()), isNull);
    });

    test('a running app that is itself unsigned has no signer to match', () {
      expect(
        windowsUpdateRefusal(_report(running: _unsigned, catalog: null)),
        isNull,
      );
    });

    test('a running app whose signature is broken refuses', () {
      expect(
        windowsUpdateRefusal(
          _report(
            running: const WindowsSigner(
              status: 'HashMismatch',
              subject: '',
              identity: '',
            ),
          ),
        ),
        contains('running'),
      );
    });

    test('an extra unsigned DLL refuses, naming it', () {
      expect(
        windowsUpdateRefusal(
          _report(
            files: const {
              'Harness.exe': _ours,
              'harness-desktop.exe': _ours,
              'evil.dll': _unsigned,
            },
          ),
        ),
        contains('evil.dll'),
      );
    });

    test('the app signed by someone else refuses, even a trusted publisher', () {
      expect(
        windowsUpdateRefusal(
          _report(
            files: const {'Harness.exe': _ours, 'harness-desktop.exe': _microsoft},
          ),
        ),
        contains('harness-desktop.exe'),
      );
    });

    test('the same company name under another identity refuses', () {
      const lookalike = WindowsSigner(
        status: 'Valid',
        subject:
            'CN=AUTONOMOUS INC., O=AUTONOMOUS INC., L=Redlands, S=California, C=US',
        identity: '1.3.6.1.4.1.311.97.1.2.3.4',
      );
      expect(
        windowsUpdateRefusal(
          _report(
            files: const {'Harness.exe': lookalike, 'harness-desktop.exe': _ours},
          ),
        ),
        contains('Harness.exe'),
      );
    });

    test('a missing launcher or app refuses', () {
      expect(
        windowsUpdateRefusal(
          _report(files: const {'harness-desktop.exe': _ours}),
        ),
        contains('Harness.exe'),
      );
    });

    test('no catalog, a changed file or an unsigned catalog refuses', () {
      expect(windowsUpdateRefusal(_report(catalog: null)), contains('catalog'));
      expect(
        windowsUpdateRefusal(
          _report(
            catalog: const WindowsCatalog(
              status: 'ValidationFailed',
              signer: _ours,
            ),
          ),
        ),
        contains('catalog'),
      );
      expect(
        windowsUpdateRefusal(
          _report(
            catalog: const WindowsCatalog(status: 'Valid', signer: _unsigned),
          ),
        ),
        contains('catalog'),
      );
      expect(
        windowsUpdateRefusal(
          _report(
            catalog: const WindowsCatalog(status: 'Valid', signer: _microsoft),
          ),
        ),
        contains('catalog'),
      );
    });

    test('the report reads what the PowerShell script prints', () {
      final report = WindowsSignatureReport.fromJson({
        'running': {'status': 'Valid', 'subject': 'CN=A', 'identity': '1.2'},
        'runningFolder': [
          {'path': 'a.dll', 'status': 'Valid', 'subject': 'CN=B', 'identity': ''},
        ],
        'files': [
          {'path': 'Harness.exe', 'status': 'NotSigned', 'subject': '', 'identity': ''},
        ],
        'catalog': {
          'status': 'Valid',
          'signer': {'status': 'Valid', 'subject': 'CN=A', 'identity': '1.2'},
        },
      });
      expect(report.running.subject, 'CN=A');
      expect(report.runningFolder['a.dll']!.subject, 'CN=B');
      expect(report.files['Harness.exe']!.status, 'NotSigned');
      expect(report.catalog!.signer.identity, '1.2');
      expect(
        WindowsSignatureReport.fromJson({
          'running': {'status': 'NotSigned', 'subject': '', 'identity': ''},
          'runningFolder': [],
          'files': [],
          'catalog': null,
        }).catalog,
        isNull,
      );
    });

    test('the publisher name comes from the certificate subject', () {
      expect(_ours.name, 'AUTONOMOUS INC.');
    });
  });
}
