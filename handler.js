import { createServer } from "http";

const TOOLS = [
  {
    name: "amplience_search",
    description:
      "Search content in Amplience by query/keywords and return relevant items/snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "User query / keywords" },
        locale: { type: "string", default: "en-GB" },
        limit: { type: "integer", default: 5, minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
];

function response(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      ...extraHeaders,
    },
    body: JSON.stringify(obj),
  };
}

// Mock for Amplience-logic.
async function amplienceSearch({ query, locale, limit }) {
  // TODO: fetch(...) to Amplience (Dynamic Content Search API / Delivery API / GraphQL)
  return [
    { id: "cnt-001", title: `Result for "${query}"`, locale, snippet: "..." },
  ].slice(0, limit);
}

async function handleMcpCall(method, params) {
  // MCP discovery
  if (method === "tools/list") {
    return { tools: TOOLS };
  }

  // MCP tool execution
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    if (name !== "amplience_search") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const query = args?.query;
    const locale = args?.locale ?? "en-GB";
    const limit = args?.limit ?? 5;

    if (!query || typeof query !== "string") {
      throw new Error(`Invalid args: "query" is required`);
    }

    const items = await amplienceSearch({ query, locale, limit });

    const text =
      items.length === 0
        ? `Nothing found in Amplience for query: ${query}`
        : `Found ${items.length} result(s) in Amplience for "${query}":\n` +
          items.map((x, i) => `${i + 1}. ${x.title} (${x.id})`).join("\n");

    return {
      content: [{ type: "text", text }],
      items,
    };
  }

  throw new Error(`Unknown method: ${method}`);
}

export const handler = async (event) => {
  const httpMethod =
    event?.requestContext?.http?.method || event?.httpMethod || "GET";

  if (httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      },
      body: "",
    };
  }

  // In case CodeMie performs a GET request to retrieve tools.
  if (httpMethod === "GET") {
    return response(200, { tools: TOOLS });
  }

  // Main mode: POST with MCP message
  try {
    const rawBody = event?.body ?? "{}";
    const bodyStr = event?.isBase64Encoded
      ? Buffer.from(rawBody, "base64").toString("utf8")
      : rawBody;

    const body = typeof bodyStr === "string" ? JSON.parse(bodyStr) : bodyStr;

    // Support several popular formats:
    // 1) JSON-RPC style: { jsonrpc:"2.0", id, method, params }
    // 2) Simplified: { method, params }
    const method = body?.method;
    const params = body?.params;

    const result = await handleMcpCall(method, params);

    // JSON-RPC-like response
    if (body?.id !== undefined) {
      return response(200, { jsonrpc: "2.0", id: body.id, result });
    }

    return response(200, { result });
  } catch (e) {
    // JSON-RPC error if id is present
    let id;
    try {
      const b = JSON.parse(event?.body ?? "{}");
      id = b?.id;
    } catch {}

    const errObj = { message: e?.message ?? "Unknown error" };

    if (id !== undefined) {
      return response(200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, ...errObj },
      });
    }

    return response(500, { error: errObj });
  }
};

// HTTP server — keeps the process alive on Render
const PORT = process.env.PORT || 3000;

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  const event = {
    httpMethod: req.method,
    headers: req.headers,
    body: rawBody || "{}",
    isBase64Encoded: false,
    requestContext: { http: { method: req.method } },
  };

  const result = await handler(event);

  res.writeHead(result.statusCode, result.headers);
  res.end(result.body);
}).listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
});
