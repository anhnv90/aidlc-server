#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from collections import Counter, defaultdict


def load_ndjson(path):
    with path.open(encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def main():
    parser = argparse.ArgumentParser(description='Validate generated HR business graph artifacts.')
    parser.add_argument(
        '--graph-root',
        default=r'D:\ukvn\src\ai.dlc\hr.ast-graph\business-graph',
        help='Directory containing nodes.ndjson and edges.ndjson.',
    )
    args = parser.parse_args()
    root = Path(args.graph_root).resolve()
    nodes = load_ndjson(root / 'nodes.ndjson')
    edges = load_ndjson(root / 'edges.ndjson')
    by_id = {n['id']: n for n in nodes}
    label_counts = Counter(label for n in nodes for label in n.get('labels', []))
    kind_counts = Counter(n['kind'] for n in nodes)
    edge_counts = Counter(e['type'] for e in edges)

    resolved_ui_endpoints = {e['from'] for e in edges if e['type'] == 'RESOLVES_TO_JAVA_ENDPOINT'}
    ajax_to_endpoint = {e['from']: e['to'] for e in edges if e['type'] == 'AJAX_REFERENCES_ENDPOINT'}
    endpoint_gaps = [n for n in nodes if n['kind'] == 'EndpointGap']
    controls = [n for n in nodes if n['kind'] == 'UIControl']
    control_components = Counter(n['properties'].get('component') or 'unknown' for n in controls)
    repo_entity_edges = [e for e in edges if e['type'] == 'REPOSITORY_USES_ENTITY']
    repo_table_edges = [e for e in edges if e['type'] == 'REPOSITORY_ACCESSES_TABLE']
    repo_impl_edges = [e for e in edges if e['type'] == 'REPOSITORY_IMPL_FOR']
    unresolved_ajax = []
    no_url_ajax = []
    for n in nodes:
        if n['kind'] != 'AjaxCall':
            continue
        props = n['properties']
        url = props.get('normalized_path') or ''
        if not url:
            no_url_ajax.append(n)
            continue
        ep_id = ajax_to_endpoint.get(n['id'])
        if ep_id not in resolved_ui_endpoints:
            unresolved_ajax.append(n)

    report = []
    report.append('# Business Graph Validation')
    report.append('')
    report.append('## Totals')
    report.append(f'- Nodes: {len(nodes)}')
    report.append(f'- Edges: {len(edges)}')
    report.append('')
    report.append('## Key Node Kinds')
    for k, v in kind_counts.most_common(25):
        report.append(f'- {k}: {v}')
    report.append('')
    report.append('## Key DDD Labels')
    for label in ['Aggregate', 'DomainAggregate', 'AggregateRoot', 'ValueObject', 'DomainService', 'Repository', 'RepositoryInterface', 'RepositoryImplementation', 'CommandHandler', 'Finder', 'Command', 'DTO', 'WebService', 'JpaEntity']:
        report.append(f'- {label}: {label_counts.get(label, 0)}')
    report.append('')
    report.append('## UI Semantic Coverage')
    report.append(f'- UI controls: {len(controls)}')
    report.append(f'- NTS component controls: {label_counts.get("NtsComponent", 0)}')
    for k, v in control_components.most_common(20):
        report.append(f'- {k}: {v}')
    report.append('')
    report.append('## Persistence Linkage')
    report.append(f'- Repository implementation -> interface links: {len(repo_impl_edges)}')
    report.append(f'- Repository -> JPA entity links: {len(repo_entity_edges)}')
    report.append(f'- Repository -> table links: {len(repo_table_edges)}')
    report.append('')
    report.append('## Key Edge Types')
    for k, v in edge_counts.most_common(30):
        report.append(f'- {k}: {v}')
    report.append('')
    report.append('## UI Endpoint Resolution')
    total_ajax = kind_counts.get('AjaxCall', 0)
    report.append(f'- Ajax calls: {total_ajax}')
    report.append(f'- Ajax calls without resolved literal URL: {len(no_url_ajax)}')
    report.append(f'- Ajax calls with URL but no Java endpoint match in this source tree: {len(unresolved_ajax)}')
    gap_counts = Counter(n['properties'].get('status') or 'unknown' for n in endpoint_gaps)
    report.append(f'- Endpoint gap nodes: {len(endpoint_gaps)}')
    for k, v in sorted(gap_counts.items()):
        report.append(f'- {k}: {v}')
    ctx_counts = Counter((n['properties'].get('context') or 'default') for n in unresolved_ajax)
    for k, v in sorted(ctx_counts.items()):
        report.append(f'  - {k}: {v}')
    report.append('')
    report.append('## Sample Unresolved Ajax Calls')
    for n in unresolved_ajax[:40]:
        p = n['properties']
        report.append(f"- {p.get('context') or 'default'} {p.get('normalized_path')} ({p.get('api_ref') or 'literal'}, {p.get('source_file')}:{p.get('line')})")
    report.append('')
    report.append('## Interpretation')
    report.append('- Cross-context calls such as com/onboarding are expected to be unresolved when only uk.hr is scanned.')
    report.append('- hr calls that remain unresolved usually mean the UI artifact exists but the matching Java WS source is absent from this checkout/source layer.')
    report.append('- XHTML/Knockout bindings are captured as UI binding nodes and classified into UIControl nodes when a data-bind element is present.')

    (root / 'validation-report.md').write_text('\n'.join(report) + '\n', encoding='utf-8')
    print(json.dumps({
        'nodes': len(nodes),
        'edges': len(edges),
        'ajax': total_ajax,
        'ajax_without_url': len(no_url_ajax),
        'unresolved_ajax_with_url': len(unresolved_ajax),
        'ui_controls': len(controls),
        'endpoint_gaps': len(endpoint_gaps),
        'repository_entity_links': len(repo_entity_edges),
        'repository_table_links': len(repo_table_edges),
        'repository_impl_links': len(repo_impl_edges),
        'report': str(root / 'validation-report.md'),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
