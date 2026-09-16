#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import re
from pathlib import Path
from collections import Counter, defaultdict

EXCLUDE_DIRS = {'.git', '.gradle', '.idea', 'node_modules', '.codex'}
JAVA_BUILD_PARTS = {'build', 'target'}
UI_SOURCE_MARKERS = ('/src/main/webapp/view/', '/build/libs/exploded/')


def read_text(path: Path) -> str:
    for enc in ('utf-8', 'utf-8-sig', 'cp932'):
        try:
            return path.read_text(encoding=enc, errors='strict')
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding='utf-8', errors='replace')


def skip_unreadable(g, path: Path, root: Path, stage: str, exc: Exception):
    raw_rel = rel_path(path, root)
    rel = graph_rel_path(raw_rel, g)
    g.stats[f'skipped.unreadable.{stage}'] += 1
    g.add_node(
        'SkippedFile',
        graph_key(f'{stage}:{rel}', g),
        labels=['GraphBuildWarning', 'UnreadableFile'],
        path=rel,
        stage=stage,
        reason=type(exc).__name__,
        message=str(exc),
    )


def norm_path(path: Path) -> str:
    return str(path).replace('\\', '/')


def rel_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return norm_path(path)


def normalize_project_name(name: str) -> str:
    value = re.sub(r'[^A-Za-z0-9_.-]+', '-', (name or '').strip())
    return value.strip('-') or 'project'


def graph_project(g) -> str:
    return getattr(g, 'current_project', None) or ''


def graph_rel_path(raw_rel: str, g) -> str:
    project = graph_project(g)
    return f'{project}/{raw_rel}' if project else raw_rel


def graph_key(key: str, g) -> str:
    project = graph_project(g)
    return f'{project}:{key}' if project and key else key


def stable_id(kind: str, key: str) -> str:
    digest = hashlib.sha1(f'{kind}:{key}'.encode('utf-8')).hexdigest()[:16]
    return f'{kind}:{digest}'


def short_hash(value: str) -> str:
    return hashlib.sha1(value.encode('utf-8', errors='ignore')).hexdigest()[:16]


def normalize_url(url: str) -> str:
    if not url:
        return ''
    u = url.strip().strip('"\'')
    u = re.sub(r'^[a-zA-Z]+://[^/]+', '', u)
    u = re.sub(r'\?.*$', '', u)
    u = u.replace('\\', '/')
    u = re.sub(r'/+', '/', u)
    return u.strip('/')


def join_url(a: str, b: str) -> str:
    a = normalize_url(a)
    b = normalize_url(b)
    if a and b:
        return f'{a}/{b}'
    return a or b


class Graph:
    def __init__(self):
        self.nodes = {}
        self.edges = {}
        self.class_by_fqn = {}
        self.class_by_simple = defaultdict(list)
        self.endpoint_by_path = defaultdict(list)
        self.ui_endpoint_nodes = []
        self.stats = Counter()
        self.current_project = None
        self.source_roots = []

    def add_node(self, kind, key, labels=None, **props):
        if self.current_project and 'project' not in props:
            props['project'] = self.current_project
        node_id = stable_id(kind, key)
        labels = sorted(set(labels or []) | {kind})
        existing = self.nodes.get(node_id)
        if existing:
            existing['labels'] = sorted(set(existing.get('labels', [])) | set(labels))
            existing['properties'].update({k: v for k, v in props.items() if v is not None})
            project = props.get('project')
            if project:
                projects = set(existing['properties'].get('projects') or [])
                previous = existing['properties'].get('project')
                if previous:
                    projects.add(previous)
                projects.add(project)
                existing['properties']['projects'] = sorted(projects)
            return node_id
        if props.get('project') and 'projects' not in props:
            props['projects'] = [props['project']]
        self.nodes[node_id] = {
            'id': node_id,
            'kind': kind,
            'key': key,
            'labels': labels,
            'properties': {k: v for k, v in props.items() if v is not None},
        }
        self.stats[f'node.{kind}'] += 1
        return node_id

    def add_edge(self, typ, src, dst, key=None, **props):
        if not src or not dst:
            return None
        if self.current_project and 'project' not in props:
            props['project'] = self.current_project
        edge_key = key or f'{typ}:{src}:{dst}:{json.dumps(props, sort_keys=True, ensure_ascii=False)}'
        edge_id = stable_id('edge', edge_key)
        if edge_id in self.edges:
            self.edges[edge_id]['properties'].update({k: v for k, v in props.items() if v is not None})
            return edge_id
        self.edges[edge_id] = {
            'id': edge_id,
            'type': typ,
            'from': src,
            'to': dst,
            'properties': {k: v for k, v in props.items() if v is not None},
        }
        self.stats[f'edge.{typ}'] += 1
        return edge_id

    def write(self, out_dir: Path, source_root: Path, source_roots=None, selected_projects=None):
        out_dir.mkdir(parents=True, exist_ok=True)
        with (out_dir / 'nodes.ndjson').open('w', encoding='utf-8', newline='\n') as f:
            for node in sorted(self.nodes.values(), key=lambda n: n['id']):
                f.write(json.dumps(node, ensure_ascii=False, sort_keys=True) + '\n')
        with (out_dir / 'edges.ndjson').open('w', encoding='utf-8', newline='\n') as f:
            for edge in sorted(self.edges.values(), key=lambda e: e['id']):
                f.write(json.dumps(edge, ensure_ascii=False, sort_keys=True) + '\n')
        summary = {
            'generated_at': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
            'source_root': str(source_root),
            'source_roots': source_roots or [{'name': 'default', 'path': str(source_root)}],
            'selected_projects': selected_projects or [],
            'node_count': len(self.nodes),
            'edge_count': len(self.edges),
            'stats': dict(sorted(self.stats.items())),
        }
        (out_dir / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')

        self.write_index(out_dir, 'endpoints.ndjson', lambda n: n['kind'] == 'Endpoint')
        self.write_index(out_dir, 'ui-ajax-calls.ndjson', lambda n: n['kind'] == 'AjaxCall')
        self.write_index(out_dir, 'ddd-classes.ndjson', lambda n: any(label in n.get('labels', []) for label in ('Aggregate', 'ValueObject', 'DomainService', 'Repository', 'CommandHandler', 'Finder')))
        self.write_index(out_dir, 'tables.ndjson', lambda n: n['kind'] in ('Table', 'Column'))

    def write_index(self, out_dir: Path, filename: str, predicate):
        with (out_dir / filename).open('w', encoding='utf-8', newline='\n') as f:
            for node in sorted((n for n in self.nodes.values() if predicate(n)), key=lambda n: n['id']):
                f.write(json.dumps(node, ensure_ascii=False, sort_keys=True) + '\n')


PACKAGE_RE = re.compile(r'^\s*package\s+([\w.]+)\s*;', re.M)
IMPORT_RE = re.compile(r'^\s*import\s+(?:static\s+)?([\w.*]+)\s*;', re.M)
CLASS_RE = re.compile(r'\b(public|protected|private)?\s*(?:abstract\s+|final\s+|static\s+)*\b(class|interface|enum)\s+(\w+)\s*([^\{;]*)', re.M)
METHOD_RE = re.compile(r'^\s*(public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:[\w<>\[\].?,]+\s+)+(\w+)\s*\(([^;{}]*)\)\s*(?:throws\s+[^\{]+)?\{?', re.M)
CTOR_RE_TEMPLATE = r'^\s*(public|protected|private)\s+{class_name}\s*\(([^;{{}}]*)\)\s*(?:throws\s+[^\{{]+)?\{{?'
PATH_ANNOT_RE = re.compile(r'@Path\s*\(\s*["\']([^"\']+)["\']\s*\)')
HTTP_ANNOT_RE = re.compile(r'@(GET|POST|PUT|DELETE|PATCH)\b')
TABLE_RE = re.compile(r'@Table\s*\(\s*name\s*=\s*["\']([^"\']+)["\']')
COLUMN_RE = re.compile(r'@Column\s*\(\s*name\s*=\s*["\']([^"\']+)["\']')
BUSINESS_EX_RE = re.compile(r'BusinessException\s*\(\s*["\']([^"\']+)["\']')
INJECT_FIELD_RE = re.compile(r'@Inject\s*(?:\r?\n\s*)?(?:private|protected|public)?\s+([\w.<>?]+)\s+(\w+)\s*;')
FIELD_RE = re.compile(r'^\s*(?:private|protected|public)\s+(?:static\s+)?(?:final\s+)?([\w.<>?,]+)\s+(\w+)\s*(?:=|;)', re.M)
METHOD_FIELD_CALL_RE = re.compile(r'\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(')
NEW_TYPE_RE = re.compile(r'\bnew\s+([A-Z][\w$]*)\s*\(')
STATIC_TYPE_CALL_RE = re.compile(r'\b([A-Z][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(')
CONTROL_ELEMENT_RE = re.compile(r'<(?P<tag>[A-Za-z0-9:_-]+)(?P<attrs>[^>]*)>', re.I | re.S)
ATTR_RE = re.compile(r'([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*["\']([^"\']*)["\']')
BINDING_KEY_RE = re.compile(r'\b([A-Za-z_$][\w$]*)\s*:')


def derive_module(rel: str):
    parts = rel.split('/')
    if len(parts) >= 3 and parts[0] in {'hr.ctx', 'hr.web', 'hr.file', 'hr.screen'}:
        return '/'.join(parts[:3])
    if len(parts) >= 2:
        return '/'.join(parts[:2])
    return parts[0] if parts else ''


def derive_layer(package: str, rel: str):
    checks = [('.dom', 'dom'), ('.app', 'app'), ('.infra', 'infra'), ('.ws', 'ws'), ('.ac', 'ac'), ('.pubimp', 'pubimp'), ('.pub', 'pub')]
    artifact = ''
    parts = rel.split('/')
    if len(parts) >= 3:
        artifact = parts[2]
    for suffix, layer in checks:
        if artifact.endswith(suffix) or f'.{layer}.' in package or package.endswith(f'.{layer}'):
            return layer
    return 'unknown'


def context_from_package(package: str):
    m = re.match(r'nts\.uk\.ctx\.hr\.([^.]+)', package or '')
    if m:
        return 'hr.' + m.group(1)
    if package.startswith('nts.uk.hr'):
        return 'hr.web'
    return None


def parse_annotations_before(text: str, pos: int, window_chars=700):
    start = max(0, pos - window_chars)
    block = text[start:pos]
    # Keep only the trailing annotation cluster.
    lines = block.splitlines()
    cluster = []
    for line in reversed(lines):
        s = line.strip()
        if not s:
            if cluster:
                break
            continue
        if s.startswith('@') or (cluster and (s.startswith('.') or s.endswith(')'))):
            cluster.append(s)
            continue
        break
    return '\n'.join(reversed(cluster))


def java_roles(kind, name, package, rel, decl_tail, class_text, annotations):
    roles = ['JavaType']
    if kind == 'interface':
        roles.append('JavaInterface')
    elif kind == 'enum':
        roles.append('Enum')
    else:
        roles.append('JavaClass')
    layer = derive_layer(package, rel)
    if layer:
        roles.append(f'Layer:{layer}')
    hay = ' '.join([name, package, rel, decl_tail, class_text[:1500], annotations])
    if 'DomainAggregate' in hay:
        roles.append('Aggregate')
        roles.append('DomainAggregate')
    if 'AggregateRoot' in hay:
        roles.append('Aggregate')
        roles.append('AggregateRoot')
    if 'DomainEntity' in hay:
        roles.append('Entity')
    if 'DomainValue' in hay:
        roles.append('ValueObject')
    if name.endswith('DomainService') or '.domainservice' in package.lower():
        roles.append('DomainService')
    if name.endswith('Repository'):
        roles.append('Repository')
        if kind == 'interface':
            roles.append('RepositoryInterface')
        elif name.startswith('Jpa') or '.infra.' in package:
            roles.append('RepositoryImplementation')
    if name.endswith('Handler') or name.endswith('CommandHandler'):
        roles.append('CommandHandler')
    if name.endswith('Finder'):
        roles.append('Finder')
    if name.endswith('Command'):
        roles.append('Command')
    if name.endswith('Dto') or name.endswith('DTO'):
        roles.append('DTO')
    if '@Path' in annotations or '.ws.' in package or name.endswith('WebService') or name.endswith('WebServices') or name.endswith('WS'):
        roles.append('WebService')
    if '@Table' in annotations or '@Table' in class_text[:800] or '.entity' in package:
        roles.append('JpaEntity')
    return sorted(set(roles))


def parse_java_file(path: Path, root: Path, g: Graph):
    raw_rel = rel_path(path, root)
    rel = graph_rel_path(raw_rel, g)
    if any(part in JAVA_BUILD_PARTS for part in raw_rel.split('/')):
        return
    try:
        text = read_text(path)
    except OSError as exc:
        skip_unreadable(g, path, root, 'java', exc)
        return
    package = (PACKAGE_RE.search(text).group(1) if PACKAGE_RE.search(text) else '')
    imports = IMPORT_RE.findall(text)
    simple_imports = {imp.split('.')[-1]: imp for imp in imports if not imp.endswith('.*')}
    file_id = g.add_node('File', rel, labels=['JavaFile'], path=rel, extension='.java')
    module_key = graph_key(derive_module(raw_rel), g)
    module_id = g.add_node('Module', module_key, labels=['JavaModule'], name=module_key)
    g.add_edge('CONTAINS_FILE', module_id, file_id)
    package_id = g.add_node('Package', graph_key(package or f'(default):{rel}', g), labels=['JavaPackage'], name=package)
    g.add_edge('FILE_IN_PACKAGE', file_id, package_id)
    g.add_edge('PACKAGE_IN_MODULE', package_id, module_id)

    class_matches = list(CLASS_RE.finditer(text))
    for idx, m in enumerate(class_matches):
        visibility, kind, name, tail = m.groups()
        start = m.start()
        end = class_matches[idx + 1].start() if idx + 1 < len(class_matches) else len(text)
        class_text = text[start:end]
        line = text[:start].count('\n') + 1
        annotations = parse_annotations_before(text, start)
        fqn = f'{package}.{name}' if package else name
        layer = derive_layer(package, raw_rel)
        roles = java_roles(kind, name, package, raw_rel, tail, class_text, annotations)
        class_id = g.add_node('JavaType', graph_key(fqn, g), labels=roles, name=name, fqn=fqn, kind_detail=kind, package=package, layer=layer, module=module_key, path=rel, line=line, visibility=visibility)
        g.class_by_fqn[fqn] = class_id
        g.class_by_simple[name].append(class_id)
        g.add_edge('DECLARES_TYPE', file_id, class_id, line=line)
        g.add_edge('TYPE_IN_PACKAGE', class_id, package_id)

        ext = re.search(r'\bextends\s+([\w.<>]+)', tail or '')
        if ext:
            ref = ext.group(1).split('<')[0]
            ref_id = g.add_node('TypeRef', graph_key(ref, g), labels=['JavaTypeRef'], name=ref)
            g.add_edge('EXTENDS', class_id, ref_id, line=line)
        impl = re.search(r'\bimplements\s+([^\{]+)', tail or '')
        if impl:
            for item in re.split(r',', impl.group(1)):
                ref = item.strip().split('<')[0].strip()
                if ref:
                    ref_id = g.add_node('TypeRef', graph_key(ref, g), labels=['JavaTypeRef'], name=ref)
                    g.add_edge('IMPLEMENTS', class_id, ref_id, line=line)

        class_path = ''
        p = PATH_ANNOT_RE.search(annotations)
        if p:
            class_path = p.group(1)

        table = TABLE_RE.search(class_text[:1200]) or TABLE_RE.search(annotations)
        if table:
            table_name = table.group(1)
            table_id = g.add_node('Table', table_name, labels=['DatabaseTable'], name=table_name)
            g.add_edge('MAPS_TO_TABLE', class_id, table_id, line=line)
            for cm in COLUMN_RE.finditer(class_text):
                col_name = cm.group(1)
                col_id = g.add_node('Column', f'{table_name}.{col_name}', labels=['DatabaseColumn'], name=col_name, table=table_name)
                g.add_edge('HAS_COLUMN', table_id, col_id)
                g.add_edge('MAPS_TO_COLUMN', class_id, col_id)

        for be in BUSINESS_EX_RE.finditer(class_text):
            msg = be.group(1)
            msg_id = g.add_node('MessageId', msg, labels=['BusinessMessage'], name=msg)
            g.add_edge('THROWS_MESSAGE', class_id, msg_id, line=text[:start + be.start()].count('\n') + 1)

        field_types = {}
        injected_fields = set()
        for inj in INJECT_FIELD_RE.finditer(class_text):
            typ = inj.group(1).split('<')[0].split('.')[-1]
            field = inj.group(2)
            field_types[field] = typ
            injected_fields.add(field)
            ref_id = g.add_node('TypeRef', graph_key(typ, g), labels=['InjectedTypeRef'], name=typ)
            g.add_edge('INJECTS', class_id, ref_id, field=field, line=text[:start + inj.start()].count('\n') + 1)

        for fm in FIELD_RE.finditer(class_text):
            typ = fm.group(1).split('<')[0].split('.')[-1]
            field = fm.group(2)
            field_types.setdefault(field, typ)
            field_key = graph_key(f'{fqn}#{field}', g)
            field_id = g.add_node('Field', field_key, labels=['JavaField'], name=field, type=typ, fqn=fqn, path=rel, line=text[:start + fm.start()].count('\n') + 1, injected=field in injected_fields)
            g.add_edge('DECLARES_FIELD', class_id, field_id, line=text[:start + fm.start()].count('\n') + 1)

        method_matches = list(METHOD_RE.finditer(class_text))
        ctor_re = re.compile(CTOR_RE_TEMPLATE.format(class_name=re.escape(name)), re.M)
        method_matches += list(ctor_re.finditer(class_text))
        for mm in sorted(method_matches, key=lambda x: x.start()):
            method_name = mm.group(2) if mm.re is METHOD_RE else name
            params = mm.group(3) if mm.re is METHOD_RE else mm.group(2)
            arity = 0 if not params.strip() else len([p for p in params.split(',') if p.strip()])
            abs_pos = start + mm.start()
            mline = text[:abs_pos].count('\n') + 1
            mann = parse_annotations_before(text, abs_pos)
            method_key = graph_key(f'{fqn}#{method_name}/{arity}@{mline}', g)
            method_id = g.add_node('Method', method_key, labels=['JavaMethod'], name=method_name, fqn=fqn, arity=arity, path=rel, line=mline)
            g.add_edge('DECLARES_METHOD', class_id, method_id, line=mline)
            body_start = class_text.find('{', mm.end() - 1)
            body = ''
            if body_start >= 0:
                body_end = find_matching_brace(class_text, body_start)
                if body_end > body_start:
                    body = class_text[body_start + 1:body_end]
            for cm in METHOD_FIELD_CALL_RE.finditer(body):
                receiver, called = cm.groups()
                if receiver in field_types:
                    target_type = field_types[receiver]
                    field_key = graph_key(f'{fqn}#{receiver}', g)
                    field_id = g.add_node('Field', field_key, labels=['JavaField'], name=receiver, type=target_type, fqn=fqn, path=rel, injected=receiver in injected_fields)
                    g.add_edge('METHOD_CALLS_FIELD', method_id, field_id, receiver=receiver, target_type=target_type, called_method=called, line=mline)
                    ref_id = g.add_node('TypeRef', graph_key(target_type, g), labels=['MethodCallTypeRef'], name=target_type)
                    g.add_edge('METHOD_USES_TYPE', method_id, ref_id, receiver=receiver, called_method=called, line=mline, injected=receiver in injected_fields)
            for nm in NEW_TYPE_RE.finditer(body):
                target_type = nm.group(1)
                ref_id = g.add_node('TypeRef', graph_key(target_type, g), labels=['NewTypeRef'], name=target_type)
                g.add_edge('METHOD_NEWS_TYPE', method_id, ref_id, line=mline)
            for sm in STATIC_TYPE_CALL_RE.finditer(body):
                target_type, called = sm.groups()
                if target_type not in {'String', 'Integer', 'Long', 'Boolean', 'Optional', 'List', 'Map', 'Set'}:
                    ref_id = g.add_node('TypeRef', graph_key(target_type, g), labels=['StaticCallTypeRef'], name=target_type)
                    g.add_edge('METHOD_STATIC_CALLS_TYPE', method_id, ref_id, called_method=called, line=mline)
            http = HTTP_ANNOT_RE.search(mann)
            mp = PATH_ANNOT_RE.search(mann)
            if class_path or mp or http:
                method_path = mp.group(1) if mp else ''
                full_path = join_url(class_path, method_path)
                if full_path:
                    http_method = http.group(1) if http else 'ANY'
                    endpoint_key = graph_key(f'{http_method} {full_path}', g)
                    endpoint_id = g.add_node('Endpoint', endpoint_key, labels=['JavaEndpoint', 'HttpEndpoint'], name=full_path, path=full_path, normalized_path=normalize_url(full_path), http_method=http_method, context=context_from_package(package), source='java', path_source=rel, line=mline)
                    g.endpoint_by_path[normalize_url(full_path)].append(endpoint_id)
                    g.add_edge('EXPOSES_ENDPOINT', method_id, endpoint_id, line=mline)
                    g.add_edge('OWNS_ENDPOINT', class_id, endpoint_id, line=mline)

    for imp in imports:
        if imp.endswith('.*'):
            continue
        src_classes = [cid for cid in g.nodes if False]
        # Import-to-type resolution is finalized after all classes are known.
        imp_id = g.add_node('JavaImport', imp, labels=['Import'], name=imp)
        g.add_edge('IMPORTS', file_id, imp_id)


XHTML_I18N_RE = re.compile(r'i18n\.getText\(\s*["\']([^"\']+)["\']')
DATABIND_RE = re.compile(r'data-bind\s*=\s*["\']([^"\']+)["\']', re.S)
TEMPLATE_RE = re.compile(r'<ui:composition[^>]*template\s*=\s*["\']([^"\']+)["\']', re.I)
SCRIPT_REF_RE = re.compile(r'(?:<script[^>]+src|<com:scriptfile[^>]+path)\s*=\s*["\']([^"\']+)["\']', re.I)
STYLE_REF_RE = re.compile(r'(?:<link[^>]+href|<com:stylefile[^>]+path)\s*=\s*["\']([^"\']+)["\']', re.I)


def screen_key_from_path(rel: str):
    marker = '/view/'
    nrel = '/' + rel
    idx = nrel.find(marker)
    if idx < 0:
        return None
    tail = nrel[idx + len(marker):].lstrip('/')
    parts = tail.split('/')
    if len(parts) >= 3:
        return '/'.join(parts[:3])
    return '/'.join(parts[:-1]) if len(parts) > 1 else None


def ui_origin(rel: str):
    if '/build/libs/exploded/' in '/' + rel:
        return 'exploded-build'
    if '/src/main/webapp/' in '/' + rel:
        return 'source'
    return 'unknown'


def extract_attrs(attr_text: str):
    return {m.group(1): m.group(2) for m in ATTR_RE.finditer(attr_text or '')}


def clean_label(value: str):
    return re.sub(r'[^A-Za-z0-9_:-]+', '_', value or 'unknown')


def binding_keys(bind: str):
    return BINDING_KEY_RE.findall(bind or '')


def classify_control(bind: str, tag: str, attrs):
    keys = binding_keys(bind)
    nts_components = [key for key in keys if key.startswith('nts')]
    if nts_components:
        return nts_components[0]

    tag_l = (tag or '').lower()
    typ = (attrs.get('type') or '').lower()
    if tag_l == 'button' or typ in {'button', 'submit', 'reset'} or 'click' in keys:
        return 'button'
    if tag_l == 'select' or 'options' in keys or 'selectedOptions' in keys:
        return 'select'
    if tag_l == 'textarea':
        return 'textarea'
    if tag_l == 'input':
        if typ in {'checkbox', 'radio', 'date', 'number', 'password', 'search'}:
            return f'{typ}Input'
        return 'textInput'
    if 'foreach' in keys:
        return 'repeater'
    if 'visible' in keys or 'if' in keys or 'ifnot' in keys:
        return 'conditional'
    if 'text' in keys or 'html' in keys:
        return 'displayText'
    return tag_l or 'element'


def parse_xhtml_file(path: Path, root: Path, g: Graph):
    raw_rel = rel_path(path, root)
    rel = graph_rel_path(raw_rel, g)
    try:
        text = read_text(path)
    except OSError as exc:
        skip_unreadable(g, path, root, 'xhtml', exc)
        return
    file_id = g.add_node('File', rel, labels=['XhtmlFile', 'UIFile'], path=rel, extension='.xhtml', origin=ui_origin(rel))
    screen_name = screen_key_from_path(raw_rel)
    if not screen_name:
        return
    screen_key = graph_key(screen_name, g)
    screen_id = g.add_node('Screen', screen_key, labels=['UIScreen'], name=screen_name, path='/'.join(rel.split('/')[:-1]), origin=ui_origin(rel))
    g.add_edge('SCREEN_HAS_FILE', screen_id, file_id)
    t = TEMPLATE_RE.search(text)
    if t:
        tpl = t.group(1)
        tpl_id = g.add_node('Template', tpl, labels=['XhtmlTemplate'], name=tpl)
        g.add_edge('USES_TEMPLATE', screen_id, tpl_id)
    for key in XHTML_I18N_RE.findall(text):
        tid = g.add_node('TextResource', key, labels=['I18nKey'], name=key)
        g.add_edge('USES_TEXT_RESOURCE', screen_id, tid)
    binding_nodes = []
    for i, bind in enumerate(DATABIND_RE.findall(text), start=1):
        bind_key = f'{rel}#{i}:{short_hash(bind)}'
        bid = g.add_node('Binding', bind_key, labels=['KnockoutBinding'], expression=bind, source_file=rel, ordinal=i)
        g.add_edge('HAS_BINDING', screen_id, bid)
        binding_nodes.append((bind, bid))
    control_index = 0
    for em in CONTROL_ELEMENT_RE.finditer(text):
        attrs = extract_attrs(em.group('attrs'))
        bind = attrs.get('data-bind')
        if not bind:
            continue
        control_index += 1
        tag = em.group('tag')
        component = classify_control(bind, tag, attrs)
        keys = binding_keys(bind)
        labels = ['UIControl', f'Control:{clean_label(component)}']
        if component.startswith('nts'):
            labels.append('NtsComponent')
        if component in {'button', 'submit', 'reset'} or 'click' in keys:
            labels.append('UIActionControl')
        if 'Grid' in component or component in {'repeater', 'select'}:
            labels.append('UIListControl')
        line = text[:em.start()].count('\n') + 1
        control_key = f"{rel}#{control_index}:{short_hash(tag + bind + attrs.get('id', '') + attrs.get('class', ''))}"
        ctrl_id = g.add_node(
            'UIControl',
            control_key,
            labels=labels,
            name=attrs.get('id') or attrs.get('name') or f'{component}@{line}',
            component=component,
            tag=tag,
            id_attr=attrs.get('id'),
            class_attr=attrs.get('class'),
            binding_expression=bind,
            binding_keys=keys,
            source_file=rel,
            line=line,
            origin=ui_origin(rel),
            screen=screen_name,
        )
        g.add_edge('SCREEN_HAS_CONTROL', screen_id, ctrl_id, line=line)
        if control_index <= len(binding_nodes) and binding_nodes[control_index - 1][0] == bind:
            bid = binding_nodes[control_index - 1][1]
        else:
            bind_key = f'{rel}#{control_index}:{short_hash(bind)}'
            bid = g.add_node('Binding', bind_key, labels=['KnockoutBinding'], expression=bind, source_file=rel, ordinal=control_index)
        g.add_edge('CONTROL_USES_BINDING', ctrl_id, bid, line=line)
        for key in XHTML_I18N_RE.findall(em.group(0)):
            tid = g.add_node('TextResource', key, labels=['I18nKey'], name=key)
            g.add_edge('CONTROL_USES_TEXT_RESOURCE', ctrl_id, tid, line=line)
    for ref in SCRIPT_REF_RE.findall(text):
        sid = g.add_node('ScriptRef', ref, labels=['UIAssetRef'], name=ref)
        g.add_edge('REFERENCES_SCRIPT', screen_id, sid)
    for ref in STYLE_REF_RE.findall(text):
        sid = g.add_node('StyleRef', ref, labels=['UIAssetRef'], name=ref)
        g.add_edge('REFERENCES_STYLE', screen_id, sid)


API_OBJ_START_RE = re.compile(r'\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\{')
API_ENTRY_RE = re.compile(r'([A-Za-z_$][\w$]*)\s*:\s*["\']([^"\']+)["\']')
API_ASSIGN_RE = re.compile(r'([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*["\']([^"\']+)["\']')
AJAX_RE = re.compile(r'((?:[A-Za-z_$][\w$]*\.)?\$ajax|nts\.uk\.request\.ajax)\s*\((.*?)\)', re.S)
STRING_RE = re.compile(r'^\s*["\']([^"\']+)["\']\s*$')
REF_RE = re.compile(r'^\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*$')


def find_matching_brace(text: str, open_pos: int):
    depth = 0
    in_str = None
    escape = False
    for i in range(open_pos, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == in_str:
                in_str = None
            continue
        if ch in ('"', "'"):
            in_str = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return i
    return -1


def split_args(arg_text: str):
    args = []
    cur = []
    depth = 0
    in_str = None
    escape = False
    for ch in arg_text:
        if in_str:
            cur.append(ch)
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == in_str:
                in_str = None
            continue
        if ch in ('"', "'"):
            in_str = ch
            cur.append(ch)
        elif ch in '([{':
            depth += 1
            cur.append(ch)
        elif ch in ')]}':
            depth -= 1
            cur.append(ch)
        elif ch == ',' and depth == 0:
            args.append(''.join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if cur or arg_text.strip():
        args.append(''.join(cur).strip())
    return args


def extract_api_constants(text: str):
    constants = {}
    for m in API_OBJ_START_RE.finditer(text):
        name = m.group(1)
        open_pos = text.find('{', m.start())
        close = find_matching_brace(text, open_pos)
        if close < 0:
            continue
        body = text[open_pos + 1:close]
        for em in API_ENTRY_RE.finditer(body):
            constants[f'{name}.{em.group(1)}'] = em.group(2)
    for m in API_ASSIGN_RE.finditer(text):
        constants[f'{m.group(1)}.{m.group(2)}'] = m.group(3)
    return constants


def resolve_ajax(args, constants):
    context = None
    url = None
    api_ref = None
    if not args:
        return context, url, api_ref
    first = args[0]
    m = STRING_RE.match(first)
    if m and len(args) >= 2:
        if m.group(1) in {'hr', 'com', 'at', 'pr', 'ccg', 'ctx'}:
            context = m.group(1)
            second = args[1]
            sm = STRING_RE.match(second)
            rm = REF_RE.match(second)
            if sm:
                url = sm.group(1)
            elif rm:
                api_ref = f'{rm.group(1)}.{rm.group(2)}'
                url = constants.get(api_ref)
        else:
            url = m.group(1)
    else:
        rm = REF_RE.match(first)
        if rm:
            api_ref = f'{rm.group(1)}.{rm.group(2)}'
            url = constants.get(api_ref)
        elif m:
            url = m.group(1)
    return context, url, api_ref


def parse_ui_script(path: Path, root: Path, g: Graph):
    raw_rel = rel_path(path, root)
    rel = graph_rel_path(raw_rel, g)
    if '/build/' in '/' + raw_rel and '/build/libs/exploded/' not in '/' + raw_rel:
        return
    if '/lib/generic/' in '/' + raw_rel or '/node_modules/' in '/' + raw_rel:
        return
    try:
        text = read_text(path)
    except OSError as exc:
        skip_unreadable(g, path, root, 'ui-script', exc)
        return
    ext = path.suffix.lower()
    file_id = g.add_node('File', rel, labels=['UIScriptFile', 'UIFile'], path=rel, extension=ext, origin=ui_origin(rel))
    screen_name = screen_key_from_path(raw_rel)
    screen_key = graph_key(screen_name, g) if screen_name else None
    script_id = g.add_node('Script', rel, labels=['UIScript'], name=path.name, path=rel, origin=ui_origin(rel), screen=screen_key)
    g.add_edge('FILE_DEFINES_SCRIPT', file_id, script_id)
    if screen_name:
        screen_id = g.add_node('Screen', screen_key, labels=['UIScreen'], name=screen_name, path='/'.join(rel.split('/')[:-1]), origin=ui_origin(rel))
        g.add_edge('SCREEN_HAS_SCRIPT', screen_id, script_id)

    constants = extract_api_constants(text)
    for ref, url in constants.items():
        cid = g.add_node('ApiConstant', f'{rel}:{ref}', labels=['UIApiConstant'], name=ref, url=url, normalized_path=normalize_url(url), source_file=rel)
        g.add_edge('DEFINES_API_CONSTANT', script_id, cid)

    for am in AJAX_RE.finditer(text):
        args = split_args(am.group(2))
        context, url, api_ref = resolve_ajax(args, constants)
        line = text[:am.start()].count('\n') + 1
        expr = re.sub(r'\s+', ' ', am.group(0)).strip()
        key = f'{rel}:{line}:{short_hash(expr)}'
        ajax_id = g.add_node('AjaxCall', key, labels=['UIAjaxCall'], name=f'ajax@{line}', context=context, api_ref=api_ref, url=url, normalized_path=normalize_url(url or ''), expression=expr[:300], source_file=rel, line=line, origin=ui_origin(rel))
        g.add_edge('SCRIPT_CALLS_AJAX', script_id, ajax_id, line=line)
        if screen_name:
            screen_id = g.add_node('Screen', screen_key, labels=['UIScreen'], name=screen_name, path='/'.join(rel.split('/')[:-1]), origin=ui_origin(rel))
            g.add_edge('SCREEN_CALLS_AJAX', screen_id, ajax_id, line=line)
        if url:
            ep_key = graph_key(f'{context or "default"}:{normalize_url(url)}', g)
            uep_id = g.add_node('Endpoint', ep_key, labels=['UIReferencedEndpoint', 'HttpEndpoint'], name=normalize_url(url), path=url, normalized_path=normalize_url(url), context=context, source='ui')
            g.ui_endpoint_nodes.append((uep_id, normalize_url(url)))
            g.add_edge('AJAX_REFERENCES_ENDPOINT', ajax_id, uep_id, line=line)


def finalize_links(g: Graph):
    # Resolve TypeRef nodes to concrete JavaType nodes when the simple name is unique.
    type_refs = [n for n in g.nodes.values() if n['kind'] == 'TypeRef']
    for ref in type_refs:
        name = ref['properties'].get('name')
        if not name:
            continue
        candidates = g.class_by_simple.get(name, [])
        if len(candidates) == 1:
            g.add_edge('RESOLVES_TO_TYPE', ref['id'], candidates[0], confidence='unique-simple-name')

    # Lift resolved TypeRef uses to direct method-to-type edges for easier business flow traversal.
    type_ref_resolution = {e['from']: e['to'] for e in g.edges.values() if e['type'] == 'RESOLVES_TO_TYPE'}
    for e in list(g.edges.values()):
        if e['type'] in {'METHOD_USES_TYPE', 'METHOD_NEWS_TYPE', 'METHOD_STATIC_CALLS_TYPE'}:
            resolved_type = type_ref_resolution.get(e['to'])
            if resolved_type:
                g.add_edge('METHOD_CALLS_TYPE', e['from'], resolved_type, key=f"METHOD_CALLS_TYPE:{e['from']}:{resolved_type}:{e['id']}", via=e['type'], **e.get('properties', {}))

    outgoing = defaultdict(list)
    for e in g.edges.values():
        outgoing[(e['from'], e['type'])].append(e)

    # Lift repository implementation relationships to entity/table edges.
    entity_tables = defaultdict(set)
    for e in g.edges.values():
        if e['type'] != 'MAPS_TO_TABLE':
            continue
        src = g.nodes.get(e['from'])
        if src and 'JpaEntity' in src.get('labels', []):
            entity_tables[e['from']].add(e['to'])

    for repo in [n for n in g.nodes.values() if 'RepositoryImplementation' in n.get('labels', [])]:
        repo_id = repo['id']
        for impl_edge in outgoing.get((repo_id, 'IMPLEMENTS'), []):
            interface_id = type_ref_resolution.get(impl_edge['to'])
            interface = g.nodes.get(interface_id)
            if interface and 'RepositoryInterface' in interface.get('labels', []):
                g.add_edge(
                    'REPOSITORY_IMPL_FOR',
                    repo_id,
                    interface_id,
                    key=f'REPOSITORY_IMPL_FOR:{repo_id}:{interface_id}',
                    confidence='implements-type-ref',
                )

        for decl_edge in outgoing.get((repo_id, 'DECLARES_METHOD'), []):
            method_id = decl_edge['to']
            method = g.nodes.get(method_id, {})
            for call_edge in outgoing.get((method_id, 'METHOD_CALLS_TYPE'), []):
                target = g.nodes.get(call_edge['to'])
                if not target or 'JpaEntity' not in target.get('labels', []):
                    continue
                g.add_edge(
                    'REPOSITORY_USES_ENTITY',
                    repo_id,
                    target['id'],
                    key=f"REPOSITORY_USES_ENTITY:{repo_id}:{target['id']}:{method_id}",
                    via_method=method.get('properties', {}).get('name'),
                    method_id=method_id,
                    confidence='method-body-type-use',
                )
                for table_id in sorted(entity_tables.get(target['id'], [])):
                    table = g.nodes.get(table_id, {})
                    g.add_edge(
                        'REPOSITORY_ACCESSES_TABLE',
                        repo_id,
                        table_id,
                        key=f'REPOSITORY_ACCESSES_TABLE:{repo_id}:{table_id}:{method_id}',
                        via_entity=target.get('properties', {}).get('name'),
                        via_method=method.get('properties', {}).get('name'),
                        table=table.get('properties', {}).get('name'),
                        confidence='entity-table-mapping',
                    )

    # Resolve UI endpoint references to Java endpoints by normalized path exact or suffix match.
    java_paths = [(p, eid) for p, ids in g.endpoint_by_path.items() for eid in ids]
    for uep_id, upath in sorted(set(g.ui_endpoint_nodes)):
        if not upath:
            continue
        matches = []
        if upath in g.endpoint_by_path:
            matches.extend(g.endpoint_by_path[upath])
        if not matches:
            for jpath, eid in java_paths:
                if jpath.endswith(upath) or upath.endswith(jpath):
                    matches.append(eid)
        matches = sorted(set(matches))[:5]
        endpoint = g.nodes.get(uep_id)
        if matches and endpoint:
            endpoint['properties']['resolution_status'] = 'resolved-java'
        for eid in matches:
            g.add_edge('RESOLVES_TO_JAVA_ENDPOINT', uep_id, eid, confidence='path-match')
        if matches or not endpoint:
            continue

        props = endpoint.get('properties', {})
        context = props.get('context')
        project = props.get('project')
        is_hr = context == 'hr' or upath.startswith('application/hr') or upath.startswith('hr/')
        if is_hr:
            status = 'missing-java-source'
            labels = {'MissingJavaEndpoint'}
            reason = 'UI references an HR endpoint, but no matching Java endpoint was found in this scanned uk.hr source tree.'
        elif context:
            status = 'external-or-unscanned'
            labels = {'ExternalEndpoint'}
            reason = f'UI references context {context}, whose Java source was not part of this scan.'
        else:
            status = 'unresolved'
            labels = {'UnresolvedEndpoint'}
            reason = 'UI endpoint reference could not be matched by normalized path.'
        endpoint['labels'] = sorted(set(endpoint.get('labels', [])) | labels)
        endpoint['properties']['resolution_status'] = status
        endpoint['properties']['resolution_reason'] = reason
        gap_key = f'{project}:{status}:{context or "default"}:{upath}' if project else f'{status}:{context or "default"}:{upath}'
        gap_id = g.add_node(
            'EndpointGap',
            gap_key,
            labels=['GraphGap', clean_label(status)],
            name=upath,
            normalized_path=upath,
            context=context,
            project=project,
            status=status,
            reason=reason,
        )
        g.add_edge('UNRESOLVED_ENDPOINT_REFERENCE', uep_id, gap_id, status=status, reason=reason)


def should_skip_path(path: Path, root: Path):
    rel_parts = set(rel_path(path, root).split('/'))
    return bool(rel_parts & EXCLUDE_DIRS)


def scan_source_into_graph(g: Graph, source_root: Path, project_name=None):
    g.current_project = normalize_project_name(project_name) if project_name else None
    if g.current_project:
        g.add_node(
            'Project',
            g.current_project,
            labels=['SourceProject'],
            name=g.current_project,
            source_root=str(source_root),
        )
    try:
        for path in source_root.rglob('*.java'):
            if should_skip_path(path, source_root):
                continue
            parse_java_file(path, source_root, g)
        for suffix in ('*.xhtml',):
            for path in source_root.rglob(suffix):
                if should_skip_path(path, source_root):
                    continue
                parse_xhtml_file(path, source_root, g)
        for suffix in ('*.ts', '*.js'):
            for path in source_root.rglob(suffix):
                if should_skip_path(path, source_root):
                    continue
                parse_ui_script(path, source_root, g)
    finally:
        g.current_project = None


def finalize_project_links(g: Graph):
    project_nodes = {n['key']: n['id'] for n in g.nodes.values() if n['kind'] == 'Project'}
    if not project_nodes:
        return
    for node in list(g.nodes.values()):
        if node['kind'] == 'Project':
            continue
        props = node.get('properties', {})
        projects = props.get('projects') or ([props.get('project')] if props.get('project') else [])
        for project in projects:
            project_id = project_nodes.get(project)
            if project_id:
                g.add_edge('PROJECT_CONTAINS_NODE', project_id, node['id'], key=f'PROJECT_CONTAINS_NODE:{project_id}:{node["id"]}')


def build(source_root: Path, out_dir: Path):
    g = Graph()
    scan_source_into_graph(g, source_root)
    finalize_links(g)
    finalize_project_links(g)
    g.write(out_dir, source_root)
    return g


def parse_project_spec(spec: str):
    if '=' not in spec:
        raise ValueError(f'Project spec must be name=path: {spec}')
    name, path = spec.split('=', 1)
    return {'name': normalize_project_name(name), 'path': path}


def load_project_specs(project_args, projects_file):
    specs = []
    for spec in project_args or []:
        specs.append(parse_project_spec(spec))
    if projects_file:
        data = json.loads(Path(projects_file).read_text(encoding='utf-8'))
        if isinstance(data, dict):
            data = data.get('projects', [])
        for item in data:
            specs.append({
                'name': normalize_project_name(item['name']),
                'path': item['path'],
            })
    return specs


def build_many(project_specs, out_dir: Path):
    g = Graph()
    selected = []
    scanned = []
    skipped = []
    for spec in project_specs:
        name = normalize_project_name(spec['name'])
        source_root = Path(spec['path']).resolve()
        selected.append({'name': name, 'path': str(source_root)})
        if not source_root.exists():
            skipped.append({'name': name, 'path': str(source_root), 'reason': 'folder-not-found'})
            continue
        scanned.append({'name': name, 'path': str(source_root)})
        scan_source_into_graph(g, source_root, project_name=name)
    finalize_links(g)
    finalize_project_links(g)
    g.write(
        out_dir,
        Path('multi-project'),
        source_roots=scanned,
        selected_projects=selected,
    )
    summary_path = out_dir / 'summary.json'
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
    summary['scanned_projects'] = scanned
    summary['skipped_projects'] = skipped
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    return g, scanned, skipped


def main():
    parser = argparse.ArgumentParser(description='Build a DDD-oriented business graph overlay from source.')
    parser.add_argument('--source-root')
    parser.add_argument('--project', action='append', default=[], help='Project source root as name=path. Can be repeated.')
    parser.add_argument('--projects-file', help='JSON file containing {"projects":[{"name":"...","path":"..."}]}.')
    parser.add_argument('--out-dir', required=True)
    args = parser.parse_args()
    out_dir = Path(args.out_dir).resolve()
    project_specs = load_project_specs(args.project, args.projects_file)
    if project_specs:
        graph, scanned, skipped = build_many(project_specs, out_dir)
        print(json.dumps({'nodes': len(graph.nodes), 'edges': len(graph.edges), 'out_dir': str(out_dir), 'scanned_projects': scanned, 'skipped_projects': skipped}, ensure_ascii=False))
    else:
        if not args.source_root:
            parser.error('--source-root is required unless --project or --projects-file is provided')
        source_root = Path(args.source_root).resolve()
        graph = build(source_root, out_dir)
        print(json.dumps({'nodes': len(graph.nodes), 'edges': len(graph.edges), 'out_dir': str(out_dir)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
