import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('codex_import', Path(__file__).parents[1] / 'src/codex_import.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def record(response='response-a', thread='fixture-thread', inputs=20, outputs=3, **extras):
    return {'type': 'token_usage_record', 'timestamp': '2026-10-16T10:00:00Z', 'payload': {
        'response_id': response, 'thread_id': thread, 'usage': {'input_tokens': inputs,
        'output_tokens': outputs, 'cached_tokens': 12, 'reasoning_tokens': 2}, **extras}}


class CodexImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = Path(self.tmp.name) / 'fixture.jsonl'
        self.db = Path(self.tmp.name) / 'private' / 'metadata.sqlite'

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, records, mode='w'):
        with self.source.open(mode) as stream:
            for value in records:
                stream.write(json.dumps(value) + '\n')

    def load(self):
        return collector.import_file(self.source, 'fixture-thread', self.db)

    def events(self):
        return collector.read_metadata(self.db)['events']

    def test_increments_only_no_cumulative_no_secrets(self):
        self.write([record(extra='FAKE_SECRET_PRIVATE_VALUE', thread_token_usage={'input_tokens': 99999}),
                    {'type': 'event_msg', 'payload': {'type': 'token_count', 'input_tokens': 99999}}])
        summary = self.load()
        self.assertEqual(summary['imported'], 1)
        event = self.events()[0]
        self.assertEqual(event['inputTokens'], 20)
        self.assertEqual(event['outputTokens'], 3)
        self.assertNotIn('cost', event)
        self.assertNotIn('FAKE_SECRET_PRIVATE_VALUE', self.db.read_bytes().decode('latin1'))
        self.assertNotIn('fixture-thread', json.dumps(self.events()))
        self.assertEqual(self.db.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.db.parent.stat().st_mode & 0o777, 0o700)

    def test_growth_and_repeated_import_exactly_once(self):
        self.write([record()])
        self.assertEqual(self.load()['imported'], 1)
        self.assertEqual(self.load()['imported'], 0)
        self.write([record('response-b', inputs=30)], 'a')
        self.assertEqual(self.load()['imported'], 1)
        self.assertEqual(sum(event['inputTokens'] for event in self.events()), 50)

    def test_duplicate_truncation_and_rotation_keep_dedupe(self):
        self.write([record(), record()])
        self.assertEqual(self.load()['duplicates'], 1)
        self.write([record('response-b')])
        self.assertEqual(self.load()['imported'], 1)
        previous = self.source.with_suffix('.old')
        self.source.rename(previous)
        self.write([record(), record('response-c')])
        self.assertEqual(self.load()['imported'], 1)
        self.assertEqual(len(self.events()), 3)

    def test_thread_fork_never_inherits_parent_counters(self):
        self.write([record(thread='parent-thread'), record('fork-own'), record(thread='different-thread')])
        self.assertEqual(self.load()['imported'], 1)
        self.assertEqual(len(self.events()), 1)

    def test_partial_line_not_advanced_until_completed(self):
        encoded = json.dumps(record())
        self.source.write_text(encoded[:70])
        self.assertTrue(self.load()['partialLine'])
        self.assertEqual(self.events(), [])
        with self.source.open('a') as stream:
            stream.write(encoded[70:] + '\n')
        self.assertEqual(self.load()['imported'], 1)

    def test_malformed_and_unknown_records_skip_without_snippets(self):
        self.source.write_text('MALFORMED_FAKE_PASSWORD\n' + json.dumps(record(inputs=True)) + '\n')
        summary = self.load()
        self.assertEqual(summary['malformed'], 2)
        self.assertNotIn('MALFORMED_FAKE_PASSWORD', json.dumps(summary))
        self.assertEqual(self.events(), [])

    def test_oversized_line_rolls_back_batch_and_cursor(self):
        self.write([record()])
        with self.source.open('a') as stream:
            stream.write('X' * (collector.LINE_LIMIT + 1) + '\n')
        with self.assertRaises(collector.ImportFailure):
            self.load()
        self.assertEqual(self.events(), [])
        self.write([record()])
        self.assertEqual(self.load()['imported'], 1)

    def test_read_batch_limit_resumes_without_duplicates(self):
        self.write([record('first'), record('second')])
        with patch.object(collector, 'RECORD_LIMIT', 1):
            self.assertEqual(self.load()['imported'], 1)
        self.assertEqual(self.load()['imported'], 1)
        self.assertEqual(len(self.events()), 2)

    def test_source_symlink_and_hardlink_rejected(self):
        self.write([record()])
        target = self.source.with_suffix('.target')
        self.source.rename(target)
        self.source.symlink_to(target)
        with self.assertRaises(OSError):
            self.load()
        self.source.unlink()
        os.link(target, self.source)
        with self.assertRaises(collector.ImportFailure):
            self.load()

    def test_database_symlink_and_unsafe_directory_rejected(self):
        self.write([record()])
        self.db.parent.mkdir(mode=0o700)
        victim = Path(self.tmp.name) / 'victim'
        victim.write_text('fixture')
        self.db.symlink_to(victim)
        with self.assertRaises(OSError):
            self.load()
        self.db.unlink()
        self.db.parent.chmod(0o755)
        with self.assertRaises(collector.ImportFailure):
            self.load()

    def test_foreign_database_unchanged_and_no_observer_tables_added(self):
        self.write([record()])
        self.db.parent.mkdir(mode=0o700)
        connection = sqlite3.connect(self.db)
        connection.execute('CREATE TABLE foreign_table(value TEXT)')
        connection.commit()
        connection.close()
        self.db.chmod(0o600)
        before = self.db.read_bytes()
        with self.assertRaises(collector.ImportFailure):
            self.load()
        self.assertEqual(self.db.read_bytes(), before)

    def test_sidecar_symlink_hardlink_and_tampered_schema_rejected(self):
        self.write([record()])
        self.load()
        victim = self.db.parent / 'victim'
        victim.write_bytes(b'fixture')
        victim.chmod(0o600)
        sidecar = Path(str(self.db) + '-wal')
        sidecar.symlink_to(victim)
        with self.assertRaises(OSError):
            self.load()
        sidecar.unlink()
        os.link(victim, sidecar)
        with self.assertRaises(collector.ImportFailure):
            self.load()
        sidecar.unlink()
        connection = sqlite3.connect(self.db)
        connection.execute('CREATE TABLE injected(payload TEXT)')
        connection.close()
        before = self.db.read_bytes()
        with self.assertRaises(collector.ImportFailure):
            self.load()
        self.assertEqual(before, self.db.read_bytes())

    def test_missing_deduplication_primary_key_rejected_before_writes(self):
        self.write([record()])
        self.load()
        connection = sqlite3.connect(self.db)
        connection.execute('DROP TABLE seen')
        connection.execute('CREATE TABLE seen(session TEXT NOT NULL,response TEXT NOT NULL)')
        connection.close()
        before = self.db.read_bytes()
        with self.assertRaises(collector.ImportFailure):
            self.load()
        self.assertEqual(before, self.db.read_bytes())

    def test_read_is_readonly_and_truncate_regrowth_tail_is_detected(self):
        self.write([record('first'), record('second'), record('third')])
        self.load()
        before = self.db.read_bytes()
        self.events()
        self.assertEqual(before, self.db.read_bytes())
        self.write([record('first'), record('second'), record('fresh')])
        self.assertEqual(self.load()['imported'], 1)
        self.assertEqual(len(self.events()), 4)

    def test_read_missing_database_never_initializes_directory(self):
        with self.assertRaises(FileNotFoundError):
            collector.read_metadata(self.db)
        self.assertFalse(self.db.parent.exists())


if __name__ == '__main__':
    unittest.main()
