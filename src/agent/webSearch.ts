import type { Env } from "../types";
import { getVaultCredential } from "../vault";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  publishedDate?: string;
}

interface SearxngVaultConfig {
  instanceUrl?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
}

const DEFAULT_SEARXNG_URL = "https://searxng-6mmb.onrender.com";

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

async function searchSearxng(query: string, config: SearxngVaultConfig): Promise<{ ok: true; results: WebSearchResult[] } | { ok: false; status?: number; error: string }> {
  const base = (config.instanceUrl && config.instanceUrl.trim() ? config.instanceUrl.trim() : DEFAULT_SEARXNG_URL).replace(/\/+$/, "");
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "User-Agent": "ApexAutomationWorker/1.0",
    };
    if (config.authHeaderName && config.authHeaderValue) {
      headers[config.authHeaderName] = config.authHeaderValue;
    }
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `SearXNG returned HTTP ${res.status}` };
    }
    const data = await res.json() as any;
    const raw = Array.isArray(data?.results) ? data.results : [];
    const results: WebSearchResult[] = raw.map((r: any) => ({
      title: String(r?.title || ""),
      url: String(r?.url || ""),
      snippet: String(r?.content || r?.snippet || ""),
      engine: r?.engine ? String(r.engine) : undefined,
      publishedDate: r?.publishedDate ? String(r.publishedDate) : undefined,
    })).filter((r: WebSearchResult) => r.url);
    return { ok: true, results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.includes("aborted") ? "SearXNG request timed out" : `SearXNG unreachable: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchDuckDuckGoFallback(query: string): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "ApexAutomationWorker/1.0",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results: WebSearchResult[] = [];
    // DuckDuckGo HTML results: <a rel="nofollow" class="result__a" href="...">Title</a> and <a class="result__snippet">...</a>
    const blockRe = /<div[^>]*class="[^"]*result[^"]*"[\s\S]*?<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) && results.length < 10) {
      let href = m[1] || "";
      // DDG sometimes wraps in redirect uddg=
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
      const title = stripTags(m[2] || "");
      const snippet = stripTags(m[3] || m[4] || "");
      if (href && title) results.push({ title, url: href, snippet, engine: "duckduckgo" });
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function webSearch(env: Env, uid: string, token: string, query: string): Promise<{ results: WebSearchResult[]; source: "searxng" | "duckduckgo"; warning?: string; status?: number; instanceUrl?: string }> {
  let config: SearxngVaultConfig = {};
  try {
    const cred = await getVaultCredential(env, uid, token, "searxng");
    if (cred && typeof cred === "object") config = cred as SearxngVaultConfig;
  } catch {
    config = {};
  }
  const instanceUrl = (config.instanceUrl && config.instanceUrl.trim() ? config.instanceUrl.trim() : DEFAULT_SEARXNG_URL).replace(/\/+$/, "");
  const searx = await searchSearxng(query, { ...config, instanceUrl });
  if (searx.ok) {
    return { results: searx.results, source: "searxng", instanceUrl };
  }
  const fallback = await searchDuckDuckGoFallback(query);
  const warning = searx.status === 403
    ? "SearXNG returned 403. Ensure JSON format is enabled (- json under search.formats in settings.yml). Falling back to DuckDuckGo."
    : `SearXNG unavailable (${searx.error}). Falling back to DuckDuckGo.`;
  return { results: fallback, source: "duckduckgo", warning, status: searx.status, instanceUrl };
}
