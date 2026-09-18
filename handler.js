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

// Mock for Amplience-logic — returns randomised content items.
async function amplienceSearch({ query, locale = "en-GB", limit = 5 }) {
  const TYPES = ["banner", "article", "product", "hero", "promo", "blog-post", "landing"];
  const TAGS  = ["sale", "new", "featured", "seasonal", "trending", "limited", "exclusive"];
  const AUTHORS = ["Alice Johnson", "Bob Smith", "Carol White", "Dan Brown", "Eva Green"];

  const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randDate = () => {
    const d = new Date(Date.now() - randInt(0, 365) * 86400000);
    return d.toISOString().split("T")[0];
  };

  const count = randInt(1, limit);
  const results = Array.from({ length: count }, (_, i) => {
    const type = rand(TYPES);
    const id = `cnt-${String(randInt(100, 999))}-${type}`;
    return {
      id,
      type,
      title: `${query} — ${type} #${i + 1}`,
      locale,
      author: rand(AUTHORS),
      tags: [rand(TAGS), rand(TAGS)].filter((v, i, a) => a.indexOf(v) === i),
      publishedAt: randDate(),
      snippet: `This is a mock ${type} content item matching the query "${query}". It contains relevant information about the topic.`,
      score: parseFloat((Math.random() * 0.4 + 0.6).toFixed(2)), // relevance 0.60–1.00
      url: `https://content.amplience.net/preview/${id}`,
    };
  });

  // Sort by relevance score descending
  return results.sort((a, b) => b.score - a.score);
}

async function handleMcpCall(method, params) {
  // MCP lifecycle: initialize
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "amplience-mcp",
        version: "1.0.0",
      },
      capabilities: {
        tools: {},
      },
    };
  }

  // MCP lifecycle: ping / notifications (no response body needed, return empty)
  if (method === "ping" || method === "notifications/initialized") {
    return {};
  }

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
      isError: false,
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
