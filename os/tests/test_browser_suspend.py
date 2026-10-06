import unittest

from browser_suspend_guest import browser_main


class BrowserProcessTitleTest(unittest.TestCase):
    def test_recorded_chromium_process_titles(self):
        # Actual single-string titles from native run 37356952575. The browser
        # main and first zygote exposed the original observer's bad assumption.
        main = ['/usr/lib/chromium/chromium --ozone-platform=wayland --start-maximized '
                '--no-first-run --no-default-browser-check']
        child = ['/usr/lib/chromium/chromium --type=zygote --no-zygote-sandbox '
                 '--crashpad-handler-pid=1297 --enable-crash-reporter=,Arch Linux '
                 '--change-stack-guard-on-fork=enable']
        self.assertTrue(browser_main(main))
        self.assertFalse(browser_main(child))

    def test_normal_nul_separated_arguments(self):
        self.assertTrue(browser_main('/usr/lib/chromium/chromium\0--ozone-platform=wayland'.split('\0')))
        for kind in ['zygote', 'renderer', 'gpu-process', 'utility']:
            with self.subTest(kind=kind):
                command = '/usr/lib/chromium/chromium\0--type=' + kind + '\0--ozone-platform=wayland'
                self.assertFalse(browser_main(command.split('\0')))

    def test_type_flag_must_start_an_argument_or_whitespace_token(self):
        self.assertTrue(browser_main(['/usr/lib/chromium/chromium', '--user-data-dir=/tmp/--type=profile']))
        self.assertTrue(browser_main(['/usr/lib/chromium/chromium prefix--type=renderer']))
        self.assertFalse(browser_main(['/usr/lib/chromium/chromium\t--type=renderer']))

    def test_empty_process_title_is_not_a_browser_main(self):
        self.assertFalse(browser_main([]))
        self.assertFalse(browser_main(['']))


if __name__ == '__main__':
    unittest.main()
