/** web_search + web_fetch — optional search endpoint and HTML-to-text fetch. */

import type { ToolHandlerFor } from '../types.js';
import type {
  WebFetchArgs,
  WebFetchSuccess,
  WebSearchArgs,
  WebSearchReference,
  WebSearchSuccess,
} from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_SIZE_LIMIT = 2 * 1024 * 1024;

export const webSearchTool: ToolHandlerFor<'web_search'> = {
  name: 'web_search',
  description: 'Search the web. Requires OPENCURSOR_SEARCH_URL on the host; returns titled references.',
  input_schema: {
    type: 'object',
    properties: {
      search_term: { type: 'string', description: 'Search query' },
    },
    required: ['search_term'],
  },
  default_permission: 'ask',
  async execute(args: WebSearchArgs, ctx) {
    const endpoint = process.env['OPENCURSOR_SEARCH_URL'];
    if (!endpoint) {
      return err('invalid_args', 'web_search not configured: set OPENCURSOR_SEARCH_URL (POST {query} -> {results:[{title,url,snippet}]})');
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: args.search_term }),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        return err('internal', `search endpoint returned ${response.status}`);
      }
      const payload = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
      const references: WebSearchReference[] = (payload.results ?? []).map((item) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        chunk: item.snippet ?? '',
      }));
      const value: WebSearchSuccess = { references };
      return ok(value);
    } catch (error) {
      return err('internal', `search failed: ${String(error)}`);
    }
  },
};

function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|tr)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export const webFetchTool: ToolHandlerFor<'web_fetch'> = {
  name: 'web_fetch',
  description: 'Fetch a URL and return readable text/markdown content (HTML is converted, 2MB limit).',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL to fetch' },
    },
    required: ['url'],
  },
  default_permission: 'ask',
  async execute(args: WebFetchArgs, ctx) {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      return err('invalid_args', `invalid URL: ${args.url}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return err('invalid_args', `unsupported protocol: ${url.protocol}`);
    }

    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'opencursor/0.1' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });
      if (!response.ok) return err('internal', `fetch returned ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > FETCH_SIZE_LIMIT) return err('invalid_args', 'response exceeds 2MB limit');
      const contentType = response.headers.get('content-type') ?? '';
      const body = buffer.toString('utf8');
      const markdown = contentType.includes('html') ? htmlToText(body) : body;
      const value: WebFetchSuccess = { url: url.toString(), markdown };
      return ok(value);
    } catch (error) {
      if (ctx.signal.aborted) return err('cancelled', 'fetch cancelled');
      return err('internal', `fetch failed: ${String(error)}`);
    }
  },
};
