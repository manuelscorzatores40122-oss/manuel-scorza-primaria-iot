import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/control.js';
async function request(method, action, headers = {}) {
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, send(value) { this.body = value; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method, query: { action }, headers }, response);
  return response;
}
test('rutas, método, protección CSRF y autenticación antes de leer el almacenamiento', async () => {
  assert.equal((await request('GET', 'missing')).code, 404);
  const wrongMethod = await request('GET', 'encender');
  assert.equal(wrongMethod.code, 405); assert.equal(wrongMethod.headers.Allow, 'POST');
  assert.equal((await request('POST', 'encender')).code, 403);
  assert.equal((await request('POST', 'encender', { 'x-timbre-request': '1' })).code, 401);
  assert.equal((await request('GET', 'estado')).code, 401);
});

test('cambiar clave exige POST y protección CSRF', async () => {
 for (const action of ['cambiar-clave']) {
  assert.equal((await request('GET', action)).code, 405);
  assert.equal((await request('POST', action)).code, 403);
 }
 assert.equal((await request('POST', 'cambiar-clave', { 'x-timbre-request': '1' })).code, 401);
});

test('recuperación automática no está disponible', async () => {
 for (const action of ['recuperar-clave', 'restablecer-clave']) {
  assert.equal((await request('GET', action)).code, 404);
  assert.equal((await request('POST', action, { 'x-timbre-request': '1' })).code, 404);
 }
});
