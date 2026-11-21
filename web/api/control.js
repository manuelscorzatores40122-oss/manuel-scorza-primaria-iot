import { createService, HttpError } from '../lib/service.js';
const service = createService();
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const action = req.query.action;
    const requestedDevice = req.query.device;
    const method = ['estado', 'administracion'].includes(action) ? 'GET' : 'POST';
    if (!['estado', 'login', 'logout', 'programar', 'encender', 'apagar', 'sync', 'cambiar-clave', 'administracion', 'cuenta', 'crear-nivel', 'crear-colegio', 'estado-cuenta', 'renovar-token'].includes(action)) throw new HttpError(404, 'No encontrado');
    if (req.method !== method) { res.setHeader('Allow', method); throw new HttpError(405, 'Método no permitido'); }
    // Cabecera propia + ausencia de CORS impiden formularios enviados desde otro sitio.
    if (method === 'POST' && action !== 'sync' && req.headers['x-timbre-request'] !== '1') throw new HttpError(403, 'Solicitud no permitida');
    const body = typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : (req.body || {});
    if (action === 'sync') {
      const payload = await service.sync(body, req.headers.authorization);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(payload);
    }
    if (action === 'login') {
      const token = await service.login(body, req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown');
      res.setHeader('Set-Cookie', `timbre_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
      return res.status(200).json({ ok: true });
    }
    const token = await service.session(req.headers.cookie);
    const user = await service.sessionUser(token);
    if (action === 'administracion') return res.status(200).json(await service.adminData(user));
    if (action === 'cuenta') return res.status(200).json(await service.createAccount(body, user));
    if (action === 'crear-colegio') return res.status(200).json(await service.createSchool(body, user));
    if (action === 'estado-cuenta') return res.status(200).json(await service.setAccountActive(body.id, body.active, user));
    if (action === 'crear-nivel') return res.status(200).json(await service.createLevel(body, user));
    if (action === 'renovar-token') return res.status(200).json(await service.rotateDeviceToken(body.dispositivo, user));
    if (action === 'cambiar-clave') {
      const result = await service.changePassword(body, token);
      res.setHeader('Set-Cookie', 'timbre_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
      return res.status(200).json(result);
    }
    if (action === 'logout') {
      await service.logout(token);
      res.setHeader('Set-Cookie', 'timbre_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
      return res.status(200).json({ ok: true });
    }
    const disponibles = await service.devicesFor(user);
    const device = requestedDevice || disponibles[0]?.id;
    if (!device || !disponibles.some(item => item.id === device)) throw new HttpError(403, 'Tu cuenta no tiene acceso a ese nivel.');
    const result = action === 'estado' ? await service.state(device) : action === 'programar' ? await service.program(body, device, user.username) : await service.command(action === 'encender' ? 1 : 2, body, device, user.username);
    return res.status(200).json({ ...result, user, dispositivos: disponibles });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 503;
    return res.status(status).send(error instanceof HttpError ? error.message : 'Servicio temporalmente no disponible');
  }
}
