"""Explicit, offline Codex usage projection. No transcript content is retained."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import sys
from urllib.parse import quote

LINE_LIMIT = 1024 * 1024
BYTE_LIMIT = 32 * 1024 * 1024
RECORD_LIMIT = 100000
EVENT_LIMIT = 10000
DB_LIMIT = 64 * 1024 * 1024
APPLICATION_ID = 1095713363
TABLE_COLUMNS = {
    'observer_schema': [('version', 'INTEGER', 1, None, 0)],
    'cursors': [('source', 'TEXT', 0, None, 1), ('offset', 'INTEGER', 1, None, 0),
                ('anchor', 'TEXT', 1, None, 0)],
    'seen': [('session', 'TEXT', 1, None, 1), ('response', 'TEXT', 1, None, 2)],
    'checkpoints': [('id', 'INTEGER', 0, None, 1), ('timestamp', 'TEXT', 1, None, 0),
                    ('session', 'TEXT', 1, None, 0), ('agent', 'TEXT', 1, None, 0),
                    ('input_tokens', 'INTEGER', 0, None, 0), ('output_tokens', 'INTEGER', 0, None, 0)],
}


# Local trusted helper load also works with Python -I; no user paths/import plugins.
import importlib.util
_spec=importlib.util.spec_from_file_location('_observer_storage',Path(__file__).with_name('sqlite_store.py'))
_storage=importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_storage)
ImportFailure=_storage.ImportFailure
SafeParser=_storage.SafeParser
hashed=_storage.hashed
parent_directory=_storage.parent_directory
SCHEMA_SQL='''
          CREATE TABLE IF NOT EXISTS observer_schema(version INTEGER NOT NULL);
          INSERT INTO observer_schema SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM observer_schema);
          CREATE TABLE IF NOT EXISTS cursors(source TEXT PRIMARY KEY, offset INTEGER NOT NULL, anchor TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS seen(session TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(session,response));
          CREATE TABLE IF NOT EXISTS checkpoints(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL,
             session TEXT NOT NULL, agent TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER);
            '''

def database(path,initialize=True):
    return _storage.database(path,initialize,table_columns=TABLE_COLUMNS,application_id=APPLICATION_ID,schema_sql=SCHEMA_SQL)


def project(record, thread):
    if not isinstance(record, dict) or record.get('type') != 'token_usage_record':
        return None
    body = record.get('payload', record)
    if not isinstance(body, dict) or body.get('thread_id') != thread:
        return None
    response = body.get('response_id')
    usage = body.get('usage')
    if not isinstance(response, str) or not 1 <= len(response) <= 512 or not isinstance(usage, dict):
        raise ImportFailure('record_invalid')
    counters = {}
    for source, alternate, target in (('input_tokens', 'input', 'inputTokens'),
                                      ('output_tokens', 'output', 'outputTokens')):
        value = usage.get(source, usage.get(alternate))
        if value is not None:
            if type(value) is not int or not 0 <= value <= 10**12:
                raise ImportFailure('record_invalid')
            counters[target] = value
    if not counters:
        raise ImportFailure('record_invalid')
    timestamp = record.get('timestamp')
    if not isinstance(timestamp, str) or len(timestamp) > 40:
        raise ImportFailure('record_invalid')
    try:
        parsed = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise ImportFailure('record_invalid') from None
    return hashed(response), {'event': 'checkpoint', 'timestamp': parsed.astimezone(timezone.utc).isoformat(),
                              'session': hashed(thread), 'agent': hashed('codex-main'), **counters}


def import_file(file, thread_id, db_path):
    if not isinstance(thread_id, str) or not 1 <= len(thread_id) <= 512:
        raise ImportFailure('thread_invalid')
    source_directory, name = parent_directory(file)
    descriptor = None
    connection = None
    db_directory = None
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_directory)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ImportFailure('source_unsafe')
        connection, db_directory = database(db_path)
        source = hashed(f'{info.st_dev}:{info.st_ino}:{thread_id}')
        session = hashed(thread_id)
        def anchor_at(position):
            prefix = os.pread(descriptor, min(position, 256), 0)
            tail = os.pread(descriptor, min(position, 256), max(0, position - 256))
            return hashlib.sha256(prefix + tail).hexdigest()
        summary = {'imported': 0, 'duplicates': 0, 'ignored': 0, 'malformed': 0,
                   'readRecords': 0, 'readBytes': 0, 'partialLine': False, 'limited': False}
        connection.execute('BEGIN IMMEDIATE')
        cursor = connection.execute('SELECT offset,anchor FROM cursors WHERE source=?', (source,)).fetchone()
        offset = cursor[0] if cursor and cursor[0] <= info.st_size and cursor[1] == anchor_at(cursor[0]) else 0
        os.lseek(descriptor, offset, os.SEEK_SET)
        with os.fdopen(os.dup(descriptor), 'rb') as stream:
            while summary['readRecords'] < RECORD_LIMIT and summary['readBytes'] < BYTE_LIMIT:
                remaining = BYTE_LIMIT - summary['readBytes']
                line = stream.readline(min(LINE_LIMIT + 1, remaining + 1))
                if not line:
                    break
                if len(line) > LINE_LIMIT:
                    raise ImportFailure('line_limit_exceeded')
                if len(line) > remaining:
                    summary['limited'] = True
                    break
                summary['readBytes'] += len(line)
                if not line.endswith(b'\n'):
                    summary['partialLine'] = True
                    break
                offset += len(line)
                summary['readRecords'] += 1
                try:
                    projected = project(json.loads(line), thread_id)
                except (ValueError, TypeError, RecursionError, ImportFailure):
                    summary['malformed'] += 1
                    continue
                if projected is None:
                    summary['ignored'] += 1
                    continue
                response, event = projected
                result = connection.execute('INSERT OR IGNORE INTO seen VALUES (?,?)', (session, response))
                if not result.rowcount:
                    summary['duplicates'] += 1
                    continue
                connection.execute('INSERT INTO checkpoints(timestamp,session,agent,input_tokens,output_tokens) VALUES (?,?,?,?,?)',
                                   (event['timestamp'], event['session'], event['agent'], event.get('inputTokens'), event.get('outputTokens')))
                summary['imported'] += 1
        summary['limited'] |= offset < info.st_size and not summary['partialLine']
        if connection.execute('SELECT COUNT(*) FROM seen').fetchone()[0] > RECORD_LIMIT:
            raise ImportFailure('deduplication_limit_exceeded')
        connection.execute('DELETE FROM checkpoints WHERE id NOT IN (SELECT id FROM checkpoints ORDER BY id DESC LIMIT ?)', (EVENT_LIMIT,))
        connection.execute('INSERT OR REPLACE INTO cursors VALUES (?,?,?)', (source, offset, anchor_at(offset)))
        connection.execute('DELETE FROM cursors WHERE rowid NOT IN (SELECT rowid FROM cursors ORDER BY rowid DESC LIMIT 64)')
        connection.commit()
        return {'ok': True, 'source': 'codex-experimental', **summary}
    except BaseException:
        if connection is not None:
            connection.rollback()
        raise
    finally:
        if connection is not None:
            connection.close()
        if db_directory is not None:
            os.close(db_directory)
        if descriptor is not None:
            os.close(descriptor)
        os.close(source_directory)


def read_metadata(db_path):
    connection, directory = database(db_path, initialize=False)
    try:
        rows = connection.execute('SELECT timestamp,session,agent,input_tokens,output_tokens FROM checkpoints ORDER BY id LIMIT 10001').fetchall()
        if len(rows) > EVENT_LIMIT:
            raise ImportFailure('database_event_limit')
        events = []
        for timestamp, session, agent, inputs, outputs in rows:
            if (not isinstance(timestamp, str) or len(timestamp) > 40
                    or any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{16}', value)
                           for value in (session, agent))
                    or any(value is not None and (type(value) is not int or not 0 <= value <= 10**12)
                           for value in (inputs, outputs))):
                raise ImportFailure('database_metadata_invalid')
            parsed = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ImportFailure('database_metadata_invalid')
            timestamp = parsed.astimezone(timezone.utc).isoformat()
            event = {'event': 'checkpoint', 'timestamp': timestamp, 'session': session, 'agent': agent}
            if inputs is not None:
                event['inputTokens'] = inputs
            if outputs is not None:
                event['outputTokens'] = outputs
            events.append(event)
        return {'events': events, 'coverage': {'source': 'codex-experimental', 'returnedEvents': len(events),
                'eventLimit': EVENT_LIMIT, 'window': 'latest-retained', 'capture': 'incremental-token-usage-only',
                'toolsCaptured': False, 'agentsCaptured': False, 'costAvailable': False}}
    finally:
        connection.close()
        os.close(directory)


def main(argv=None):
    parser = SafeParser(description='Offline metadata-only Codex import')
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('import', 'read'):
        part = sub.add_parser(command)
        part.add_argument('--database', required=True)
        if command == 'import':
            part.add_argument('--file', required=True)
            part.add_argument('--thread-id', required=True)
    args = parser.parse_args(argv)
    try:
        value = import_file(args.file, args.thread_id, args.database) if args.command == 'import' else read_metadata(args.database)
        print(json.dumps(value, separators=(',', ':')))
    except (ImportFailure, OSError, sqlite3.Error, ValueError):
        print(json.dumps({'ok': False, 'code': 'codex_import_failed'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
