const PLACES_API = 'https://iran-places-api.onrender.com/api';
const POSTAL_LOOKUP_URL = process.env.POSTAL_LOOKUP_URL || 'https://postaldatapi.com/api/lookup';

function digits(value = '') {
  return String(value).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function normalize(value = '') {
  return digits(String(value).trim()).replace(/\u200c/g, '');
}

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(payload));
}

function method(req, allowed) {
  return allowed.includes(req.method);
}

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 2_000_000) reject(new Error('payload-too-large')); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid-json')); }
    });
    req.on('error', reject);
  });
}

async function kvCommand(command, ...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV_NOT_CONFIGURED');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([command, ...args])
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) throw new Error(data?.error || `KV_${response.status}`);
  return data?.result;
}

async function kvPipeline(commands) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV_NOT_CONFIGURED');
  const response = await fetch(`${url.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`KV_${response.status}`);
  return data;
}

function validNationalId(value) {
  const v = normalize(value);
  if (!/^\d{10}$/.test(v) || /^([0-9])\1{9}$/.test(v)) return false;
  const check = Number(v[9]);
  const sum = v.slice(0, 9).split('').reduce((a, n, i) => a + Number(n) * (10 - i), 0);
  const r = sum % 11;
  return check === (r < 2 ? r : 11 - r);
}

function validIranCard(value) {
  const v = normalize(value).replace(/[- ]/g, '');
  if (!/^\d{16}$/.test(v) || /^([0-9])\1{15}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    let n = Number(v[i]) * (i % 2 === 0 ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

function validIban(value) {
  let v = normalize(value).toUpperCase().replace(/\s+/g, '');
  if (!/^IR\d{24}$/.test(v)) return false;
  const rearranged = v.slice(4) + String(v.charCodeAt(0) - 55) + String(v.charCodeAt(1) - 55) + v.slice(2, 4);
  let rem = 0;
  for (const ch of rearranged) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

function validMobile(value) {
  const v = normalize(value).replace(/[ -]/g, '');
  return /^09\d{9}$/.test(v);
}

function validLandline(value) {
  const v = normalize(value).replace(/[ -]/g, '');
  return /^0\d{10}$/.test(v);
}

function validPostal(value) {
  const v = normalize(value).replace(/[ -]/g, '');
  return /^\d{10}$/.test(v) && !/^([0-9])\1{9}$/.test(v);
}

function validIranDate(value) {
  return /^13\d{2}\/\d{1,2}\/\d{1,2}$/.test(normalize(value)) || /^14\d{2}\/\d{1,2}\/\d{1,2}$/.test(normalize(value));
}

function requiredText(value, min = 2, max = 500) {
  const v = String(value ?? '').trim();
  return v.length >= min && v.length <= max;
}

function validationError(field, message) { return { field, message }; }

async function validatePlacePair(provinceId, cityId) {
  const p = normalize(provinceId);
  const c = normalize(cityId);
  if (!p || !c) return { ok: false, reason: 'استان و شهر الزامی است.' };
  const response = await fetch(`${PLACES_API}/provinces/id/${encodeURIComponent(p)}/cities`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`PLACES_${response.status}`);
  const cities = await response.json();
  const list = Array.isArray(cities) ? cities : (cities?.cities || cities?.data || []);
  const found = list.some(item => String(item?.id ?? item?.cityId) === c);
  return found ? { ok: true } : { ok: false, reason: 'شهر انتخاب‌شده با استان انتخابی تطابق ندارد.' };
}

async function optionalPostalLookup(postalCode, provinceName, cityName) {
  const key = process.env.POSTALDATA_API_KEY;
  if (!key) return { configured: false, verified: false };
  try {
    const response = await fetch(POSTAL_LOOKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ zipcode: normalize(postalCode), country: 'IR', apiKey: key })
    });
    if (!response.ok) return { configured: true, verified: false, reason: `HTTP_${response.status}` };
    const data = await response.json();
    const text = JSON.stringify(data).toLowerCase();
    const matchesLocation = !provinceName || text.includes(String(provinceName).toLowerCase()) || !cityName || text.includes(String(cityName).toLowerCase());
    return { configured: true, verified: Boolean(data && matchesLocation), provider: 'PostalDataPI', data: data && typeof data === 'object' ? { placeName: data.place_name || data.placeName || null, latitude: data.latitude || null, longitude: data.longitude || null } : null };
  } catch (error) {
    return { configured: true, verified: false, reason: error.message };
  }
}

async function optionalNationalIdLookup(nationalId) {
  const url = process.env.NATIONAL_ID_API_URL;
  const key = process.env.NATIONAL_ID_API_KEY;
  if (!url || !key) return { configured: false, verified: false };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}`, 'X-API-Key': key },
      body: JSON.stringify({ nationalId: normalize(nationalId), countryId: 'IR', apiKey: key })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { configured: true, verified: false, reason: `HTTP_${response.status}` };
    const verified = Boolean(data?.valid ?? data?.isValid ?? data?.success);
    return { configured: true, verified, provider: 'configured-national-id-api' };
  } catch (error) {
    return { configured: true, verified: false, reason: error.message };
  }
}

async function validateSubmission(payload) {
  const p = { ...payload };
  const errors = [];
  const req = (field, label, min = 2, max = 500) => { if (!requiredText(p[field], min, max)) errors.push(validationError(field, `${label} الزامی است.`)); };

  req('storeName', 'نام فروشگاه');
  req('profession', 'صنف');
  req('accountNumber', 'شماره حساب', 4, 30);
  req('cardNumber', 'شماره کارت', 16, 19);
  req('iban', 'شماره شبا', 26, 30);
  req('bankName', 'نام بانک');
  req('fullName', 'نام و نام خانوادگی/مدیرعامل');
  req('nationalId', 'کد ملی/شناسه ملی', 10, 14);
  req('identityNumber', 'شماره شناسنامه', 1, 30);
  req('fatherName', 'نام پدر');
  req('birthDate', 'تاریخ تولد', 8, 10);
  req('landline', 'تلفن');
  req('mobile', 'تلفن همراه');
  req('email', 'پست الکترونیک', 5, 150);
  req('provinceId', 'استان');
  req('cityId', 'شهر');
  req('address', 'آدرس محل کسب', 10, 800);
  req('postalCode', 'کد پستی', 10, 10);
  req('taxCode', 'کد مالیاتی', 10, 20);
  req('residenceAddress', 'نشانی محل سکونت', 10, 800);
  req('residencePostal', 'کد پستی محل سکونت', 10, 10);
  req('ownership', 'نوع مالکیت');
  req('communication', 'بستر ارتباطی');
  req('storeCashbox', 'صندوق فروشگاهی');
  req('scale', 'ترازو');
  req('otherPSP', 'کارتخوان سایر PSPها');
  req('description', 'توضیحات', 3, 1200);
  req('activityProof', 'مدرک فعالیت');
  if (p.activityProof === 'affidavit') {
    req('witness1Name', 'نام شاهد اول');
    req('witness1Mobile', 'موبایل شاهد اول');
    req('witness1Address', 'نشانی شاهد اول', 10, 500);
    req('witness2Name', 'نام شاهد دوم');
    req('witness2Mobile', 'موبایل شاهد دوم');
    req('witness2Address', 'نشانی شاهد دوم', 10, 500);
  }
  if (p.ownership === 'rented') {
    req('leaseFrom', 'تاریخ شروع اجاره', 8, 10);
    req('leaseTo', 'تاریخ پایان اجاره', 8, 10);
  }
  if (!p.licenseStatus || !['yes', 'no'].includes(p.licenseStatus)) errors.push(validationError('licenseStatus', 'وضعیت جواز کسب مشخص نشده است.'));
  if (p.consent !== true) errors.push(validationError('consent', 'تأیید صحت اطلاعات الزامی است.'));

  if (p.cardNumber && !validIranCard(p.cardNumber)) errors.push(validationError('cardNumber', 'شماره کارت معتبر نیست.'));
  if (p.iban && !validIban(p.iban)) errors.push(validationError('iban', 'شماره شبا باید با ساختار معتبر IR و رقم کنترلی صحیح ثبت شود.'));
  if (p.nationalId && !validNationalId(p.nationalId)) errors.push(validationError('nationalId', 'کد ملی از نظر رقم کنترلی معتبر نیست.'));
  if (p.mobile && !validMobile(p.mobile)) errors.push(validationError('mobile', 'شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود.'));
  if (p.landline && !validLandline(p.landline)) errors.push(validationError('landline', 'تلفن ثابت باید ۱۱ رقم باشد.'));
  if (p.postalCode && !validPostal(p.postalCode)) errors.push(validationError('postalCode', 'کد پستی باید دقیقاً ۱۰ رقم باشد.'));
  if (p.residencePostal && !validPostal(p.residencePostal)) errors.push(validationError('residencePostal', 'کد پستی محل سکونت باید دقیقاً ۱۰ رقم باشد.'));
  if (p.birthDate && !validIranDate(p.birthDate)) errors.push(validationError('birthDate', 'تاریخ تولد را به قالب ۱۴۰۵/۰۱/۰۱ وارد کنید.'));
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(p.email).trim())) errors.push(validationError('email', 'پست الکترونیک معتبر نیست.'));
  if (p.witness1Mobile && !validMobile(p.witness1Mobile)) errors.push(validationError('witness1Mobile', 'موبایل شاهد اول معتبر نیست.'));
  if (p.witness2Mobile && !validMobile(p.witness2Mobile)) errors.push(validationError('witness2Mobile', 'موبایل شاهد دوم معتبر نیست.'));

  if (errors.length) return { ok: false, errors };

  const placeCheck = await validatePlacePair(p.provinceId, p.cityId);
  if (!placeCheck.ok) errors.push(validationError('cityId', placeCheck.reason));

  const nationalCheck = await optionalNationalIdLookup(p.nationalId);
  if (nationalCheck.configured && !nationalCheck.verified) errors.push(validationError('nationalId', 'کد ملی توسط سرویس اعتبارسنجی بیرونی تأیید نشد.'));

  if (errors.length) return { ok: false, errors, external: { nationalId: nationalCheck } };
  const postalCheck = await optionalPostalLookup(p.postalCode, p.provinceName, p.cityName);

  return { ok: true, normalized: {
    ...p,
    storeName: String(p.storeName).trim(), profession: String(p.profession).trim(), fullName: String(p.fullName).trim(),
    nationalId: normalize(p.nationalId), mobile: normalize(p.mobile), landline: normalize(p.landline),
    postalCode: normalize(p.postalCode), residencePostal: normalize(p.residencePostal),
    cardNumber: normalize(p.cardNumber).replace(/[- ]/g, ''), iban: normalize(p.iban).toUpperCase().replace(/\s/g, '')
  }, external: { nationalId: nationalCheck, postal: postalCheck, places: 'verified' } };
}

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim().slice(0, 64);
}

module.exports = { digits, normalize, json, method, body, kvCommand, kvPipeline, validateSubmission, getClientIp, validNationalId, validIranCard, validIban, validMobile, validLandline, validPostal, validIranDate, PLACES_API };
