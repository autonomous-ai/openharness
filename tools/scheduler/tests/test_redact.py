import copy
import json
import unittest

from scheduler.redact import redact
from scheduler.swarm import convert
from tests.test_swarm import CONFIG, ROUTE_LOG, STATUS


def sample():
    status = copy.deepcopy(STATUS)
    state = status['value']['state']
    state['people'] = [{'id': 'p1', 'email': 'ken15@example.com', 'role': 'owner'},
                       {'id': 'p2', 'email': 'diego@example.com', 'role': 'collaborator'}]
    state['machines'][1]['name'] = "Diego's Mac"
    state['machines'][1]['cwd'] = '/Users/diego/.harness/cli/data/swarm-projects/x'
    state['conversations'][1]['brief'] = 'Ask ken15@example.com; push with https://bot:ghp_secret@github.com/o/r.git'
    state['projects'] = [{'id': 'p', 'name': 'proj', 'repository': {'repositoryUrl': 'https://bot:ghp_secret@github.com/o/r'}}]
    state['rules'][0]['text'] = "Owner: Ken's Mac takes no work until 21:00"
    log = copy.deepcopy(ROUTE_LOG) + [{'group': 'g9', 'request': {'difficulty': 'low', 'risk': 'low', 'size': 'small',
                                                                    'why': 'Continue on Diegos Mac; Ken knows it'}, 'at': None}]
    return status, log


class RedactTest(unittest.TestCase):
    def setUp(self):
        self.status, self.log = redact(*sample())
        self.text = json.dumps([self.status, self.log])

    def test_no_email_remains(self):
        self.assertNotIn('@example.com', self.text)
        self.assertNotIn('email', self.text)

    def test_no_url_with_credentials_or_token_remains(self):
        self.assertNotIn('ghp_secret', self.text)
        self.assertNotIn('bot:', self.text)

    def test_peoples_names_are_replaced_in_machine_names_rules_and_route_reasons(self):
        for name in ('Diego', 'Ken', 'diego'):
            self.assertNotIn(name, self.text)
        state = self.status['value']['state']
        self.assertEqual(state['machines'][1]['name'], "[person]'s Mac")
        self.assertEqual(state['rules'][0]['text'], "Owner: [person]'s Mac takes no work until 21:00")
        self.assertEqual(self.log[-1]['request']['why'], 'Continue on [person]s Mac; [person] knows it')

    def test_home_folders_and_briefs_are_left_out(self):
        self.assertNotIn('/Users/', self.text)
        self.assertNotIn('brief', self.text)

    def test_words_that_only_contain_a_name_are_kept(self):
        status, log = sample()
        log[-1]['request']['why'] = 'Deepseek token check'
        status['value']['state']['people'].append({'id': 'p3', 'email': 'dee@example.com'})
        self.assertEqual(redact(status, log)[1][-1]['request']['why'], 'Deepseek token check')

    def test_converting_the_redacted_inputs_gives_the_same_instance_apart_from_names(self):
        original = convert(*sample()[:1], ROUTE_LOG, CONFIG)
        redacted = convert(self.status, self.log[:len(ROUTE_LOG)], CONFIG)
        for m in original['instance']['machines']:
            m['name'] = m['name'].replace('Diego', '[person]')
        self.assertEqual(redacted, original)


if __name__ == '__main__':
    unittest.main()
