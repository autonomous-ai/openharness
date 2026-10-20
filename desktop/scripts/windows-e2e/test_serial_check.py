"""Native script tests with a private fake executable; never opens a COM port.

Run with unittest discover on Windows with Python and Windows PowerShell 5.1.
Other hosts skip these rows, including parsing; they do not establish native evidence.
"""
import base64
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


POWERSHELL = shutil.which('powershell.exe') if os.name == 'nt' else None
HERE = Path(__file__).resolve().parent
SERIAL = '28:84:85:00:00:99'  # Synthetic test data, never a device identifier.
FAKE = r'''
using System;
using System.IO;
using System.Threading;
public class SerialFixture {
    public static int Main(string[] args) {
        string mode = Environment.GetEnvironmentVariable("SERIAL_CASE");
        string events = Environment.GetEnvironmentVariable("SERIAL_EVENTS");
        string serial = "28:84:85:00:00:99";
        File.AppendAllText(events, args[0] + ":" + System.Diagnostics.Process.GetCurrentProcess().Id + "\n");
        if (args[0] == "watch") {
            if (mode == "watch-timeout") Thread.Sleep(30000);
            if (mode == "malformed") Console.WriteLine("not JSON " + serial);
            else if (mode == "missing-port") Console.WriteLine("{\"console\":false,\"ports\":[],\"diagnostic\":\"" + serial + "\"}");
            else {
                int watches = 0;
                foreach (string line in File.ReadAllLines(events)) if (line.StartsWith("watch:")) watches++;
                string id = mode == "serial-session" ? serial : (mode == "changed-session" && watches > 1 ? "2" : "1");
                string session = mode == "missing-session" ? "" : ",\"session\":\"" + id + "\"";
                Console.WriteLine("{\"console\":false,\"ports\":[{\"path\":\"COM3\",\"serialNumber\":\"" + serial + "\"" + session + "}]}");
            }
            Console.Out.Flush();
            Console.In.ReadToEnd();
            if (mode == "watch-exit-timeout") Thread.Sleep(30000);
            if (mode == "watch-error") { Console.Error.WriteLine(serial); return 2; }
            return 0;
        }
        if (args[0] != "open" || args.Length != 2 || args[1] != "COM3") return 2;
        if (mode == "open-timeout") Thread.Sleep(30000);
        if (mode == "busy") { Console.Error.WriteLine("busy " + serial); return 3; }
        Console.Error.WriteLine("open");
        Console.Error.Flush();
        if (mode == "early-exit") return 0;
        if (mode == "banner") {
            Console.Write("ESP-"); Console.Out.Flush(); Thread.Sleep(100);
            Console.Write("ROM:");
        } else if (mode == "shutdown-banner") Console.Write("ESP-");
        else Console.Write("dial bytes");
        Console.Out.Flush();
        if (mode == "noisy-error") { Console.Error.WriteLine(serial); Console.Error.Flush(); }
        Console.In.ReadToEnd();
        if (mode == "shutdown-banner") { Console.Write("ROM:"); Console.Out.Flush(); }
        if (mode == "shutdown-burst-banner") {
            Console.Write(new string('x', 131072) + "ESP-ROM:"); Console.Out.Flush();
        }
        if (mode == "open-exit-timeout") Thread.Sleep(30000);
        return mode == "bad-exit" ? 5 : 0;
    }
}
'''


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def powershell(source, **kwargs):
    source = "$ProgressPreference='SilentlyContinue'; " + source
    encoded = base64.b64encode(source.encode('utf-16le')).decode('ascii')
    return subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                          capture_output=True, text=True, timeout=30, **kwargs)


@unittest.skipUnless(POWERSHELL, 'native Windows PowerShell 5.1 unavailable; no parse/runtime evidence')
class SerialCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.build.cleanup)
        source = Path(cls.build.name) / 'fake.cs'
        source.write_text(FAKE, encoding='ascii')
        cls.binary = Path(cls.build.name) / 'harness-serial.exe'
        result = powershell("$ErrorActionPreference='Stop'; Add-Type -TypeDefinition "
                            f"(Get-Content -Raw -LiteralPath {ps_quote(source)}) -Language CSharp "
                            f"-OutputAssembly {ps_quote(cls.binary)} -OutputType ConsoleApplication")
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    def check(self, mode='success', args=(), have_binary=True):
        with tempfile.TemporaryDirectory(prefix="serial check ' & ") as folder:
            root = Path(folder)
            script = root / 'serial-check.ps1'
            shutil.copyfile(HERE / 'serial-check.ps1', script)
            if have_binary:
                shutil.copyfile(self.binary, root / self.binary.name)
            events = root / 'events.txt'
            env = dict(os.environ, SERIAL_CASE=mode, SERIAL_EVENTS=str(events))
            started = time.monotonic()
            try:
                duration = [] if '-Seconds' in args else ['-Seconds', '1']
                result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(script),
                                         *duration, *args], env=env, capture_output=True, text=True, timeout=22)
            finally:
                # Detect and remove only a leaked fixture binary in this test's private directory.
                rows = events.read_text().splitlines() if events.exists() else []
                pids = [int(row.split(':')[1]) for row in rows]
                # PS 5.1 leaves $? false for an already-exited PID; explicit success follows all checks.
                # Unexpected inspection/Stop-Process errors must terminate before that success exit.
                leaked = powershell("$ErrorActionPreference='Stop'; "
                                    f"$ids=@({','.join(map(str, pids))}); "
                                    "foreach ($childId in $ids) { $p=Get-Process -Id $childId -ErrorAction SilentlyContinue; "
                                    f"if ($p -and $p.Path -eq {ps_quote(root / self.binary.name)}) {{ "
                                    "$p.Id; $p | Stop-Process -Force } }; exit 0")
                self.assertEqual(leaked.returncode, 0, leaked.stdout + leaked.stderr)
                self.assertEqual(leaked.stdout.strip(), '', 'script leaked an owned fake child')
            self.assertLess(time.monotonic() - started, 22)
            self.assertNotIn(SERIAL, result.stdout + result.stderr)
            return result, [row.split(':')[0] for row in rows]

    def test_success_reads_bytes_and_compares_sessions(self):
        result, events = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for line in ('opened: True (open)', 'stayed open for 1 s: True', 'bytes read: 10',
                     'ESP-ROM banner seen: False', 'exit at end of stdin: 0', 'session unchanged: True'):
            self.assertIn(line, result.stdout)
        self.assertEqual(events, ['watch', 'open', 'watch'])

    def test_watch_only_never_opens_the_port(self):
        result, events = self.check(args=['-WatchOnly'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['session: 1', 'console session: False'])
        self.assertEqual(events, ['watch'])

    def test_shutdown_drains_pending_and_multiple_reads_before_accepting_no_banner(self):
        for mode, count in (('shutdown-banner', 8), ('shutdown-burst-banner', 131090)):
            with self.subTest(mode=mode):
                result, events = self.check(mode)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn('ESP-ROM banner seen: True', result.stdout)
                self.assertIn(f'bytes read: {count}', result.stdout)
                self.assertIn('exit at end of stdin: 0', result.stdout)
                self.assertEqual(events, ['watch', 'open', 'watch'])

    def test_watch_only_redacts_a_serial_embedded_in_the_session(self):
        result, events = self.check('serial-session', args=['-WatchOnly'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('session: (redacted)', result.stdout)
        self.assertEqual(events, ['watch'])

    def test_failures_are_nonzero_redacted_bounded_and_cleaned(self):
        for mode in ('malformed', 'missing-port', 'missing-session', 'watch-error', 'watch-timeout',
                     'watch-exit-timeout', 'busy', 'open-timeout', 'early-exit', 'banner', 'bad-exit',
                     'open-exit-timeout', 'changed-session', 'noisy-error'):
            with self.subTest(mode=mode):
                result, _ = self.check(mode)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_bad_inputs_and_missing_binary_spawn_nothing(self):
        for args, have_binary in ((['-Port', 'not-a-port'], True), (['-Seconds', '0'], True), ([], False)):
            with self.subTest(args=args, have_binary=have_binary):
                result, events = self.check(args=args, have_binary=have_binary)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(events, [])

    def test_script_parses_in_windows_powershell(self):
        result = powershell(f"$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile("
                            f"{ps_quote(HERE / 'serial-check.ps1')}, [ref]$tokens, [ref]$errors) | Out-Null; "
                            "$errors | ForEach-Object { $_.Message }; exit $errors.Count")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
