interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * GNews MCP — Global news search via GNews API (gnews.io)
 *
 * BYO key: requires a free GNews API key from https://gnews.io
 * Passed via _apiKey parameter. Free tier: 100 requests/day.
 *
 * Tools:
 * - search_news: search news articles by keyword
 * - top_headlines: get top headlines by category and country
 */


const BASE = 'https://gnews.io/api/v4';

// ── Helpers ───────────────────────────────────────────────────────────

function extractKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string;
  delete args._apiKey;
  if (!key) throw new Error('GNews API key required. Get one free at https://gnews.io and pass via _apiKey.');
  return key;
}

async function gnewsGet(apiKey: string, path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set('apikey', apiKey);

  // The shared platform key hits GNews's per-second burst limit (429 "too many
  // requests in a short period") under concurrent traffic — the pack's top
  // error class. Retry 429/5xx with backoff; the burst window clears in ~1s.
  // A non-429 4xx (bad request / invalid key) fails fast.
  let lastStatus = 0;
  let lastText = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url.toString());
    if (res.ok) return res.json();
    lastStatus = res.status;
    lastText = await res.text();
    if ((lastStatus !== 429 && lastStatus < 500) || attempt === 2) break;
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  // GNews's free tier is 100 requests/day, so the SHARED platform key routinely
  // exhausts its daily quota (403) or per-second burst (429 after retries) — the
  // pack's dominant error. Don't dead-end: point the agent at our KEYLESS news
  // sources so it gets news anyway, or its own key for a dedicated quota.
  if (lastStatus === 403 || lastStatus === 429) {
    throw new Error(
      `GNews shared quota exhausted (HTTP ${lastStatus}; free tier is 100/day). For news right now, use a keyless Pipeworx news source instead — gdelt (global news search), currents, mediastack, or us-news-feeds. Or pass your own GNews key via _apiKey (free at gnews.io) for a dedicated quota.`,
    );
  }
  throw new Error(`GNews API error (${lastStatus}): ${lastText}`);
}

// ── Types ─────────────────────────────────────────────────────────────

type GNewsArticle = {
  title?: string | null;
  description?: string | null;
  content?: string | null;
  url?: string | null;
  image?: string | null;
  publishedAt?: string | null;
  source?: { name?: string | null; url?: string | null } | null;
};

type GNewsResponse = {
  totalArticles?: number;
  articles: GNewsArticle[];
};

function formatArticle(a: GNewsArticle) {
  return {
    title: a.title ?? null,
    description: a.description ?? null,
    content: a.content ?? null,
    url: a.url ?? null,
    image: a.image ?? null,
    published_at: a.publishedAt ?? null,
    source_name: a.source?.name ?? null,
    source_url: a.source?.url ?? null,
  };
}

// ── Tool definitions ──────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_news',
    description:
      'Search global news articles by keyword (e.g., "climate change", "AI regulation"). Returns title, description, content snippet, source, and publication date. Supports language and country filters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _apiKey: { type: 'string', description: 'GNews API key' },
        query: { type: 'string', description: 'Search keywords (e.g., "electric vehicles")' },
        lang: { type: 'string', description: 'Language code (e.g., "en", "fr", "de"). Default: "en"' },
        country: { type: 'string', description: 'Country code (e.g., "us", "gb", "ca"). Omit for global' },
        max: { type: 'number', description: 'Max articles to return (1-100, default 10)' },
      },
      required: ['_apiKey', 'query'],
    },
  },
  {
    name: 'top_headlines',
    description:
      'Fetch current top news headlines from GNews (requires BYO API key). Optionally filter by category (general, world, nation, business, technology, entertainment, sports, science, health), country code, and language. Returns up to 100 articles with title, description, source, and publication date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _apiKey: { type: 'string', description: 'GNews API key' },
        category: {
          type: 'string',
          description: 'News category: general, world, nation, business, technology, entertainment, sports, science, health',
        },
        country: { type: 'string', description: 'Country code (e.g., "us", "gb"). Omit for global' },
        lang: { type: 'string', description: 'Language code (e.g., "en"). Default: "en"' },
        max: { type: 'number', description: 'Max articles to return (1-100, default 10)' },
      },
      required: ['_apiKey'],
    },
  },
];

// ── callTool dispatcher ───────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);

  switch (name) {
    case 'search_news':
      return searchNews(key, args);
    case 'top_headlines':
      return topHeadlines(key, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool implementations ─────────────────────────────────────────────

// GNews query syntax rejects unbalanced double-quotes and stray operator
// punctuation. Agents pass natural-language questions ("What's the news on
// AT&T's /new/ CEO?") that trip the 400 "query has a syntax error". Balance
// quotes preemptively (zero-risk); on a syntax 400, retry once with a
// hard-stripped query so a malformed question still returns news.
function balanceGnewsQuotes(q: string): string {
  const quotes = (q.match(/"/g) ?? []).length;
  return quotes % 2 === 0 ? q : q.replace(/"/g, '');
}
function hardSanitizeGnewsQuery(q: string): string {
  return q
    .replace(/["'()]/g, ' ')       // quotes / parens
    .replace(/[\\/^~*?:!&|]/g, ' ') // reserved / breaking punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchNews(apiKey: string, args: Record<string, unknown>) {
  const rawQuery = balanceGnewsQuotes(String(args.query ?? '').trim());
  const params: Record<string, string> = {
    q: rawQuery,
    lang: (args.lang as string) ?? 'en',
    max: String(Math.min(100, Math.max(1, (args.max as number) ?? 10))),
  };
  if (args.country) params.country = args.country as string;

  let data: GNewsResponse;
  let sanitized_query: string | undefined;
  try {
    data = (await gnewsGet(apiKey, 'search', params)) as GNewsResponse;
  } catch (err) {
    const msg = (err as Error).message;
    const cleaned = hardSanitizeGnewsQuery(rawQuery);
    // Retry only a genuine query-syntax 400, and only if stripping changed
    // something (else we'd just re-hit the same error). Other errors re-throw.
    if (/\b400\b/.test(msg) && /syntax/i.test(msg) && cleaned && cleaned !== rawQuery) {
      params.q = cleaned;
      data = (await gnewsGet(apiKey, 'search', params)) as GNewsResponse;
      sanitized_query = cleaned;
    } else {
      throw err;
    }
  }

  return {
    total_articles: data.totalArticles ?? data.articles.length,
    returned: data.articles.length,
    ...(sanitized_query
      ? { sanitized_query, note: `Original query had GNews syntax issues; retried with a cleaned query: "${sanitized_query}".` }
      : {}),
    articles: data.articles.map(formatArticle),
  };
}

async function topHeadlines(apiKey: string, args: Record<string, unknown>) {
  const params: Record<string, string> = {
    lang: (args.lang as string) ?? 'en',
    max: String(Math.min(100, Math.max(1, (args.max as number) ?? 10))),
  };
  if (args.category) params.category = args.category as string;
  if (args.country) params.country = args.country as string;

  const data = (await gnewsGet(apiKey, 'top-headlines', params)) as GNewsResponse;

  return {
    total_articles: data.totalArticles ?? data.articles.length,
    returned: data.articles.length,
    articles: data.articles.map(formatArticle),
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
