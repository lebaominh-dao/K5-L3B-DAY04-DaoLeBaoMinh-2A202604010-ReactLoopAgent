"""Retry khi provider lỗi tạm thời (offline, không chờ thật)."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent
from agent import run_agent
from status_tools import StatusTools
from test_lab import final


class FlakyProvider:
    """Ném lần lượt các exception trong `errors`, sau đó trả `response`."""
    def __init__(self, errors, response):
        self.errors = list(errors)
        self.response = response
        self.calls = 0
    def complete(self, messages, schemas):
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return self.response


RATE_LIMIT = RuntimeError('Provider trả HTTP 429; kiểm tra model, key và quota.')


@patch.object(agent, '_sleep', lambda s: None)
class RetryTests(unittest.TestCase):
    def test_transient_429_recovers_without_using_extra_steps(self):
        fake = FlakyProvider([RATE_LIMIT, RATE_LIMIT], final('ok'))
        result = run_agent('x', fake, StatusTools(), max_steps=1)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(fake.calls, 3)
        retries = [e for e in result['trace'] if e['event'] == 'provider_retry']
        self.assertEqual([e['attempt'] for e in retries], [1, 2])

    def test_persistent_429_stops_after_limit(self):
        fake = FlakyProvider([RATE_LIMIT] * 10, final('ok'))
        result = run_agent('x', fake, StatusTools())
        self.assertEqual(result['status'], 'error')
        self.assertEqual(fake.calls, len(agent.RETRY_DELAYS) + 1)
        self.assertIn('429', result['error'])

    def test_non_retryable_error_fails_immediately(self):
        fake = FlakyProvider([RuntimeError('Provider trả HTTP 401; kiểm tra model, key và quota.')], final('ok'))
        result = run_agent('x', fake, StatusTools())
        self.assertEqual(result['status'], 'error')
        self.assertEqual(fake.calls, 1)
        self.assertFalse(any(e['event'] == 'provider_retry' for e in result['trace']))


if __name__ == '__main__':
    unittest.main()
