import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 300;

type SqlValue = string | number | null;
type Row = Record<string, unknown>;

export class GraphStore {
  constructor(private readonly dbPath: string) {
    if (!existsSync(dbPath)) {
      throw new Error(`Graph database not found: ${dbPath}`);
    }
  }

  graphStats() {
    const db = this.open();
    try {
      const nodeCount = this.scalarNumber(db, "select count(*) as count from nodes");
      const edgeCount = this.scalarNumber(db, "select count(*) as count from edges");
      const nodeKinds = this.rows(
        db,
        `
        select kind, count(*) as count
        from nodes
        group by kind
        order by count desc
        limit 40
        `
      );
      const edgeTypes = this.rows(
        db,
        `
        select type, count(*) as count
        from edges
        group by type
        order by count desc
        limit 40
        `
      );
      const projects = this.rows(
        db,
        `
        select project, count(*) as count
        from nodes
        where project is not null and project <> ''
        group by project
        order by project
        `
      );
      return {
        database: resolve(this.dbPath),
        node_count: nodeCount,
        edge_count: edgeCount,
        projects,
        node_kinds: nodeKinds,
        edge_types: edgeTypes
      };
    } finally {
      db.close();
    }
  }

  searchNodes(args: { query?: string; kind?: string; project?: string; limit?: number }) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const limit = this.limit(args.limit);

    const db = this.open();
    try {
      const params: SqlValue[] = [];
      const where: string[] = [];
      if (args.kind) {
        where.push("n.kind = ?");
        params.push(args.kind);
      }
      if (args.project) {
        where.push("n.project = ?");
        params.push(args.project);
      }

      let rows: Row[] = [];
      if (args.kind || args.project) {
        rows = this.directNodeSearch(db, query, where, params, limit);
        if (rows.length >= limit) {
          return { query, nodes: rows.map((row) => this.compactNode(row)) };
        }
      }

      if (this.hasTable(db, "nodes_fts")) {
        const ftsQuery = `"${query.replace(/"/g, '""')}"`;
        const whereSql = where.length ? ` and ${where.join(" and ")}` : "";
        try {
          rows = this.rows(
            db,
            `
            select n.*
            from nodes_fts f
            join nodes n on n.id = f.id
            where nodes_fts match ? ${whereSql}
            limit ?
            `,
            [ftsQuery, ...params, limit]
          );
        } catch {
          rows = this.directNodeSearch(db, query, where, params, limit);
        }
      } else {
        rows = this.directNodeSearch(db, query, where, params, limit);
      }

      return { query, nodes: rows.map((row) => this.compactNode(row)) };
    } finally {
      db.close();
    }
  }

  getNode(args: { id?: string; edge_limit?: number }) {
    const nodeId = String(args.id ?? "").trim();
    if (!nodeId) throw new Error("id is required");
    const edgeLimit = this.limit(args.edge_limit, 80);

    const db = this.open();
    try {
      const node = db.prepare("select * from nodes where id = ?").get(nodeId) as Row | undefined;
      if (!node) return { id: nodeId, found: false };

      const outEdges = this.rows(
        db,
        `
        select e.type, e.to_id as node_id, n.kind, n.name, n.fqn, n.path, n.project
        from edges e
        left join nodes n on n.id = e.to_id
        where e.from_id = ?
        order by e.type, n.kind, n.name
        limit ?
        `,
        [nodeId, edgeLimit]
      );
      const inEdges = this.rows(
        db,
        `
        select e.type, e.from_id as node_id, n.kind, n.name, n.fqn, n.path, n.project
        from edges e
        left join nodes n on n.id = e.from_id
        where e.to_id = ?
        order by e.type, n.kind, n.name
        limit ?
        `,
        [nodeId, edgeLimit]
      );

      return {
        found: true,
        node: this.fullNode(node),
        out_edges: outEdges,
        in_edges: inEdges
      };
    } finally {
      db.close();
    }
  }

  expandNode(args: {
    id?: string;
    query?: string;
    kind?: string;
    project?: string;
    depth?: number;
    direction?: string;
    limit?: number;
  }) {
    const depth = Math.max(1, Math.min(Number(args.depth ?? 1), 4));
    const limit = this.limit(args.limit, 120);
    const direction = ["both", "out", "in"].includes(String(args.direction)) ? String(args.direction) : "both";
    let nodeId = String(args.id ?? "").trim();

    if (!nodeId) {
      const matches = this.searchNodes({
        query: args.query,
        kind: args.kind,
        project: args.project,
        limit: 1
      }).nodes;
      if (matches.length === 0) return { root: null, nodes: [], edges: [] };
      nodeId = String(matches[0].id);
    }

    const db = this.open();
    try {
      const root = db.prepare("select * from nodes where id = ?").get(nodeId) as Row | undefined;
      if (!root) return { root: null, nodes: [], edges: [] };

      const seenNodes = new Set<string>([nodeId]);
      const nodeRows = new Map<string, Row>([[nodeId, root]]);
      const edgeRows: Row[] = [];
      let frontier = new Set<string>([nodeId]);

      for (let step = 0; step < depth; step += 1) {
        if (frontier.size === 0 || edgeRows.length >= limit) break;
        const batch = Array.from(frontier);
        frontier = new Set<string>();
        const placeholders = batch.map(() => "?").join(",");
        const sqlParts: string[] = [];
        const params: SqlValue[] = [];

        if (direction === "both" || direction === "out") {
          sqlParts.push(
            `select from_id, to_id, type, properties_json as properties from edges where from_id in (${placeholders}) and type <> 'PROJECT_CONTAINS_NODE'`
          );
          params.push(...batch);
        }
        if (direction === "both" || direction === "in") {
          sqlParts.push(
            `select from_id, to_id, type, properties_json as properties from edges where to_id in (${placeholders}) and type <> 'PROJECT_CONTAINS_NODE'`
          );
          params.push(...batch);
        }

        const rows = this.rows(db, `${sqlParts.join(" union all ")} limit ?`, [...params, limit]);
        for (const edge of rows) {
          edgeRows.push(edge);
          for (const id of [String(edge.from_id), String(edge.to_id)]) {
            if (!seenNodes.has(id)) {
              seenNodes.add(id);
              frontier.add(id);
            }
          }
          if (edgeRows.length >= limit) break;
        }

        const missing = Array.from(seenNodes).filter((id) => !nodeRows.has(id));
        if (missing.length > 0) {
          const missingPlaceholders = missing.map(() => "?").join(",");
          for (const row of this.rows(db, `select * from nodes where id in (${missingPlaceholders})`, missing)) {
            nodeRows.set(String(row.id), row);
          }
        }
      }

      return {
        root: this.compactNode(root),
        nodes: Array.from(nodeRows.values()).map((row) => this.compactNode(row)),
        edges: edgeRows.map((row) => this.compactEdge(row))
      };
    } finally {
      db.close();
    }
  }

  traceScreen(args: { screen?: string; project?: string; limit?: number; include_backend?: boolean; backend_limit?: number }) {
    const screen = String(args.screen ?? "").trim();
    if (!screen) throw new Error("screen is required");
    const limit = this.limit(args.limit);
    const backendLimit = Math.min(this.limit(args.backend_limit, 5), 20);
    const params: SqlValue[] = [screen, `%:${screen}`, `%:${screen}/%`];
    const projectSql = args.project ? " and screen_project = ?" : "";
    if (args.project) params.push(args.project);

    const db = this.open();
    try {
      const rows = this.rows(
        db,
        `
        select *
        from v_screen_ajax_endpoint
        where (screen = ? or screen like ? or screen like ?)
        ${projectSql}
        order by screen, ajax_name, ui_endpoint, java_endpoint
        limit ?
        `,
        [...params, limit]
      );
      const backendByEndpoint: Record<string, unknown> = {};
      if (args.include_backend !== false) {
        const endpointIds = uniqueStrings(rows.map((row) => row.java_endpoint_id)).slice(0, backendLimit);
        for (const endpointId of endpointIds) {
          backendByEndpoint[endpointId] = this.backendForEndpoint(db, endpointId, backendLimit);
        }
      }
      return {
        screen,
        rows,
        backend_by_java_endpoint: backendByEndpoint,
        trace_hint:
          "Use rows[].java_endpoint_id to inspect backend_by_java_endpoint. If more detail is needed, call get_node or expand_node on method/type/repository ids returned here."
      };
    } finally {
      db.close();
    }
  }

  findEndpointGaps(args: { status?: string; project?: string; limit?: number }) {
    const limit = this.limit(args.limit);
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (args.status) {
      where.push("status = ?");
      params.push(args.status);
    }
    if (args.project) {
      where.push("project = ?");
      params.push(args.project);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const db = this.open();
    try {
      const rows = this.rows(
        db,
        `
        select *
        from v_endpoint_gaps
        ${whereSql}
        order by status desc, name
        limit ?
        `,
        [...params, limit]
      );
      return { rows };
    } finally {
      db.close();
    }
  }

  repositoryPersistence(args: { repository?: string; project?: string; limit?: number }) {
    const limit = this.limit(args.limit);
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (args.repository) {
      const like = `%${args.repository}%`;
      where.push("(repository_name like ? or repository_fqn like ?)");
      params.push(like, like);
    }
    if (args.project) {
      where.push("repository_project = ?");
      params.push(args.project);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const db = this.open();
    try {
      const rows = this.rows(
        db,
        `
        select *
        from v_repository_persistence
        ${whereSql}
        order by repository_name, target_name, target_table
        limit ?
        `,
        [...params, limit]
      );
      return { rows };
    } finally {
      db.close();
    }
  }

  methodCallsType(args: { query?: string; project?: string; limit?: number }) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const limit = this.limit(args.limit);
    const like = `%${query}%`;
    const params: SqlValue[] = [like, like, like, like];
    const projectSql = args.project ? " and method_project = ?" : "";
    if (args.project) params.push(args.project);

    const db = this.open();
    try {
      const rows = this.rows(
        db,
        `
        select *
        from v_method_calls_type
        where (
          method_name like ?
          or method_owner_fqn like ?
          or target_type_name like ?
          or target_type_fqn like ?
        )
        ${projectSql}
        order by method_owner_fqn, method_name, target_type_name
        limit ?
        `,
        [...params, limit]
      );
      return { query, rows };
    } finally {
      db.close();
    }
  }

  private backendForEndpoint(db: Database.Database, endpointId: string, limit: number) {
    const endpoint = db.prepare("select * from nodes where id = ?").get(endpointId) as Row | undefined;
    const methodRows = this.rows(
      db,
      `
      select m.*
      from edges e
      join nodes m on m.id = e.from_id
      where e.to_id = ? and e.type = 'EXPOSES_ENDPOINT'
      order by m.fqn, m.name
      limit ?
      `,
      [endpointId, limit]
    );

    return {
      endpoint: endpoint ? this.compactNode(endpoint) : { id: endpointId, found: false },
      exposing_methods: methodRows.map((method) => this.backendForMethod(db, method, limit))
    };
  }

  private backendForMethod(db: Database.Database, method: Row, limit: number) {
    const methodId = String(method.id);
    const ownerRows = this.rows(
      db,
      `
      select t.*
      from edges e
      join nodes t on t.id = e.from_id
      where e.to_id = ? and e.type = 'DECLARES_METHOD'
      order by t.fqn, t.name
      limit 3
      `,
      [methodId]
    );
    const relatedRows = this.rows(
      db,
      `
      select e.type, e.properties_json as properties, n.id as node_id, n.kind, n.name, n.fqn, n.path, n.project
      from edges e
      left join nodes n on n.id = e.to_id
      where e.from_id = ?
        and e.type in (
          'METHOD_CALLS_FIELD',
          'METHOD_CALLS_TYPE',
          'METHOD_STATIC_CALLS_TYPE',
          'METHOD_NEWS_TYPE',
          'METHOD_USES_TYPE'
        )
      order by e.type, n.kind, n.name
      limit ?
      `,
      [methodId, Math.min(limit * 3, MAX_LIMIT)]
    );
    const javaTypeIds = uniqueStrings(
      relatedRows.filter((row) => row.kind === "JavaType").map((row) => row.node_id)
    ).slice(0, limit);

    return {
      method: this.compactNode(method),
      owner_types: ownerRows.map((row) => this.compactNode(row)),
      related_backend_nodes: relatedRows.map((row) => this.compactRelatedEdge(row)),
      related_type_details: javaTypeIds.map((typeId) => this.backendForType(db, typeId, limit))
    };
  }

  private backendForType(db: Database.Database, typeId: string, limit: number) {
    const type = db.prepare("select * from nodes where id = ?").get(typeId) as Row | undefined;
    const declaredMethods = this.rows(
      db,
      `
      select m.id, m.kind, m.name, m.fqn, m.path, m.project, m.line
      from edges e
      join nodes m on m.id = e.to_id
      where e.from_id = ? and e.type = 'DECLARES_METHOD'
      order by
        case when lower(m.name) in ('handle', 'execute') then 0 else 1 end,
        m.name
      limit ?
      `,
      [typeId, limit]
    );
    const injectedTypes = this.rows(
      db,
      `
      select tr.id, tr.kind, tr.name, tr.fqn, tr.path, tr.project, e.properties_json as properties
      from edges e
      join nodes tr on tr.id = e.to_id
      where e.from_id = ? and e.type = 'INJECTS'
      order by tr.name
      limit ?
      `,
      [typeId, limit]
    );
    const fields = this.rows(
      db,
      `
      select f.id, f.kind, f.name, f.fqn, f.path, f.project, f.line
      from edges e
      join nodes f on f.id = e.to_id
      where e.from_id = ? and e.type = 'DECLARES_FIELD'
      order by f.name
      limit ?
      `,
      [typeId, limit]
    );
    const repositoryNames = uniqueStrings([
      ...injectedTypes.map((row) => row.name),
      ...fields.map((row) => row.name)
    ]).filter((name) => /repository/i.test(name));

    return {
      type: type ? this.compactNode(type) : { id: typeId, found: false },
      declared_methods: declaredMethods.map((row) => this.compactNode(row)),
      injected_types: injectedTypes.map((row) => this.compactRelatedEdge({ ...row, node_id: row.id })),
      fields: fields.map((row) => this.compactNode(row)),
      repository_persistence: this.repositoryPersistenceForNames(db, repositoryNames, limit)
    };
  }

  private repositoryPersistenceForNames(db: Database.Database, names: string[], limit: number) {
    const results: Row[] = [];
    const seen = new Set<string>();
    for (const name of names.slice(0, limit)) {
      const like = `%${name}%`;
      const rows = this.rows(
        db,
        `
        select *
        from v_repository_persistence
        where target_name = ?
           or repository_name like ?
           or repository_fqn like ?
        order by repository_name, relation, target_name
        limit ?
        `,
        [name, like, like, limit]
      );
      for (const row of rows) {
        const key = JSON.stringify([row.repository_id, row.relation, row.target_id, row.target_name]);
        if (!seen.has(key)) {
          seen.add(key);
          results.push(row);
        }
      }
    }
    return results.slice(0, limit * 2);
  }

  private open() {
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    return db;
  }

  private directNodeSearch(db: Database.Database, query: string, where: string[], params: SqlValue[], limit: number) {
    const like = `%${query}%`;
    const whereSql = [
      ...where,
      `
      (
        n.name like ?
        or n.fqn like ?
        or n.key like ?
        or n.path like ?
        or n.normalized_path like ?
        or n.source_file like ?
        or n.component like ?
        or n.context like ?
      )
      `
    ].join(" and ");
    return this.rows(
      db,
      `
      select n.*
      from nodes n
      where ${whereSql}
      limit ?
      `,
      [...params, like, like, like, like, like, like, like, like, limit]
    );
  }

  private hasTable(db: Database.Database, name: string) {
    const row = db
      .prepare("select 1 from sqlite_master where type in ('table', 'view') and name = ?")
      .get(name) as Row | undefined;
    return Boolean(row);
  }

  private scalarNumber(db: Database.Database, sql: string) {
    const row = db.prepare(sql).get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private rows(db: Database.Database, sql: string, params: SqlValue[] = []) {
    return db.prepare(sql).all(...params).map((row) => this.plain(row as Row));
  }

  private compactNode(row: Row) {
    const item = this.plain(row);
    return {
      id: item.id,
      kind: item.kind,
      project: item.project,
      key: item.key,
      name: item.name,
      fqn: item.fqn,
      path: item.path,
      source_file: item.source_file,
      line: item.line,
      component: item.component,
      normalized_path: item.normalized_path,
      resolution_status: item.resolution_status,
      labels: this.loads(item.labels, [])
    };
  }

  private fullNode(row: Row) {
    const item = this.plain(row);
    return {
      ...item,
      labels: this.loads(item.labels, []),
      properties: this.loads(item.properties ?? item.properties_json, {})
    };
  }

  private compactEdge(row: Row) {
    const item = this.plain(row);
    return {
      ...item,
      properties: this.loads(item.properties ?? item.properties_json, {})
    };
  }

  private compactRelatedEdge(row: Row) {
    const item = this.plain(row);
    return {
      type: item.type,
      node_id: item.node_id,
      kind: item.kind,
      name: item.name,
      fqn: item.fqn,
      path: item.path,
      project: item.project,
      properties: this.loads(item.properties ?? item.properties_json, {})
    };
  }

  private plain(row: Row) {
    const item: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        item[key] = value;
      } else {
        item[key] = String(value);
      }
    }
    return item;
  }

  private loads(value: unknown, fallback: unknown) {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value !== "string") return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  private limit(value: unknown, defaultValue = DEFAULT_LIMIT) {
    const parsed = Number(value ?? defaultValue);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.max(1, Math.min(Math.trunc(parsed), MAX_LIMIT));
  }
}

function uniqueStrings(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
}
