const { json, method, body, kvCommand, kvPipeline } = require('./_lib');

function authorized(req) {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) return false;
  const header = String(req.headers.authorization || '');
  return header === `Bearer ${configured}`;
}

async function listRecords(limit = 100) {
  const ids = await kvCommand('ZRANGE', 'qual:submissions:index', 0, Math.max(0, limit - 1), 'REV');
  if (!ids?.length) return [];
  const commands = ids.map(id => ['HGET', `qual:submission:${id}`, 'record']);
  const results = await kvPipeline(commands);
  return results.map((item, index) => {
    try { return JSON.parse(item?.result || item?.value || 'null'); } catch { return null; }
  }).filter(Boolean);
}

module.exports = async (req, res) => {
  if (!authorized(req)) return json(res, 401, { ok: false, message: 'دسترسی غیرمجاز است.' });
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return json(res, 503, { ok: false, message: 'KV storage is not configured.' });
  try {
    if (method(req, ['GET'])) {
      const limit = Math.min(250, Math.max(1, Number(req.query?.limit || 100)));
      const records = await listRecords(limit);
      return json(res, 200, { ok: true, records, count: records.length });
    }
    if (method(req, ['PATCH', 'DELETE'])) {
      const payload = await body(req);
      const id = String(payload.id || req.query?.id || '').trim();
      if (!id) return json(res, 400, { ok: false, message: 'شناسه درخواست الزامی است.' });
      if (req.method === 'DELETE') {
        await kvCommand('DEL', `qual:submission:${id}`);
        await kvCommand('ZREM', 'qual:submissions:index', id);
        return json(res, 200, { ok: true });
      }
      const allowed = ['new', 'reviewing', 'approved', 'rejected', 'archived'];
      if (!allowed.includes(payload.status)) return json(res, 422, { ok: false, message: 'وضعیت نامعتبر است.' });
      const raw = await kvCommand('HGET', `qual:submission:${id}`, 'record');
      if (!raw) return json(res, 404, { ok: false, message: 'درخواست پیدا نشد.' });
      const record = JSON.parse(raw);
      record.status = payload.status;
      record.updatedAt = new Date().toISOString();
      if (payload.note !== undefined) record.adminNote = String(payload.note).slice(0, 2000);
      await kvCommand('HSET', `qual:submission:${id}`, 'record', JSON.stringify(record));
      return json(res, 200, { ok: true, record });
    }
    return json(res, 405, { ok: false, message: 'Method not allowed' });
  } catch (error) {
    console.error('admin_api_error', error);
    return json(res, 500, { ok: false, message: 'خطای داخلی پنل.' });
  }
};
