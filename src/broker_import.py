"""Import a bounded, explicit host-generated broker metadata export, never a vault."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys

_spec = importlib.util.spec_from_file_location('_observer_sqlite', Path(__file__).with_name('sqlite_store.py'))
_storage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_storage)
ImportFailure = _storage.ImportFailure
APPLICATION_ID = 1095713378
BYTE_LIMIT = 2 * 1024 * 1024
LINE_LIMIT = 4096
EVENT_LIMIT = 10000
DEDUP_LIMIT = 100000
KEYS = {'schemaVersion', 'source', 'eventId', 'event', 'actionIdHash', 'status', 'durationMs'}
KEYS_V2=KEYS|{'executionId','sequence','producerId','occurredAtUTC','observedAtUTC'}
COLUMNS_V1 = {
    'observer_schema': [('version', 'INTEGER', 1, None, 0)],
    'seen': [('event_id', 'TEXT', 0, None, 1)],
    'events': [('id', 'INTEGER', 0, None, 1), ('observed_at', 'TEXT', 1, None, 0),
               ('stage', 'TEXT', 1, None, 0), ('action_hash', 'TEXT', 1, None, 0),
               ('status', 'TEXT', 1, None, 0), ('duration_ms', 'INTEGER', 1, None, 0)],
}
COLUMNS={**COLUMNS_V1,'events':COLUMNS_V1['events']+[('metadata_v2','TEXT',0,None,0)]}
SCHEMA = '''CREATE TABLE observer_schema(version INTEGER NOT NULL);
INSERT INTO observer_schema VALUES (2);
CREATE TABLE seen(event_id TEXT PRIMARY KEY);
CREATE TABLE events(id INTEGER PRIMARY KEY, observed_at TEXT NOT NULL, stage TEXT NOT NULL,
 action_hash TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL,metadata_v2 TEXT);'''


def database(path, initialize=True):
    return _storage.database(path, initialize, table_columns=COLUMNS,
                             application_id=APPLICATION_ID,schema_sql=SCHEMA,schema_version=2,
                             legacy_schemas={1:COLUMNS_V1},migration_sql='ALTER TABLE events ADD COLUMN metadata_v2 TEXT')


def strict_json(line):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ImportFailure('broker_metadata_invalid')
            result[key] = value
        return result
    return json.loads(line, object_pairs_hook=pairs)


def project(value):
    if (not isinstance(value, dict) or set(value) != (KEYS_V2 if value.get('schemaVersion')==2 else KEYS)
            or type(value['schemaVersion']) is not int or value['schemaVersion'] not in (1,2)
            or value['source'] != 'agent-credential-broker'
            or not isinstance(value['eventId'], str) or not re.fullmatch('[a-f0-9]{64}', value['eventId'])
            or not isinstance(value['actionIdHash'], str) or not re.fullmatch('[a-f0-9]{16}', value['actionIdHash'])
            or value['event'] not in ('execute', 'intent', 'outcome')
            or value['status'] not in ('intent', 'ok', 'denied', 'uncertain')
            or type(value['durationMs']) is not int or not 0 <= value['durationMs'] <= 60000
            or (value['event'] == 'intent') != (value['status'] == 'intent')):
        raise ImportFailure('broker_metadata_invalid')
    if value['schemaVersion']==2:
        if (not isinstance(value['executionId'],str) or not re.fullmatch('[a-f0-9]{64}',value['executionId'])
                or not isinstance(value['producerId'],str) or not re.fullmatch('[a-f0-9]{32}',value['producerId'])
                or type(value['sequence']) is not int or not 1<=value['sequence']<=2**53-1):
            raise ImportFailure('broker_metadata_invalid')
        for key in ('occurredAtUTC','observedAtUTC'):
            if not isinstance(value[key],str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',value[key]):
                raise ImportFailure('broker_metadata_invalid')
            parsed=datetime.fromisoformat(value[key].replace('Z','+00:00'))
            if parsed.tzinfo is None or parsed.utcoffset().total_seconds()!=0:
                raise ImportFailure('broker_metadata_invalid')
    return value


def import_file(file, db_path):
    directory, name = _storage.parent_directory(file)
    descriptor = None
    connection = None
    db_directory = None
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_size > BYTE_LIMIT):
            raise ImportFailure('broker_source_unsafe')
        records, total = [], 0
        with os.fdopen(os.dup(descriptor), 'rb') as stream:
            while True:
                line = stream.readline(LINE_LIMIT + 1)
                if not line:
                    break
                total += len(line)
                if total > BYTE_LIMIT or len(line) > LINE_LIMIT or not line.endswith(b'\n') or len(records) >= EVENT_LIMIT:
                    raise ImportFailure('broker_source_limit')
                records.append(project(strict_json(line)))
        # Validate the entire bounded metadata input before opening any writer.
        connection, db_directory = database(db_path)
        observed_at = datetime.now(timezone.utc).isoformat()
        summary = {'ok': True, 'source': 'broker', 'readRecords': len(records), 'readBytes': total,
                   'imported': 0, 'duplicates': 0, 'limited': False}
        connection.execute('BEGIN IMMEDIATE')
        for value in records:
            identity = hashlib.sha256(('agent-credential-broker:' + value['eventId']).encode()).hexdigest()
            result = connection.execute('INSERT OR IGNORE INTO seen VALUES (?)', (identity,))
            if not result.rowcount:
                summary['duplicates'] += 1
                continue
            extras={key:value[key] for key in KEYS_V2-KEYS} if value['schemaVersion']==2 else None
            connection.execute('INSERT INTO events(observed_at,stage,action_hash,status,duration_ms,metadata_v2) VALUES (?,?,?,?,?,?)',
                               (observed_at,value['event'],value['actionIdHash'],value['status'],value['durationMs'],json.dumps(extras,separators=(',',':')) if extras else None))
            summary['imported'] += 1
        if connection.execute('SELECT COUNT(*) FROM seen').fetchone()[0] > DEDUP_LIMIT:
            raise ImportFailure('broker_deduplication_limit')
        connection.execute('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)', (EVENT_LIMIT,))
        connection.commit()
        return summary
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
        os.close(directory)


def read_metadata(db_path):
    connection, directory = database(db_path, initialize=False)
    try:
        version=connection.execute('PRAGMA user_version').fetchone()[0]
        rows = connection.execute('SELECT observed_at,stage,action_hash,status,duration_ms,'+('metadata_v2' if version==2 else 'NULL')+' FROM events ORDER BY id LIMIT 10001').fetchall()
        correlated=0
        sequences={}
        if len(rows) > EVENT_LIMIT:
            raise ImportFailure('broker_event_limit')
        events = []
        for timestamp,stage,action_hash,status,duration,metadata_v2 in rows:
            # Validate stored values as strictly as imports; this is no authenticity proof.
            project({'schemaVersion': 1, 'source': 'agent-credential-broker', 'eventId': '0' * 64,
                     'event': stage, 'actionIdHash': action_hash, 'status': status, 'durationMs': duration})
            if not isinstance(timestamp, str) or len(timestamp) > 40:
                raise ImportFailure('broker_database_invalid')
            parsed = datetime.fromisoformat(timestamp)
            if parsed.tzinfo is None:
                raise ImportFailure('broker_database_invalid')
            extras={}
            if metadata_v2 is not None:
                if not isinstance(metadata_v2,str) or len(metadata_v2)>1024:
                    raise ImportFailure('broker_database_invalid')
                extras=strict_json(metadata_v2)
                if not isinstance(extras,dict) or set(extras)!=KEYS_V2-KEYS:
                    raise ImportFailure('broker_database_invalid')
                project({'schemaVersion':2,'source':'agent-credential-broker','eventId':'0'*64,'event':stage,'actionIdHash':action_hash,'status':status,'durationMs':duration,**extras})
                correlated+=1
                sequences.setdefault(extras['producerId'],[]).append(extras['sequence'])
            events.append({'event': 'checkpoint' if stage == 'intent' else 'tool_end',
                           'timestamp': parsed.astimezone(timezone.utc).isoformat(), 'session': _storage.hashed('broker-audit-unknown-session'),
                           'agent': _storage.hashed('broker-audit-unknown-principal'), 'tool': 'broker.' + action_hash,
                           'status':status,'durationMs':duration,'brokerStage':stage,
                           **({'requestId':extras['executionId'],'producerId':extras['producerId'],'sequence':extras['sequence'],
                              'occurredAt':extras['occurredAtUTC'],'observedAt':extras['observedAtUTC']} if extras else {})})
        if len(json.dumps(events,separators=(',',':')).encode())>7*1024*1024:
            raise ImportFailure('broker_projection_limit')
        return {'events': events, 'coverage': {
            'source': 'broker', 'returnedEvents': len(events), 'eventLimit': EVENT_LIMIT,
            'window': 'latest-retained', 'capture': 'host-exported-action-audit-metadata',
            'executionTimestampsAvailable':bool(events) and correlated==len(events),'eventsWithExecutionMetadata':correlated,
            'timestampMeaning':'first-import-observed-at; occurredAt and observedAt only when producer supplies v2',
            'sessionIdentityAvailable': False, 'agentIdentityAvailable': False,
            'requestCorrelationAvailable':bool(events) and correlated==len(events),
            'observedSequenceGaps':sum(max(0,b-a-1) for values in sequences.values() for a,b in zip(sorted(set(values)),sorted(set(values))[1:])),
            'sequenceCoverageMeaning':'gaps only within retained observed sequence ranges; earlier/later history unavailable',
            'tokensAvailable':False, 'costAvailable': False,
            'authenticatedAudit': False,
        }}
    finally:
        connection.close()
        os.close(directory)


def main():
    parser = _storage.SafeParser(description='Explicit broker metadata import')
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('import', 'read'):
        part = sub.add_parser(command)
        part.add_argument('--database', required=True)
        if command == 'import':
            part.add_argument('--file', required=True)
    args = parser.parse_args()
    try:
        result = import_file(args.file, args.database) if args.command == 'import' else read_metadata(args.database)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except (ImportFailure, OSError, sqlite3.Error, ValueError, TypeError, RecursionError):
        print('{"ok":false,"code":"broker_metadata_failed"}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
