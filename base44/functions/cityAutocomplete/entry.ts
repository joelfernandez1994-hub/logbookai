import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const STATE_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY'
};

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const { query } = await req.json();
    const q = String(query || '').trim();
    if (q.length < 3) return Response.json({ suggestions: [] });
    if (q.length > 80) return Response.json({ error: 'Query is too long' }, { status: 400 });

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=en&format=json&countryCode=US`;
    const response = await fetch(url, { headers: { 'User-Agent': 'LogbookAI/1.0 (driver log app)' } });
    if (!response.ok) return Response.json({ error: 'City lookup unavailable' }, { status: 502 });
    const data = await response.json();
    const seen = new Set();
    const suggestions = [];
    for (const result of data.results || []) {
      const city = String(result.name || '').trim();
      const state = STATE_ABBR[String(result.admin1 || '').toLowerCase()] || '';
      const key = `${city.toLowerCase()}|${state}`;
      if (!String(result.feature_code || '').startsWith('PPL') || !city.toLowerCase().startsWith(q.toLowerCase()) || !state || seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ city, state });
      if (suggestions.length === 5) break;
    }
    return Response.json({ suggestions });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}