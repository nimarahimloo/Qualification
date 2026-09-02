const { json, method, body, kvCommand, validateSubmission, getClientIp } = require('./_lib');

module.exports = async (req, res) => {
  if (!method(req, ['POST'])) return json(res, 405, { ok: false, message: 'Method not allowed' });
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return json(res, 503, { ok: false, code: 'STORAGE_NOT_CONFIGURED', message: 'ذخیره‌سازی سامانه هنوز روی Vercel متصل نشده است.' });
  }
  try {
    const payload = await body(req);
    if (payload.website) return json(res, 400, { ok: false, message: 'درخواست رد شد.' });
    const rateKey = `qual:rate:${getClientIp(req)}`;
    const hits = await kvCommand('INCR', rateKey);
    if (Number(hits) === 1) await kvCommand('EXPIRE', rateKey, 60);
    if (Number(hits) > 12) return json(res, 429, { ok: false, message: 'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.' });

    const result = await validateSubmission(payload);
    if (!result.ok) return json(res, 422, { ok: false, message: 'اطلاعات فرم کامل یا معتبر نیست.', errors: result.errors, external: result.external || null });

    const id = `Q-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const record = {
      id,
      createdAt: new Date().toISOString(),
      status: 'new',
      source: 'website',
      clientIpHash: getClientIp(req),
      verification: result.external,
      data: result.normalized
    };
    await kvCommand('HSET', `qual:submission:${id}`, 'record', JSON.stringify(record));
    await kvCommand('ZADD', 'qual:submissions:index', Date.now(), id);
    return json(res, 201, { ok: true, id, message: 'درخواست با موفقیت ثبت شد. کارشناسان بررسی را آغاز می‌کنند.', verification: result.external });
  } catch (error) {
    console.error('submit_error', error);
    if (error.message === 'payload-too-large') return json(res, 413, { ok: false, message: 'حجم اطلاعات ارسالی زیاد است.' });
    if (error.message === 'invalid-json') return json(res, 400, { ok: false, message: 'داده ارسالی معتبر نیست.' });
    if (error.message?.startsWith('PLACES_')) return json(res, 503, { ok: false, message: 'سرویس استعلام موقعیت جغرافیایی موقتاً در دسترس نیست؛ چند دقیقه بعد دوباره تلاش کنید.' });
    return json(res, 500, { ok: false, message: 'خطای داخلی سامانه. لطفاً دوباره تلاش کنید.' });
  }
};
