/*
 * Proxies SEC EDGAR requests, adding the User-Agent header SEC requires
 * (https://www.sec.gov/os/webmaster-faq#developers) and CORS headers so
 * the site can call it from the browser.
 *
 * Routes:
 *   /data/*  -> https://data.sec.gov/*
 *   /www/*   -> https://www.sec.gov/*
 *
 * Replace SEC_CONTACT below with a real contact email before deploying —
 * SEC blocks traffic from User-Agents that don't identify a requester.
 */
const SEC_CONTACT = 'VerdictCat contact@example.com';

const UPSTREAM_HOSTS = {
  data: 'https://data.sec.gov',
  www: 'https://www.sec.gov',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const [, prefix, ...rest] = url.pathname.split('/');
    const upstreamHost = UPSTREAM_HOSTS[prefix];
    if (!upstreamHost) {
      return new Response('Unknown route. Use /data/* or /www/*.', { status: 404 });
    }

    const upstreamUrl = upstreamHost + '/' + rest.join('/') + url.search;

    const upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': SEC_CONTACT,
        'Accept-Encoding': 'gzip, deflate',
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  },
};
