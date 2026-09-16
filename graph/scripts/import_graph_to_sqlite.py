#!/usr/bin/env python3
import argparse
import json
import sqlite3
import tempfile
from pathlib import Path


COMMON_NODE_PROPS = (
    'name',
    'fqn',
    'path',
    'normalized_path',
    'source_file',
    'path_source',
    'line',
    'source',
    'context',
    'project',
    'component',
    'status',
    'resolution_status',
    'table',
)


def load_ndjson(path: Path):
    with path.open(encoding='utf-8') as f:
        for line_no, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f'Invalid JSON in {path}:{line_no}: {exc}') from exc


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def value_text(value):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json_text(value)
    return str(value)


def prop_rows(owner_id, props):
    for key, value in (props or {}).items():
        if value is None:
            continue
        if isinstance(value, list):
            for item in value:
                if item is not None:
                    yield owner_id, key, value_text(item)
        else:
            yield owner_id, key, value_text(value)


def node_search_text(node):
    props = node.get('properties') or {}
    values = [
        node.get('id'),
        node.get('kind'),
        node.get('key'),
        *(node.get('labels') or []),
    ]
    for key in COMMON_NODE_PROPS:
        value = props.get(key)
        if isinstance(value, list):
            values.extend(str(v) for v in value if v is not None)
        elif value is not None:
            values.append(str(value))
    return ' '.join(v for v in values if v)


def line_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def create_schema(conn):
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;

        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE nodes (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            name TEXT,
            fqn TEXT,
            path TEXT,
            normalized_path TEXT,
            source_file TEXT,
            path_source TEXT,
            line INTEGER,
            source TEXT,
            context TEXT,
            project TEXT,
            component TEXT,
            status TEXT,
            resolution_status TEXT,
            table_name TEXT,
            labels_json TEXT NOT NULL,
            properties_json TEXT NOT NULL,
            search_text TEXT NOT NULL
        );

        CREATE TABLE node_labels (
            node_id TEXT NOT NULL,
            label TEXT NOT NULL,
            PRIMARY KEY (node_id, label),
            FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE TABLE node_props (
            node_id TEXT NOT NULL,
            prop_key TEXT NOT NULL,
            prop_value TEXT NOT NULL,
            FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE TABLE edges (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            properties_json TEXT NOT NULL,
            FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE TABLE edge_props (
            edge_id TEXT NOT NULL,
            prop_key TEXT NOT NULL,
            prop_value TEXT NOT NULL,
            FOREIGN KEY (edge_id) REFERENCES edges(id) ON DELETE CASCADE
        );
        """
    )


def create_indexes_and_views(conn):
    conn.executescript(
        """
        CREATE INDEX idx_nodes_kind ON nodes(kind);
        CREATE INDEX idx_nodes_key ON nodes(key);
        CREATE INDEX idx_nodes_name ON nodes(name);
        CREATE INDEX idx_nodes_fqn ON nodes(fqn);
        CREATE INDEX idx_nodes_path ON nodes(path);
        CREATE INDEX idx_nodes_normalized_path ON nodes(normalized_path);
        CREATE INDEX idx_nodes_source_file ON nodes(source_file);
        CREATE INDEX idx_nodes_project ON nodes(project);
        CREATE INDEX idx_nodes_component ON nodes(component);
        CREATE INDEX idx_nodes_resolution_status ON nodes(resolution_status);
        CREATE INDEX idx_node_labels_label ON node_labels(label);
        CREATE INDEX idx_node_props_key_value ON node_props(prop_key, prop_value);
        CREATE INDEX idx_edges_type ON edges(type);
        CREATE INDEX idx_edges_from ON edges(from_id);
        CREATE INDEX idx_edges_to ON edges(to_id);
        CREATE INDEX idx_edges_from_type ON edges(from_id, type);
        CREATE INDEX idx_edges_to_type ON edges(to_id, type);
        CREATE INDEX idx_edge_props_key_value ON edge_props(prop_key, prop_value);

        CREATE VIEW v_counts_by_kind AS
        SELECT kind, COUNT(*) AS count
        FROM nodes
        GROUP BY kind;

        CREATE VIEW v_counts_by_edge_type AS
        SELECT type, COUNT(*) AS count
        FROM edges
        GROUP BY type;

        CREATE VIEW v_endpoints AS
        SELECT
            id,
            key,
            name,
            source,
            context,
            project,
            normalized_path,
            path,
            path_source,
            line,
            resolution_status,
            labels_json,
            properties_json
        FROM nodes
        WHERE kind = 'Endpoint';

        CREATE VIEW v_endpoint_gaps AS
        SELECT
            id,
            key,
            name,
            context,
            project,
            normalized_path,
            status,
            properties_json
        FROM nodes
        WHERE kind = 'EndpointGap';

        CREATE VIEW v_ui_controls AS
        SELECT
            id,
            key,
            name,
            project,
            component,
            source_file,
            line,
            labels_json,
            properties_json
        FROM nodes
        WHERE kind = 'UIControl';

        CREATE VIEW v_screen_ajax_endpoint AS
        SELECT
            s.key AS screen,
            s.project AS screen_project,
            s.path AS screen_path,
            ajax.id AS ajax_id,
            ajax.name AS ajax_name,
            ajax.source_file AS ajax_source_file,
            ajax.line AS ajax_line,
            ui_ep.id AS ui_endpoint_id,
            ui_ep.context AS ui_context,
            ui_ep.project AS ui_project,
            ui_ep.normalized_path AS ui_endpoint,
            ui_ep.resolution_status AS ui_resolution_status,
            java_ep.id AS java_endpoint_id,
            java_ep.normalized_path AS java_endpoint,
            gap.id AS gap_id,
            gap.status AS gap_status
        FROM nodes s
        JOIN edges screen_ajax
            ON screen_ajax.from_id = s.id
            AND screen_ajax.type = 'SCREEN_CALLS_AJAX'
        JOIN nodes ajax
            ON ajax.id = screen_ajax.to_id
        LEFT JOIN edges ajax_endpoint
            ON ajax_endpoint.from_id = ajax.id
            AND ajax_endpoint.type = 'AJAX_REFERENCES_ENDPOINT'
        LEFT JOIN nodes ui_ep
            ON ui_ep.id = ajax_endpoint.to_id
        LEFT JOIN edges resolved
            ON resolved.from_id = ui_ep.id
            AND resolved.type = 'RESOLVES_TO_JAVA_ENDPOINT'
        LEFT JOIN nodes java_ep
            ON java_ep.id = resolved.to_id
        LEFT JOIN edges unresolved
            ON unresolved.from_id = ui_ep.id
            AND unresolved.type = 'UNRESOLVED_ENDPOINT_REFERENCE'
        LEFT JOIN nodes gap
            ON gap.id = unresolved.to_id
        WHERE s.kind = 'Screen';

        CREATE VIEW v_repository_persistence AS
        SELECT
            repo.id AS repository_id,
            repo.project AS repository_project,
            repo.name AS repository_name,
            repo.fqn AS repository_fqn,
            e.type AS relation,
            target.id AS target_id,
            target.kind AS target_kind,
            target.name AS target_name,
            target.fqn AS target_fqn,
            target.table_name AS target_table,
            e.properties_json AS relation_properties
        FROM nodes repo
        JOIN edges e
            ON e.from_id = repo.id
            AND e.type IN ('REPOSITORY_IMPL_FOR', 'REPOSITORY_USES_ENTITY', 'REPOSITORY_ACCESSES_TABLE')
        JOIN nodes target
            ON target.id = e.to_id
        WHERE repo.kind = 'JavaType';

        CREATE VIEW v_method_calls_type AS
        SELECT
            method.id AS method_id,
            method.project AS method_project,
            method.name AS method_name,
            method.fqn AS method_owner_fqn,
            method.path AS method_path,
            method.line AS method_line,
            target.id AS target_type_id,
            target.name AS target_type_name,
            target.fqn AS target_type_fqn,
            target.path AS target_type_path,
            e.properties_json AS call_properties
        FROM nodes method
        JOIN edges e
            ON e.from_id = method.id
            AND e.type = 'METHOD_CALLS_TYPE'
        JOIN nodes target
            ON target.id = e.to_id
        WHERE method.kind = 'Method'
            AND target.kind = 'JavaType';
        """
    )


def insert_metadata(conn, graph_dir: Path, summary):
    entries = {
        'format': 'hr-business-graph-sqlite-v1',
        'graph_dir': str(graph_dir),
        'source_root': summary.get('source_root', ''),
        'graph_generated_at': summary.get('generated_at', ''),
        'node_count_expected': str(summary.get('node_count', '')),
        'edge_count_expected': str(summary.get('edge_count', '')),
    }
    conn.executemany(
        'INSERT INTO metadata(key, value) VALUES (?, ?)',
        sorted(entries.items()),
    )


def import_nodes(conn, nodes_path: Path):
    node_rows = []
    label_rows = []
    prop_rows_batch = []
    fts_rows = []
    count = 0
    for node in load_ndjson(nodes_path):
        props = node.get('properties') or {}
        labels = node.get('labels') or []
        search_text = node_search_text(node)
        row = (
            node['id'],
            node['kind'],
            node['key'],
            props.get('name'),
            props.get('fqn'),
            props.get('path'),
            props.get('normalized_path'),
            props.get('source_file'),
            props.get('path_source'),
            line_int(props.get('line')),
            props.get('source'),
            props.get('context'),
            props.get('project'),
            props.get('component'),
            props.get('status'),
            props.get('resolution_status'),
            props.get('table'),
            json_text(labels),
            json_text(props),
            search_text,
        )
        node_rows.append(row)
        label_rows.extend((node['id'], label) for label in labels)
        prop_rows_batch.extend(prop_rows(node['id'], props))
        fts_rows.append((node['id'], search_text))
        count += 1

    conn.executemany(
        """
        INSERT INTO nodes(
            id, kind, key, name, fqn, path, normalized_path, source_file,
            path_source, line, source, context, project, component, status,
            resolution_status, table_name, labels_json, properties_json,
            search_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        node_rows,
    )
    conn.executemany(
        'INSERT OR IGNORE INTO node_labels(node_id, label) VALUES (?, ?)',
        label_rows,
    )
    conn.executemany(
        'INSERT INTO node_props(node_id, prop_key, prop_value) VALUES (?, ?, ?)',
        prop_rows_batch,
    )
    return count, fts_rows


def import_edges(conn, edges_path: Path):
    edge_rows = []
    prop_rows_batch = []
    count = 0
    for edge in load_ndjson(edges_path):
        props = edge.get('properties') or {}
        edge_rows.append((
            edge['id'],
            edge['type'],
            edge['from'],
            edge['to'],
            json_text(props),
        ))
        prop_rows_batch.extend(prop_rows(edge['id'], props))
        count += 1

    conn.executemany(
        'INSERT INTO edges(id, type, from_id, to_id, properties_json) VALUES (?, ?, ?, ?, ?)',
        edge_rows,
    )
    conn.executemany(
        'INSERT INTO edge_props(edge_id, prop_key, prop_value) VALUES (?, ?, ?)',
        prop_rows_batch,
    )
    return count


def create_fts(conn, fts_rows):
    try:
        conn.execute("CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, search_text, tokenize='unicode61')")
        conn.executemany('INSERT INTO nodes_fts(id, search_text) VALUES (?, ?)', fts_rows)
        conn.execute("INSERT INTO metadata(key, value) VALUES ('fts5', 'enabled')")
        return True
    except sqlite3.OperationalError:
        conn.execute("INSERT INTO metadata(key, value) VALUES ('fts5', 'unavailable')")
        return False


def validate_counts(conn, expected_nodes, expected_edges):
    actual_nodes = conn.execute('SELECT COUNT(*) FROM nodes').fetchone()[0]
    actual_edges = conn.execute('SELECT COUNT(*) FROM edges').fetchone()[0]
    dangling_edges = conn.execute(
        """
        SELECT COUNT(*)
        FROM edges e
        LEFT JOIN nodes s ON s.id = e.from_id
        LEFT JOIN nodes t ON t.id = e.to_id
        WHERE s.id IS NULL OR t.id IS NULL
        """
    ).fetchone()[0]
    if actual_nodes != expected_nodes:
        raise RuntimeError(f'Node count mismatch: expected {expected_nodes}, got {actual_nodes}')
    if actual_edges != expected_edges:
        raise RuntimeError(f'Edge count mismatch: expected {expected_edges}, got {actual_edges}')
    if dangling_edges:
        raise RuntimeError(f'Dangling edges found: {dangling_edges}')
    return actual_nodes, actual_edges, dangling_edges


def build_sqlite(graph_dir: Path, db_path: Path):
    nodes_path = graph_dir / 'nodes.ndjson'
    edges_path = graph_dir / 'edges.ndjson'
    summary_path = graph_dir / 'summary.json'
    for path in (nodes_path, edges_path, summary_path):
        if not path.exists():
            raise FileNotFoundError(path)

    summary = json.loads(summary_path.read_text(encoding='utf-8'))
    expected_nodes = int(summary['node_count'])
    expected_edges = int(summary['edge_count'])

    db_path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = db_path.parent
    with tempfile.NamedTemporaryFile(prefix=db_path.stem + '.', suffix='.tmp', dir=temp_dir, delete=False) as temp_file:
        temp_path = Path(temp_file.name)

    try:
        conn = sqlite3.connect(temp_path)
        conn.execute('PRAGMA journal_mode = OFF')
        conn.execute('PRAGMA synchronous = OFF')
        conn.execute('PRAGMA temp_store = MEMORY')
        create_schema(conn)
        insert_metadata(conn, graph_dir, summary)
        node_count, fts_rows = import_nodes(conn, nodes_path)
        edge_count = import_edges(conn, edges_path)
        create_indexes_and_views(conn)
        fts_enabled = create_fts(conn, fts_rows)
        validate_counts(conn, expected_nodes, expected_edges)
        conn.execute('ANALYZE')
        conn.execute('PRAGMA optimize')
        conn.commit()
        conn.close()
        temp_path.replace(db_path)
        return {
            'db_path': str(db_path),
            'nodes': node_count,
            'edges': edge_count,
            'fts5': fts_enabled,
            'size_bytes': db_path.stat().st_size,
        }
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        finally:
            raise


def main():
    parser = argparse.ArgumentParser(description='Import HR business graph NDJSON files into SQLite.')
    parser.add_argument(
        '--graph-dir',
        default=r'D:\ukvn\src\ai.dlc\hr.ast-graph\business-graph',
        help='Directory containing nodes.ndjson, edges.ndjson, and summary.json.',
    )
    parser.add_argument(
        '--db',
        default=None,
        help='Output SQLite path. Defaults to <graph-dir>/graph.sqlite.',
    )
    args = parser.parse_args()

    graph_dir = Path(args.graph_dir).resolve()
    db_path = Path(args.db).resolve() if args.db else graph_dir / 'graph.sqlite'
    result = build_sqlite(graph_dir, db_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
