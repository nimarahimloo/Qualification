const { json } = require('./_lib');
const BASE = 'https://iran-places-api.onrender.com/api';

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed' });
  try {
    const type = String(req.query?.type || 'provinces');
    let url;
    if (type === 'provinces') url = `${BASE}/provinces`;
    else if (type === 'cities' && req.query?.provinceId) url = `${BASE}/provinces/id/${encodeURIComponent(req.query.provinceId)}/cities`;
    else if (type === 'city' && req.query?.cityId) url = `${BASE}/cities/id/${encodeURIComponent(req.query.cityId)}`;
    else return json(res, 400, { ok: false, message: 'پارامتر موقعیت جغرافیایی نامعتبر است.' });
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => null);
    if (!response.ok) return json(res, 502, { ok: false, message: 'سرویس موقعیت جغرافیایی پاسخ نداد.' });
    res.setHeader('Cache-Control', type === 'provinces' ? 'public, s-maxage=86400, stale-while-revalidate=604800' : 'public, s-maxage=43200, stale-while-revalidate=172800');
    return json(res, 200, { ok: true, source: 'Iran Places API', data });
  } catch (error) {
    console.error('places_error', error);
    return json(res, 502, { ok: false, message: 'خطا در دریافت استان/شهر.' });
  }
};
