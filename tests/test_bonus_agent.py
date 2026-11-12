"""Test offline cho phần bonus của agent (không gọi LLM API)."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import agent
from agent import run_agent, SYSTEM_PROMPT
from bonus.tools import BonusTools
from status_tools import StatusTools


def call(call_id, name, args):
    raw = json.dumps(args)
    m = {'role': 'assistant', 'content': None,
         'tool_calls': [{'id': call_id, 'type': 'function', 'function': {'name': name, 'arguments': raw}}]}
    return {'message': m, 'calls': [{'id': call_id, 'name': name, 'arguments': raw}], 'finish': 'tool_calls', 'usage': {}}


def final(answer):
    return {'message': {'role': 'assistant', 'content': answer}, 'calls': [], 'finish': 'stop', 'usage': {}}


class Scripted:
    def __init__(self, responses):
        self.responses, self.histories, self.schemas = iter(responses), [], []

    def complete(self, messages, schemas):
        self.histories.append(list(messages))
        self.schemas.append(schemas)
        return next(self.responses)


class FakeTools:
    """Tool giả: luôn trả RATE_LIMITED, kèm retry_after_seconds cấu hình được."""
    def __init__(self, retry_after=0):
        self.retry_after, self.executed = retry_after, 0

    def execute(self, name, args):
        self.executed += 1
        return {'ok': False, 'error': 'RATE_LIMITED', 'retry_after_seconds': self.retry_after}


class BonusAgentTests(unittest.TestCase):
    def test_bonus_tools_prompt_and_schemas_are_used(self):
        p = Scripted([final('xong')])
        run_agent('q', p, BonusTools())
        system = p.histories[0][0]['content']
        self.assertIn('DigitalOcean', system)           # prompt riêng của BonusTools
        self.assertIn('RATE_LIMITED', system)           # quy tắc bổ sung của agent
        self.assertIn('get_digitalocean_status', {x['function']['name'] for x in p.schemas[0]})

    def test_main_lab_prompt_unchanged(self):
        p = Scripted([final('xong')])
        run_agent('q', p, StatusTools('snapshot'))
        self.assertEqual(p.histories[0][0]['content'], SYSTEM_PROMPT)
        self.assertNotIn('get_vercel_status', {x['function']['name'] for x in p.schemas[0]})

    def test_rate_limit_capped_at_three_real_calls(self):
        t = BonusTools(scenario='rate_limit_always')
        p = Scripted([call(str(i), 'get_vercel_status', {}) for i in range(4)] + [final('Không biết status Vercel')])
        result = run_agent('q', p, t, max_steps=8)
        self.assertEqual(result['status'], 'completed')
        events = [e['event'] for e in result['trace'] if e['event'] in ('tool', 'tool_blocked')]
        self.assertEqual(events, ['tool', 'tool', 'tool', 'tool_blocked'])
        self.assertEqual(json.loads(p.histories[4][-1]['content'])['error'], 'RETRY_LIMIT_REACHED')

    def test_rate_limit_counted_per_provider(self):
        t = BonusTools(scenario='rate_limit_always')
        p = Scripted([call('a', 'get_vercel_status', {}), call('b', 'get_github_status', {}), final('ok')])
        result = run_agent('q', p, t, max_steps=5)
        self.assertEqual([e['event'] for e in result['trace'] if e['event'].startswith('tool')], ['tool', 'tool'])
        self.assertEqual(json.loads(p.histories[2][-1]['content'])['provider'], 'github')

    def test_retry_after_is_waited_but_capped(self):
        waits = []
        with patch.object(agent, '_sleep', waits.append):
            run_agent('q', Scripted([call('a', 'x', {}), final('ok')]), FakeTools(retry_after=3), max_steps=3)
            run_agent('q', Scripted([call('a', 'x', {}), final('ok')]), FakeTools(retry_after=999), max_steps=3)
            run_agent('q', Scripted([call('a', 'x', {}), final('ok')]), FakeTools(retry_after=0), max_steps=3)
        self.assertEqual(waits, [3, agent.MAX_RETRY_AFTER_SECONDS])

    def test_blocked_call_does_not_execute_tool(self):
        t = FakeTools()
        p = Scripted([call(str(i), 'x', {}) for i in range(5)] + [final('ok')])
        run_agent('q', p, t, max_steps=8)
        self.assertEqual(t.executed, agent.MAX_RATE_LIMIT_HITS)


if __name__ == '__main__':
    unittest.main()
