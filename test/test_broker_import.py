import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('broker_import', Path(__file__).parents[1] / 'src/broker_import.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def record(identity='a', stage='execute', status='ok', **extra):
    return {'schemaVersion': 1, 'source': 'agent-credential-broker', 'eventId': identity * 64,
            'event': stage, 'actionIdHash': 'c' * 16, 'status': status, 'durationMs': 25, **extra}


class BrokerImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = Path(self.tmp.name) / 'metadata.jsonl'
        self.db = Path(self.tmp.name) / 'private' / 'broker.sqlite'

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, records):
        self.source.write_text(''.join(json.dumps(value) + '\n' for value in records))

    def load(self):
        return collector.import_file(self.source, self.db)

    def test_repeat_copy_rotation_growth_deduplicate(self):
        self.write([record(), record('b', 'intent', 'intent')])
        self.assertEqual(self.load()['imported'], 2)
        self.assertEqual(self.load()['imported'], 0)
        self.source.rename(self.source.with_suffix('.old'))
        self.write([record(), record('d', 'outcome', 'uncertain')])
        self.assertEqual(self.load()['imported'], 1)
        events = collector.read_metadata(self.db)
        self.assertEqual(len(events['events']), 3)
        self.assertEqual(events['events'][1]['event'], 'checkpoint')
        self.assertEqual(events['events'][2]['status'], 'uncertain')
        self.assertFalse(events['coverage']['executionTimestampsAvailable'])
        self.assertFalse(events['coverage']['agentIdentityAvailable'])
        self.assertNotIn('inputTokens', events['events'][0])

    def test_secret_fields_fail_before_creating_database(self):
        for extra in ({'Authorization': 'PRIVATE_SENTINEL'}, {'body': 'PRIVATE_SENTINEL'}, {'uid': 1000}):
            self.write([record(), record('b', **extra)])
            with self.assertRaises(collector.ImportFailure):
                self.load()
            self.assertFalse(self.db.exists())

    def test_invalid_import_leaves_database_and_deduplication_unchanged(self):
        self.write([record()])
        self.load()
        before = self.db.read_bytes()
        self.write([record('b'), record('c', durationMs=True)])
        with self.assertRaises(collector.ImportFailure):
            self.load()
        self.assertEqual(before, self.db.read_bytes())
        self.write([record('b')])
        self.assertEqual(self.load()['imported'], 1)

    def test_duplicate_keys_invalid_pairs_and_arbitrary_status_rejected(self):
        self.source.write_text(json.dumps(record())[:-1] + ',"status":"PRIVATE_SENTINEL"}\n')
        with self.assertRaises(collector.ImportFailure):
            self.load()
        for value in (record(stage='intent'), record(stage='outcome', status='intent'), record(status='PRIVATE_SENTINEL')):
            self.write([value])
            with self.assertRaises(collector.ImportFailure):
                self.load()

    def test_source_symlink_hardlink_partial_and_oversize_rejected(self):
        self.write([record()])
        real = self.source.with_suffix('.real')
        self.source.rename(real)
        self.source.symlink_to(real)
        with self.assertRaises(OSError):
            self.load()
        self.source.unlink()
        os.link(real, self.source)
        with self.assertRaises(collector.ImportFailure):
            self.load()
        self.source.unlink()
        self.source.write_text(json.dumps(record()))
        with self.assertRaises(collector.ImportFailure):
            self.load()
        self.source.write_text('X' * (collector.LINE_LIMIT + 1) + '\n')
        with self.assertRaises(collector.ImportFailure):
            self.load()

    def test_foreign_database_never_modified_and_source_namespace_separate(self):
        self.write([record()])
        self.db.parent.mkdir(mode=0o700)
        connection = sqlite3.connect(self.db)
        connection.execute('CREATE TABLE unrelated(value TEXT)')
        connection.close()
        self.db.chmod(0o600)
        before = self.db.read_bytes()
        with self.assertRaises(collector.ImportFailure):
            self.load()
        self.assertEqual(before, self.db.read_bytes())

    def test_readonly_no_write_flags_or_mutation(self):
        self.write([record()])
        self.load()
        before = self.db.read_bytes()
        original = os.open
        flags_seen = []
        def capture(path, flags, *args, **kwargs):
            flags_seen.append(flags)
            return original(path, flags, *args, **kwargs)
        with patch.object(os, 'open', capture):
            collector.read_metadata(self.db)
        self.assertTrue(flags_seen)
        self.assertTrue(all(not flags & (os.O_RDWR | os.O_WRONLY | os.O_CREAT) for flags in flags_seen))
        self.assertEqual(before, self.db.read_bytes())
        self.assertEqual(self.db.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.db.parent.stat().st_mode & 0o777, 0o700)

    def test_empty_database_read_never_opens_sqlite_connection(self):
        self.db.parent.mkdir(mode=0o700)
        self.db.touch(mode=0o600)
        with patch.object(sqlite3, 'connect') as connect:
            with self.assertRaises(collector.ImportFailure):
                collector.read_metadata(self.db)
            connect.assert_not_called()
        self.assertEqual(self.db.read_bytes(), b'')

    def test_window_and_dedup_capacity_are_bounded(self):
        self.write([record(), record('b')])
        with patch.object(collector, 'EVENT_LIMIT', 1):
            with self.assertRaises(collector.ImportFailure):
                self.load()
        self.assertFalse(self.db.exists())
        with patch.object(collector, 'DEDUP_LIMIT', 1):
            with self.assertRaises(collector.ImportFailure):
                self.load()
        self.assertEqual(collector.read_metadata(self.db)['events'], [])


if __name__ == '__main__':
    unittest.main()

class BrokerV2Tests(unittest.TestCase):
    setUp=BrokerImportTests.setUp
    tearDown=BrokerImportTests.tearDown
    write=BrokerImportTests.write
    load=BrokerImportTests.load
    def test_v2_correlation_times_and_gaps_are_source_defined(self):
        def v2(identity,stage,status,sequence):
            return {**record(identity,stage,status),'schemaVersion':2,'executionId':'e'*64,'producerId':'f'*32,
                    'sequence':sequence,'occurredAtUTC':'2026-10-17T00:00:00.000Z','observedAtUTC':'2026-10-17T00:00:00.001Z'}
        self.write([v2('a','intent','intent',1),v2('b','outcome','ok',3)])
        self.assertEqual(self.load()['imported'],2)
        self.assertEqual(self.load()['imported'],0)
        report=collector.read_metadata(self.db)
        self.assertEqual(report['events'][0]['requestId'],report['events'][1]['requestId'])
        self.assertTrue(report['coverage']['requestCorrelationAvailable'])
        self.assertTrue(report['coverage']['executionTimestampsAvailable'])
        self.assertEqual(report['coverage']['observedSequenceGaps'],1)
        self.assertFalse(report['coverage']['authenticatedAudit'])

    def test_v1_store_upgrade_preserves_data_and_readonly_legacy_works(self):
        self.write([record()])
        self.db.parent.mkdir(mode=0o700)
        connection=sqlite3.connect(self.db)
        connection.execute(f'PRAGMA application_id={collector.APPLICATION_ID}')
        connection.executescript('CREATE TABLE observer_schema(version INTEGER NOT NULL);INSERT INTO observer_schema VALUES(1);CREATE TABLE seen(event_id TEXT PRIMARY KEY);CREATE TABLE events(id INTEGER PRIMARY KEY,observed_at TEXT NOT NULL,stage TEXT NOT NULL,action_hash TEXT NOT NULL,status TEXT NOT NULL,duration_ms INTEGER NOT NULL);PRAGMA user_version=1;')
        connection.close();self.db.chmod(0o600)
        before=self.db.read_bytes();self.assertEqual(collector.read_metadata(self.db)['events'],[])
        self.assertEqual(before,self.db.read_bytes())
        self.assertEqual(self.load()['imported'],1)
        self.assertEqual(collector.read_metadata(self.db)['events'][0]['status'],'ok')
