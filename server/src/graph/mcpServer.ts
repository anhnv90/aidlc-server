import { GraphStore } from "./graphStore";

export const GRAPH_MCP_SERVER_NAME = "hr-ast-graph";
export const GRAPH_MCP_SERVER_VERSION = "0.1.0";

type JsonRpcId = string | number | null;
type JsonRecord = Record<string, unknown>;

export const GRAPH_MCP_TOOLS = [
  {
    name: "graph_stats",
    description: "Return high-level counts for projects, node kinds, and edge types in the business graph.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "search_nodes",
    description: "Search graph nodes by text, optionally restricted by node kind or project.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string" },
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 300 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "get_node",
    description: "Get one node by id plus its incoming and outgoing adjacent edges.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        edge_limit: { type: "integer", minimum: 1, maximum: 300 }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "expand_node",
    description: "Expand a small neighborhood around a node id or around the first node matching a search query.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        query: { type: "string" },
        kind: { type: "string" },
        project: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 4 },
        direction: { type: "string", enum: ["both", "out", "in"] },
        limit: { type: "integer", minimum: 1, maximum: 300 }
      },
      additionalProperties: false
    }
  },
  {
    name: "trace_screen",
    description:
      "Trace a UI screen to AJAX actions, Java endpoints, exposing backend methods, handler/service type candidates, injected repositories, and repository/table evidence when present.",
    inputSchema: {
      type: "object",
      properties: {
        screen: { type: "string" },
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 300 },
        include_backend: { type: "boolean" },
        backend_limit: { type: "integer", minimum: 1, maximum: 20 }
      },
      required: ["screen"],
      additionalProperties: false
    }
  },
  {
    name: "find_endpoint_gaps",
    description: "List endpoint resolution gaps, optionally filtered by resolution_status or project.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 300 }
      },
      additionalProperties: false
    }
  },
  {
    name: "repository_persistence",
    description: "Find repository-to-entity/table persistence relationships.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 300 }
      },
      additionalProperties: false
    }
  },
  {
    name: "method_calls_type",
    description: "Find methods related to a method/type text query, using method-call and type-use graph views.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 300 }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
];

export class GraphMcpServer {
  constructor(private readonly store: GraphStore) {}

  handle(message: unknown) {
    if (!isRecord(message)) {
      return jsonRpcError(null, -32600, "Invalid Request");
    }

    const id = jsonRpcId(message.id);
    const method = typeof message.method === "string" ? message.method : "";
    const params = isRecord(message.params) ? message.params : {};

    try {
      if (method === "initialize") {
        const protocolVersion =
          isRecord(params) && typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2024-11-05";
        return jsonRpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: GRAPH_MCP_SERVER_NAME,
            version: GRAPH_MCP_SERVER_VERSION
          }
        });
      }
      if (method === "notifications/initialized") return null;
      if (method === "ping") return jsonRpcResult(id, {});
      if (method === "tools/list") return jsonRpcResult(id, { tools: GRAPH_MCP_TOOLS });
      if (method === "tools/call") return jsonRpcResult(id, this.callTool(params));
      if (method === "resources/list") return jsonRpcResult(id, { resources: [] });
      if (method === "prompts/list") return jsonRpcResult(id, { prompts: [] });
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    } catch (err) {
      return jsonRpcError(id, -32603, errorMessage(err));
    }
  }

  private callTool(params: JsonRecord) {
    const name = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};

    try {
      switch (name) {
        case "graph_stats":
          return toolResult(this.store.graphStats());
        case "search_nodes":
          return toolResult(this.store.searchNodes(args));
        case "get_node":
          return toolResult(this.store.getNode(args));
        case "expand_node":
          return toolResult(this.store.expandNode(args));
        case "trace_screen":
          return toolResult(this.store.traceScreen(args));
        case "find_endpoint_gaps":
          return toolResult(this.store.findEndpointGaps(args));
        case "repository_persistence":
          return toolResult(this.store.repositoryPersistence(args));
        case "method_calls_type":
          return toolResult(this.store.methodCallsType(args));
        default:
          return toolError(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return toolError(errorMessage(err));
    }
  }
}

function toolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    isError: false
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function jsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
