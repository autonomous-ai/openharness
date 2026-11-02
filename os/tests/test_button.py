import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('button', Path(__file__).resolve().parents[1] / 'button.py')
button = importlib.util.module_from_spec(spec)
spec.loader.exec_module(button)


def pressed(count, times):
    return [count.press(at) for at in times]


class Presses(unittest.TestCase):
    def test_one_press_does_nothing(self):
        count = button.Count()
        self.assertEqual(pressed(count, [0]), [None])
        self.assertFalse(count.expired(100))

    def test_five_in_a_row_ask_and_one_more_resets(self):
        count = button.Count()
        self.assertEqual(pressed(count, [0, .4, .8, 1.2, 1.6]), [None, None, None, None, 'ask'])
        self.assertEqual(count.press(4), 'reset')

    def test_presses_held_a_moment_each_still_count(self):
        # An MSI laptop reports a press only after it was held about a second: two seconds apart.
        count = button.Count()
        self.assertEqual(pressed(count, [0, 2, 4, 6, 8])[-1], 'ask')

    def test_a_pause_starts_the_count_again(self):
        count = button.Count()
        self.assertEqual(pressed(count, [0, .5, 1, 1.5, 5, 5.5, 6, 6.5]), [None] * 8)
        self.assertEqual(count.press(7), 'ask')

    def test_no_answer_in_time_resets_nothing(self):
        count = button.Count()
        pressed(count, [0, .4, .8, 1.2, 1.6])
        self.assertFalse(count.expired(1.6 + button.CONFIRM - .1))
        self.assertTrue(count.expired(1.6 + button.CONFIRM))
        self.assertIsNone(count.press(20))

    def test_still_pressing_as_it_asks_is_not_the_answer(self):
        count = button.Count()
        self.assertEqual(pressed(count, [0, .4, .8, 1.2, 1.6, 2, 2.4]), [None, None, None, None, 'ask', None, None])
        self.assertEqual(count.press(4), 'reset')

    def test_one_press_seen_by_two_devices_is_one(self):
        count = button.Count()
        self.assertEqual(pressed(count, [0, .01, .5, .51, 1, 1.01, 1.5, 1.51, 2]), [None] * 8 + ['ask'])

    def test_after_a_reset_the_count_starts_over(self):
        count = button.Count()
        pressed(count, [0, .4, .8, 1.2, 1.6])
        self.assertEqual(count.press(4), 'reset')
        self.assertEqual(pressed(count, [5, 5.4, 5.8, 6.2]), [None] * 4)


if __name__ == '__main__':
    unittest.main()
