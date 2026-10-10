// Generic OpenAPI test page: one expandable card per operation, built from the live contract.
// Summaries and field names stay as authored in the spec (English). Chrome uses shared i18n.
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const list = $('api-docs-list');
const nav = $('api-docs-nav');
const emptyNote = $('api-docs-empty');
const errorNote = $('api-docs-error');
const tokenInput = $('api-docs-token');
const searchInput = $('api-docs-search');
const CAP = 65536;
const TIMEOUT_MS = 30000;
let token = '';
const live = new Map();
const cards = [];

// Hex requestId from crypto.getRandomValues (works outside secure contexts).
let idCounter = 0;
const requestId = () => {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    idCounter += 1;
    return `noreadablecrypto-${Date.now().toString(36)}-${idCounter}`;
  }
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const deref = (schema, comps, hops = 0) => {
  let s = schema;
  while (s && typeof s === 'object' && typeof s.$ref === 'string' && hops < 5) {
    const m = /^#\/components\/schemas\/([\w-]+)$/.exec(s.$ref);
    if (!m || !comps[m[1]]) break;
    s = comps[m[1]];
    hops += 1;
  }
  return s && typeof s === 'object' ? s : {};
};
// Bounded local $ref expansion for the raw-JSON schema views.
const expand = (schema, comps, hops = 0, seen = null) => {
  const active = seen || new Set();
  if (!schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string') {
    const m = /^#\/components\/schemas\/([\w-]+)$/.exec(schema.$ref);
    if (!m || !comps[m[1]] || hops >= 5 || active.has(m[1])) return { $ref: schema.$ref };
    active.add(m[1]);
    return expand(comps[m[1]], comps, hops + 1, active);
  }
  if (Array.isArray(schema)) return schema.map((v) => expand(v, comps, hops, new Set(active)));
  const out = {};
  for (const key of Object.keys(schema)) out[key] = expand(schema[key], comps, hops, new Set(active));
  return out;
};
// Safe initial template: required fields only, blank strings, fresh requestId, enum constants.
function template(schema, comps, variant = 0, depth = 0) {
  const s = deref(schema, comps);
  if (!s || typeof s !== 'object' || depth > 4) return '';
  if (Array.isArray(s.oneOf) && s.oneOf.length)
    return template(s.oneOf[Math.min(variant, s.oneOf.length - 1)], comps, 0, depth + 1);
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  switch (s.type) {
    case 'object': {
      const out = {};
      for (const key of s.required || [])
        out[key] =
          key === 'requestId'
            ? requestId()
            : template((s.properties || {})[key] || { type: 'string' }, comps, 0, depth + 1);
      return out;
    }
    case 'array':
      return [];
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return '';
  }
}
const variantLabel = (schema, comps, index) => {
  const v = deref(schema, comps);
  const action = v && v.properties && v.properties.action;
  const first = action && Array.isArray(action.enum) ? action.enum[0] : null;
  return typeof first === 'string' ? first : `oneOf[${index}]`;
};
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function curlFor(method, url, headers, bodyText) {
  const parts = [
    'curl',
    ...(method === 'HEAD' ? ['--head'] : ['-X', method]),
    quote(url),
    '-H',
    '"Authorization: Bearer $STUDIO_TOKEN"',
  ];
  for (const [name, value] of Object.entries(headers)) parts.push('-H', quote(`${name}: ${value}`));
  if (bodyText !== null) parts.push('-d', quote(bodyText));
  return parts.join(' ');
}

function buildCard(op, method, path, comps) {
  const id = op.operationId;
  const details = el('details', 'op');
  details.dataset.operationId = id;
  details.id = `op-${id}`;
  const summary = el('summary');
  summary.append(
    el('span', `badge m-${method.toLowerCase()}`, method),
    el('code', '', path),
    el('span', 'sum', op.summary || ''),
  );
  details.append(summary);
  const body = el('div', 'op-body');
  details.append(body);
  if (Array.isArray(op['x-required-scopes']) && op['x-required-scopes'].length) {
    const scopes = el('p', 'scopes');
    const label = el('span', '', '');
    label.setAttribute('data-i18n', 'api_docs.scopes');
    label.textContent = 'Scopes';
    scopes.append(label, ': ');
    op['x-required-scopes'].forEach((scope, i) => {
      if (i) scopes.append(', ');
      scopes.append(el('code', '', scope));
    });
    body.append(scopes);
  }
  if (op.description) body.append(el('p', 'note', op.description));
  const paramsHead = el('h3', '', 'Parameters');
  paramsHead.setAttribute('data-i18n', 'api_docs.params');
  body.append(paramsHead);
  const fields = el('div', 'fields');
  for (const param of op.parameters || []) {
    const row = el('div', 'field');
    const label = el('label', '', `${param.name} `);
    label.htmlFor = `p-${id}-${param.in}-${param.name}`;
    label.append(el('span', 'in', `(${param.in})`));
    if (param.required) label.append(el('span', 'req', ' *'));
    const input = document.createElement('input');
    input.id = `p-${id}-${param.in}-${param.name}`;
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.paramIn = param.in;
    input.dataset.paramName = param.name;
    if (param.required) input.required = true;
    if (param.description) input.title = param.description;
    if (id === 'download' && param.in === 'header' && param.name === 'Range') input.value = 'bytes=0-1023';
    row.append(label, input);
    fields.append(row);
  }
  if (!(op.parameters || []).length) fields.append(el('p', 'note', '—'));
  body.append(fields);

  const requestSchema =
    op.requestBody &&
    op.requestBody.content &&
    op.requestBody.content['application/json'] &&
    op.requestBody.content['application/json'].schema;
  let variantSelect = null;
  let resolvedBody = requestSchema ? deref(requestSchema, comps) : null;
  if (requestSchema) {
    const h = el('h3', '', 'JSON body');
    h.setAttribute('data-i18n', 'api_docs.body');
    h.id = `body-label-${id}`;
    body.append(h);
    if (resolvedBody && Array.isArray(resolvedBody.oneOf) && resolvedBody.oneOf.length) {
      const vlabel = el('label', 'field');
      const span = el('span', '', 'Variant');
      span.setAttribute('data-i18n', 'api_docs.variant');
      variantSelect = document.createElement('select');
      variantSelect.dataset.bodyVariant = '';
      resolvedBody.oneOf.forEach((v, i) =>
        variantSelect.append(new Option(variantLabel(v, comps, i), String(i))),
      );
      vlabel.append(span, variantSelect);
      body.append(vlabel);
    }
    const area = document.createElement('textarea');
    area.dataset.requestBody = '';
    area.setAttribute('aria-labelledby', h.id);
    area.spellcheck = false;
    area.rows = 8;
    area.value = JSON.stringify(template(requestSchema, comps, 0), null, 2);
    body.append(area);
    if (variantSelect)
      variantSelect.addEventListener('change', () => {
        area.value = JSON.stringify(
          template(requestSchema, comps, Number(variantSelect.value) || 0),
          null,
          2,
        );
        const confirm = body.querySelector('[data-confirm]');
        if (confirm) confirm.checked = false;
        refreshCurl();
      });
    const reqBox = el('details', 'schema');
    reqBox.append(el('summary', '', 'Request schema'));
    reqBox.firstChild.setAttribute('data-i18n', 'api_docs.schema_req');
    reqBox.append(el('pre', '', JSON.stringify(expand(requestSchema, comps), null, 2)));
    body.append(reqBox);
  }
  const resBox = el('details', 'schema');
  resBox.append(el('summary', '', 'Response schema'));
  resBox.firstChild.setAttribute('data-i18n', 'api_docs.schema_res');
  resBox.append(el('pre', '', JSON.stringify(expand(op.responses || {}, comps), null, 2)));
  body.append(resBox);

  if (method === 'POST') {
    const confirm = el('label', 'confirm');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.confirm = '';
    const span = el('span', '', 'I confirm: run this real action.');
    span.setAttribute('data-i18n', 'api_docs.confirm');
    confirm.append(box, span);
    body.append(confirm);
    const note = el('p', 'note', 'POST actions are real.');
    note.setAttribute('data-i18n', 'api_docs.confirm_note');
    body.append(note);
  }
  const actions = el('div', 'actions');
  const run = el('button', 'execute', 'Execute');
  run.type = 'button';
  run.dataset.execute = '';
  run.setAttribute('data-i18n', 'api_docs.execute');
  const cancel = el('button', '', 'Stop reception');
  cancel.type = 'button';
  cancel.disabled = true;
  cancel.dataset.cancel = '';
  cancel.setAttribute('data-i18n', 'api_docs.cancel');
  const copy = el('button', '', 'Copy');
  copy.type = 'button';
  copy.setAttribute('data-i18n', 'api_docs.copy');
  const copyNote = el('span', 'copy-note', '');
  copyNote.dataset.copyNote = '';
  actions.append(run, cancel, copy, copyNote);
  body.append(actions);
  const curlHead = el('h4', '', 'Curl preview');
  curlHead.setAttribute('data-i18n', 'api_docs.curl');
  body.append(curlHead);
  const curlPre = el('pre', '', '');
  curlPre.dataset.curl = '';
  body.append(curlPre);
  const status = el('output', '', t('api_docs.idle'));
  status.dataset.status = '';
  status.setAttribute('aria-live', 'polite');
  body.append(status);
  const hHead = el('h4', '', 'Headers');
  hHead.setAttribute('data-i18n', 'api_docs.headers');
  body.append(hHead);
  const headersPre = el('pre', '', '');
  headersPre.dataset.responseHeaders = '';
  body.append(headersPre);
  const hRes = el('h4', '', 'Response');
  hRes.setAttribute('data-i18n', 'api_docs.response');
  body.append(hRes);
  const resPre = el('pre', '', '');
  resPre.dataset.response = '';
  body.append(resPre);

  const collect = () => {
    let resolvedPath = path;
    const query = [];
    const headers = {};
    for (const param of op.parameters || []) {
      const input = body.querySelector(
        `input[data-param-in="${param.in}"][data-param-name="${CSS.escape(param.name)}"]`,
      );
      const value = input ? input.value.trim() : '';
      if (param.in === 'path') {
        if (!value) return { error: t('api_docs.need_param', { name: param.name }) };
        resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(value));
      } else if (param.in === 'query') {
        if (value) query.push([param.name, value]);
      } else if (param.in === 'header') {
        if (value) headers[param.name] = value;
      }
    }
    let bodyText = null;
    const area = body.querySelector('textarea[data-request-body]');
    if (area) {
      try {
        JSON.parse(area.value || 'null');
      } catch {
        return { error: t('api_docs.bad_json') };
      }
      bodyText = area.value;
    }
    if (!resolvedPath.startsWith('/api/v1/')) return { error: t('api_docs.spec_error') };
    const url =
      location.origin +
      resolvedPath +
      (query.length
        ? `?${query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
        : '');
    if (!new URL(url).pathname.startsWith('/api/v1/')) return { error: t('api_docs.spec_error') };
    return { url, headers, bodyText };
  };
  function refreshCurl() {
    const c = collect();
    curlPre.textContent = c.error
      ? c.error
      : curlFor(
          method,
          c.url,
          {
            Accept: '*/*',
            ...c.headers,
            ...(c.bodyText !== null ? { 'Content-Type': 'application/json' } : {}),
          },
          c.bodyText,
        );
  }
  body.addEventListener('input', (event) => {
    const confirm = body.querySelector('[data-confirm]');
    if (confirm && event.target !== confirm) confirm.checked = false;
    refreshCurl();
  });
  refreshCurl();

  run.addEventListener('click', async () => {
    if (live.has(id)) return;
    if (!token) {
      status.textContent = t('api_docs.need_token');
      return;
    }
    const confirmBox = body.querySelector('[data-confirm]');
    if (method === 'POST' && !(confirmBox && confirmBox.checked)) {
      status.textContent = t('api_docs.need_confirm');
      return;
    }
    const c = collect();
    if (c.error) {
      status.textContent = c.error;
      return;
    }
    refreshCurl();
    const started = performance.now();
    const controller = new AbortController();
    live.set(id, controller);
    run.disabled = true;
    cancel.disabled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    status.textContent = '…';
    resPre.textContent = '';
    headersPre.textContent = '';
    try {
      const res = await fetch(c.url, {
        method,
        headers: {
          Accept: '*/*',
          ...c.headers,
          Authorization: `Bearer ${token}`,
          ...(c.bodyText !== null ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'HEAD' ? undefined : c.bodyText,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      status.textContent = `${res.status} · ${t('api_docs.receiving')}`;
      let headerText = '';
      res.headers.forEach((v, k) => {
        headerText += `${k}: ${v}\n`;
      });
      headersPre.textContent = headerText.trim();
      let suffix = '';
      if (method !== 'HEAD' && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let truncated = false;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = value.subarray(0, CAP - bytes);
            bytes += chunk.length;
            resPre.textContent += decoder.decode(chunk, { stream: true });
            if (bytes >= CAP) {
              truncated = true;
              await reader.cancel();
              break;
            }
          }
          resPre.textContent += decoder.decode();
        } catch (readError) {
          if (readError && readError.name === 'AbortError' && timedOut)
            suffix = ` · ${t('api_docs.timeout')}`;
          else if (readError && readError.name === 'AbortError') suffix = ` · ${t('api_docs.aborted')}`;
          else throw readError;
        }
        if (truncated) suffix += ` · ${t('api_docs.truncated')}`;
      }
      status.textContent = `${res.status} · ${Math.round(performance.now() - started)} ms${suffix}`;
    } catch (requestError) {
      const ms = Math.round(performance.now() - started);
      if (requestError && requestError.name === 'AbortError' && timedOut)
        status.textContent = `${t('api_docs.timeout')} · ${ms} ms`;
      else if (requestError && requestError.name === 'AbortError')
        status.textContent = `${t('api_docs.aborted')} · ${ms} ms`;
      else
        status.textContent = `${requestError && requestError.message ? requestError.message : requestError} · ${ms} ms`;
    } finally {
      clearTimeout(timer);
      live.delete(id);
      run.disabled = false;
      cancel.disabled = true;
      if (confirmBox) confirmBox.checked = false;
    }
  });
  cancel.addEventListener('click', () => live.get(id)?.abort());
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard) throw new Error('unavailable');
      await navigator.clipboard.writeText(curlPre.textContent);
      copyNote.textContent = t('api_docs.copied');
    } catch {
      copyNote.textContent = t('api_docs.copy_unavailable');
    }
  });
  return details;
}

tokenInput.addEventListener('input', () => {
  token = tokenInput.value;
});
const clearToken = () => {
  token = '';
  tokenInput.value = '';
  for (const controller of live.values()) {
    try {
      controller.abort();
    } catch {}
  }
  live.clear();
};
$('api-docs-clear-token').addEventListener('click', clearToken);
addEventListener('pagehide', clearToken);

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  let visible = 0;
  for (const { details, link, haystack } of cards) {
    const hit = !q || haystack.includes(q);
    details.hidden = !hit;
    link.parentElement.hidden = !hit;
    if (hit) visible += 1;
  }
  emptyNote.hidden = visible !== 0;
});

let spec = null;
try {
  const res = await fetch('/openapi-v1.json', { credentials: 'same-origin', redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  spec = await res.json();
} catch {
  errorNote.hidden = false;
}
if (spec) {
  const comps = (spec.components && spec.components.schemas) || {};
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const [rawMethod, op] of Object.entries(item || {})) {
      if (!op || !op.operationId) continue;
      const method = rawMethod.toUpperCase();
      const details = buildCard(op, method, path, comps);
      list.append(details);
      const li = el('li');
      const link = el('a', '', op.operationId);
      link.dataset.operationLink = op.operationId;
      link.href = `#op-${op.operationId}`;
      link.addEventListener('click', () => {
        details.open = true;
      });
      li.append(link);
      nav.append(li);
      cards.push({
        details,
        link,
        haystack: `${op.operationId} ${method} ${path} ${op.summary || ''}`.toLowerCase(),
      });
    }
  }
  if (!cards.length) emptyNote.hidden = false;
}
