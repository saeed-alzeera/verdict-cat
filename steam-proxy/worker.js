const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Max-Age': '86400',
};

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const steamUrl = 'https://store.steampowered.com' + url.pathname + url.search;

    let upstream;
    try {
      upstream = await fetch(steamUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
      });
    } catch (e) {
      return jsonError(502, 'Failed to reach Steam: ' + e.message);
    }

    if (!upstream.ok) {
      return jsonError(upstream.status, 'Steam returned HTTP ' + upstream.status);
    }

    const contentType = upstream.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json') && !contentType.includes('text/javascript')) {
      // Steam redirected to an HTML page (e.g. private profile → login page)
      return jsonError(403, 'Steam returned a non-JSON response — profile may be private or Steam ID incorrect.');
    }

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    });
  },
};
