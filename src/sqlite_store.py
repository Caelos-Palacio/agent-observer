"""Provider-neutral private SQLite identity/schema validation and bounded storage."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import struct
from urllib.parse import quote

DB_LIMIT=64*1024*1024

class ImportFailure(Exception):
    pass


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        print(json.dumps({'ok': False, 'code': 'arguments_invalid'}))
        raise SystemExit(2)


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def parent_directory(path, create=False, private=False):
    target = Path(os.path.abspath(os.fspath(path)))
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = target.parent.parts[1:]
        for index, part in enumerate(parts):
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            except FileNotFoundError:
                if not create or index != len(parts) - 1:
                    raise
                os.mkdir(part, 0o700, dir_fd=descriptor)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        info = os.fstat(descriptor)
        if private and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
            raise ImportFailure('database_directory_unsafe')
        return descriptor, target.name
    except BaseException:
        os.close(descriptor)
        raise


def database(path, initialize=True, *, table_columns, application_id, schema_sql, schema_version=1, legacy_schemas=None, migration_sql=None):
    directory, name = parent_directory(path, create=initialize, private=True)
    connection = None
    try:
        total_size = 0
        for suffix in ('', '-journal', '-wal', '-shm'):
            try:
                descriptor = os.open(name + suffix, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                     dir_fd=directory)
            except FileNotFoundError:
                continue
            try:
                info = os.fstat(descriptor)
                total_size += info.st_size
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > DB_LIMIT):
                    raise ImportFailure('database_file_unsafe')
            finally:
                os.close(descriptor)
        if total_size > DB_LIMIT:
            raise ImportFailure('database_limit_exceeded')
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            if not initialize:
                raise
            descriptor = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=directory)
        try:
            empty = os.fstat(descriptor).st_size == 0
            if not empty:
                header = os.pread(descriptor, 100, 0)
                if (len(header) != 100 or header[:16] != b'SQLite format 3\x00'
                        or struct.unpack('>I', header[68:72])[0] != application_id):
                    raise ImportFailure('database_not_observer')
        finally:
            os.close(descriptor)
        if empty and not initialize:
            raise ImportFailure('database_not_observer')
        # The private host-owned directory is the security boundary, not same-UID code.
        sqlite_path = f'/proc/self/fd/{directory}/{name}'
        connection = (sqlite3.connect(sqlite_path, timeout=3) if empty else
                      sqlite3.connect('file:' + quote(sqlite_path, safe='/') + '?mode=ro', uri=True, timeout=3))
        application = connection.execute('PRAGMA application_id').fetchone()[0]
        if application != application_id:
            if not empty or not initialize:
                raise ImportFailure('database_not_observer')
        if not empty:
            version = connection.execute('PRAGMA user_version').fetchone()[0]
            version=version or 1
            expected_columns=table_columns if version==schema_version else (legacy_schemas or {}).get(version)
            if expected_columns is None:
                raise ImportFailure('database_version_unsupported')
            objects = connection.execute("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
            if set(objects) != {(name, 'table') for name in expected_columns}:
                raise ImportFailure('database_schema_invalid')
            for table, columns in expected_columns.items():
                observed = [tuple(row[1:]) for row in connection.execute('PRAGMA table_info(' + table + ')')]
                if observed != columns:
                    raise ImportFailure('database_schema_invalid')
            if connection.execute('SELECT version FROM observer_schema').fetchall() != [(version,)]:
                raise ImportFailure('database_version_unsupported')
            if not initialize:
                return connection, directory
            # Validate the existing database read-only before obtaining a writer.
            connection.close()
            connection = sqlite3.connect(sqlite_path, timeout=3)
        else:
            connection.execute(f'PRAGMA application_id={application_id}')
        connection.execute('PRAGMA trusted_schema=OFF')
        if connection.execute('PRAGMA page_size').fetchone()[0] != 4096:
            raise ImportFailure('database_page_size_unsupported')
        connection.execute('PRAGMA journal_mode=DELETE')
        connection.execute('PRAGMA synchronous=FULL')
        connection.execute('PRAGMA max_page_count=8192')
        if empty:
            connection.executescript(schema_sql or schema_sql)
        if not empty and version!=schema_version:
            if not migration_sql:
                raise ImportFailure('database_version_unsupported')
            connection.executescript('BEGIN IMMEDIATE;'+migration_sql+f';UPDATE observer_schema SET version={schema_version};PRAGMA user_version={schema_version};COMMIT;')
        connection.execute(f'PRAGMA user_version={schema_version}')
        if connection.execute('SELECT version FROM observer_schema').fetchall() != [(schema_version,)]:
            raise ImportFailure('database_version_unsupported')
        return connection, directory
    except BaseException:
        if connection is not None:
            connection.close()
        os.close(directory)
        raise

