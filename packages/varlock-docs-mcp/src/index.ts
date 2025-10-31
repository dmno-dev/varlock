import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkgJson from '../package.json';

// Import the Env type for Cloudflare Durable Object and AI binding support
type Env = {
  MCP_OBJECT: DurableObjectNamespace<any>;
  AI: any;
};

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: 'Varlock docs MCP',
    version: pkgJson.version,
  });

  async init() {
    const env = this.env as Env;
    this.server.tool('varlock docs', {
      query: z.string(),
    }, async ({ query }) => {
      const docs = await env.AI.autorag('varlock-docs-mcp-search').aiSearch({
        query,
        system_prompt: [
          'You are a helpful assistant that can answer questions about the Varlock docs.',
          'Don\'t make up information, only provide answers that are based on the actual content of the docs.',
          'Include links back to the docs site (https://varlock.dev) where possible.',
        ].join('\n'),
        rewrite_query: true,
      });
      return {
        content: [{ type: 'text', text: docs.response }],
      };
    });
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === '/sse' || url.pathname === '/sse/message') {
      return MyMCP.serveSSE('/sse').fetch(request, env, ctx);
    }

    if (url.pathname === '/mcp') {
      return MyMCP.serve('/mcp').fetch(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
};
