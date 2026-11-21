import { createHash, randomBytes, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
const deriveKey = promisify(scrypt);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
const same = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const id = () => randomBytes(16).toString('hex');
const key = name => `timbre:v1:${name}`;
const DEVICE_IDS = ['primaria', 'secundaria'];
function devicesFrom(env) {
  let configured = {};
  if (env.DEVICE_TOKENS) {
    try { configured = JSON.parse(env.DEVICE_TOKENS); } catch { throw new HttpError(503, 'DEVICE_TOKENS debe ser un objeto JSON válido'); }
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new HttpError(503, 'DEVICE_TOKENS debe ser un objeto JSON');
  }
  const devices = Object.fromEntries(DEVICE_IDS.map(device => [device, configured[device] || (device === 'primaria' ? env.DEVICE_TOKEN : '')]));
  const assigned = DEVICE_IDS.map(device => devices[device]).filter(Boolean);
  if (new Set(assigned).size !== assigned.length) throw new HttpError(503, 'Cada placa debe tener un DEVICE_TOKEN distinto');
  return devices;
}
const deviceKey = (device, name) => device === 'primaria' ? key(name) : key(`device:${device}:${name}`);
const usernameOk = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{3,32}$/.test(value);
const DEFAULT_SCHOOL = { id: 'manuel-scorza', name: 'Manuel Scorza' };
const DEFAULT_DEVICES = [{ id: 'primaria', name: 'Primaria', schoolId: DEFAULT_SCHOOL.id }, { id: 'secundaria', name: 'Secundaria', schoolId: DEFAULT_SCHOOL.id }];
export function configFrom(body) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.hora || '')) throw new HttpError(400, 'Hora inválida');
  const dias = Number(body.dias), duracion = Number(body.duracion);
  if (!['0', '1'].includes(String(body.activo))) throw new HttpError(400, 'Activación inválida');
  const programacionActiva = String(body.activo) === '1';
  if (!Number.isInteger(dias) || dias < 0 || dias > 127 || (programacionActiva && !dias)) throw new HttpError(400, 'Selecciona al menos un día');
  if (!Number.isInteger(duracion) || duracion < 1 || duracion > 3600) throw new HttpError(400, 'Duración inválida (1–3600 s)');
  return { horaProgramada: body.hora, dias, duracion, programacionActiva };
}
export const MAX_ALARMAS = 32;
export function alarmasDe(config) {
  if (Array.isArray(config?.alarmas)) return config.alarmas;
  if (!config) return [];
  return [{ id: '00000001', nombre: 'Timbre existente', hora: config.horaProgramada,
    dias: config.dias, duracion: config.duracion, activa: config.programacionActiva }];
}
export function validarAlarmas(value) {
  let list;
  try { list = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new HttpError(400, 'Horarios inválidos'); }
  if (!Array.isArray(list) || list.length > MAX_ALARMAS) throw new HttpError(400, 'Puedes guardar hasta 32 horarios');
  const ids = new Set();
  const result = list.map(a => {
    if (!a || !/^[a-f0-9]{8}$/.test(a.id || '') || a.id === '00000000' || ids.has(a.id)) throw new HttpError(400, 'Identificador de horario inválido');
    ids.add(a.id);
    if (typeof a.nombre !== 'string' || !a.nombre.trim() || a.nombre.trim().length > 40) throw new HttpError(400, 'Escribe un nombre de hasta 40 caracteres');
    if (typeof a.activa !== 'boolean') throw new HttpError(400, 'Activación inválida');
    const c = configFrom({ hora: a.hora, dias: a.dias, duracion: a.duracion, activo: a.activa ? '1' : '0' });
    return { id: a.id, nombre: a.nombre.trim(), hora: c.horaProgramada, dias: c.dias, duracion: c.duracion, activa: c.programacionActiva };
  });
  for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
    const a = result[i], b = result[j];
    if (a.activa && b.activa && a.hora === b.hora && (a.dias & b.dias)) throw new HttpError(400, 'Dos timbres activos coinciden a la misma hora y día');
  }
  return result.sort((a,b) => a.hora.localeCompare(b.hora) || a.id.localeCompare(b.id));
}
export async function redis(...command) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url?.startsWith('https://') || !token) throw new HttpError(503, 'Falta conectar Redis en Vercel');
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new HttpError(503, 'Almacenamiento no disponible');
  const data = await response.json();
  if (data.error) throw new HttpError(503, 'Almacenamiento no disponible');
  return data.result;
}
const parse = value => value ? JSON.parse(value) : null;
const CONFIG_CAS = `-- compare-and-set schedule
local old=redis.call('GET',KEYS[1])
local rev='-'
if old then rev=cjson.decode(old).revision end
if rev~=ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2])
return 1`;
const PASSWORD_CAS = `-- compare-and-set credentials
local old=redis.call('GET',KEYS[1]) or ''
if old~=ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2])
return 1`;
export function createService(db = redis, env = process.env, clock = () => Math.floor(Date.now() / 1000)) {
  const deviceTokens = devicesFrom(env);
  async function limited(name, maximum = 10) {
    const bucket = key(`${name}:${Math.floor(clock() / 600)}`);
    const attempts = await db('INCR', bucket);
    if (attempts === 1) await db('EXPIRE', bucket, 660);
    if (attempts > maximum) throw new HttpError(429, 'Demasiados intentos. Espera 10 minutos.');
  }
  async function checkPassword(password, credentials) {
    if (typeof password !== 'string' || password.length > 128) return false;
    if (!credentials) return !!env.ADMIN_PASSWORD && same(password, env.ADMIN_PASSWORD);
    const hash = await deriveKey(password, credentials.salt, 64);
    return same(hash.toString('hex'), credentials.hash);
  }
  async function replacePassword(body, raw) {
    if (typeof body.nueva !== 'string' || body.nueva.length < 12 || body.nueva.length > 128 || !body.nueva.trim()) throw new HttpError(400, 'Usa una contraseña de 12 a 128 caracteres.');
    if (body.nueva !== body.confirmacion) throw new HttpError(400, 'Las contraseñas nuevas no coinciden.');
    const current = parse(raw);
    if (await checkPassword(body.nueva, current)) throw new HttpError(400, 'Elige una contraseña distinta a la actual.');
    const salt = randomBytes(16).toString('hex');
    const hash = (await deriveKey(body.nueva, salt, 64)).toString('hex');
    const next = { version: id(), salt, hash };
    const saved = await db('EVAL', PASSWORD_CAS, 1, key('credentials'), raw || '', JSON.stringify(next));
    if (!saved) throw new HttpError(409, 'La cuenta cambió durante la operación. Vuelve a iniciar sesión.');
    return { ok: true };
  }
  async function audit(action, { user = 'sistema', device = '-', detail = '' } = {}) {
    const entry = { id: id(), time: clock(), action, user, device, detail: String(detail).slice(0, 120) };
    await db('LPUSH', key('audit'), JSON.stringify(entry));
    await db('LTRIM', key('audit'), 0, 499);
  }
  async function accounts() { return parse(await db('GET', key('users'))) || {}; }
  async function allSchools() { return [DEFAULT_SCHOOL, ...(parse(await db('GET', key('schools'))) || []).filter(school => school.id !== DEFAULT_SCHOOL.id)]; }
  async function allDevices() {
    const registered = parse(await db('GET', key('devices'))) || [];
    const rotated = parse(await db('GET', key('rotated-device-tokens'))) || {};
    const defaults = DEFAULT_DEVICES.map(device => ({ ...device, tokenConfigured: !!rotated[device.id] || (!!deviceTokens[device.id] && deviceTokens[device.id].length >= 32) }));
    return [...defaults, ...registered.filter(device => !DEFAULT_DEVICES.some(base => base.id === device.id)).map(({ id, name, created, schoolId }) => ({ id, name, created, schoolId: schoolId || DEFAULT_SCHOOL.id, tokenConfigured: true }))];
  }
  async function findDevice(device) {
    if (typeof device !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(device)) throw new HttpError(400, 'Nivel inválido');
    const result = (await allDevices()).find(item => item.id === device);
    if (!result) throw new HttpError(404, 'Nivel no encontrado');
    return result;
  }
  async function devicesFor(user) {
    const devices = await allDevices();
    if (user?.role === 'superadmin') return devices;
    if (user?.schoolId) return devices.filter(device => device.schoolId === user.schoolId);
    return Array.isArray(user?.devices) ? devices.filter(device => user.devices.includes(device.id)) : [];
  }
  async function session(cookie = '') {
    const token = cookie.split(';').map(x => x.trim()).find(x => x.startsWith('timbre_session='))?.slice(15);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Inicia sesión para continuar');
    const raw = await db('GET', key(`session:${digest(token)}`));
    if (!raw) throw new HttpError(401, 'Inicia sesión para continuar');
    let saved;
    try { const parsed = JSON.parse(raw); saved = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { saved = null; }
    if (!saved) {
      const credentials = parse(await db('GET', key('credentials')));
      if (raw !== (credentials?.version || '1')) throw new HttpError(401, 'Inicia sesión para continuar');
    } else if (saved.role === 'superadmin') {
      const credentials = parse(await db('GET', key('credentials')));
      if (saved.version !== (credentials?.version || '1')) throw new HttpError(401, 'Inicia sesión para continuar');
    } else {
      const current = (await accounts())[saved.id];
      if (!current || !current.active || current.version !== saved.version) throw new HttpError(401, 'Inicia sesión para continuar');
    }
    return token;
  }
  async function sessionUser(token) {
    const raw = await db('GET', key(`session:${digest(token)}`));
    try { const saved = JSON.parse(raw); if (saved && typeof saved === 'object' && !Array.isArray(saved)) return { id: saved.id, username: saved.username, role: saved.role, devices: saved.devices, schoolId: saved.schoolId }; } catch {}
    return { id: 'root', username: env.ADMIN_USER || 'admin', role: 'superadmin' };
  }
  async function state(device = 'primaria') {
    const meta = await findDevice(device);
    const school = (await allSchools()).find(item => item.id === meta.schoolId) || DEFAULT_SCHOOL;
    const [c, t, cmd] = (await db('MGET', deviceKey(device, 'config'), deviceKey(device, 'telemetry'), deviceKey(device, 'command'))).map(parse);
    const ahora = clock(), online = !!t && ahora - t.seen <= 35;
    const config = c || { horaProgramada: '18:00', programacionActiva: false, dias: 127, duracion: 10 };
    return { ...config, dispositivo: device, nombreDispositivo: meta.name, colegioId: school.id, colegioNombre: school.name, tokenConfigurado: meta.tokenConfigured, diasSuspendidos: Number(c?.diasSuspendidos) || 0, alarmas: alarmasDe(c), maxAlarmas: MAX_ALARMAS, firmwareVersion: t?.proto || 1, requiereActualizacion: !!t && t.proto !== 2, ahora, online, configurado: !!c,
      encendido: online && !!t.encendido && t.restante > ahora - t.seen,
      restante: online ? Math.max(0, t.restante - (ahora - t.seen)) : 0,
      hora: online ? t.hora : 'Sin conexión',
      proxima: online && t.revision === c?.revision ? t.proxima : 0,
      pendiente: !!c && (t?.revision !== c.revision || (Array.isArray(c.alarmas) && t?.proto !== 2)),
      ordenPendiente: !!cmd && cmd.expires > ahora && t?.ack !== cmd.id,
      orden: cmd ? { id: cmd.id, vence: cmd.expires } : null,
      ultimoComando: t?.ack || '-',
      ultimaConexion: t?.seen || 0,
      ultimaActivacion: t?.evento ? { id: t.evento, hora: t.eventoHora } : null
    };
  }
  return {
    session, sessionUser, state, devicesFor,
    async login(body, ip) {
      await limited(`login:${digest(ip)}`);
      const rawCredentials = await db('GET', key('credentials'));
      const credentials = parse(rawCredentials);
      if (!credentials && !env.ADMIN_PASSWORD) throw new HttpError(503, 'Falta configurar ADMIN_PASSWORD');
      let user;
      if (same(body.usuario || '', env.ADMIN_USER || 'admin') && await checkPassword(body.clave, credentials)) {
        user = { id: 'root', username: env.ADMIN_USER || 'admin', role: 'superadmin', version: credentials?.version || '1' };
      } else {
        const list = await accounts();
        const account = Object.values(list).find(item => item.username.toLowerCase() === String(body.usuario || '').toLowerCase() && item.active);
        if (account && await checkPassword(body.clave, account)) user = { id: account.id, username: account.username, role: 'admin', version: account.version, devices: account.devices, schoolId: account.schoolId };
      }
      if (!user) throw new HttpError(401, 'Usuario o contraseña incorrectos');
      const token = randomBytes(32).toString('hex');
      await db('SET', key(`session:${digest(token)}`), JSON.stringify(user), 'EX', 43200);
      await audit('inicio de sesión', { user: user.username });
      return token;
    },
    async changePassword(body, token) {
      await limited('password-change');
      const user = await sessionUser(token);
      if (user.role === 'superadmin') {
        const raw = await db('GET', key('credentials'));
        const sessionRaw = await db('GET', key(`session:${digest(token)}`));
        let sessionInfo;try{const value=JSON.parse(sessionRaw);sessionInfo=value&&typeof value==='object'?value:null;}catch{sessionInfo=null;}
        if (sessionInfo ? sessionInfo.version !== (parse(raw)?.version || '1') : sessionRaw !== (parse(raw)?.version || '1')) throw new HttpError(401, 'Inicia sesión para continuar');
        if (!await checkPassword(body.actual, parse(raw))) throw new HttpError(400, 'La contraseña actual es incorrecta.');
        return replacePassword(body, raw);
      }
      const list = await accounts(), account = list[user.id];
      if (!account || !await checkPassword(body.actual, account)) throw new HttpError(400, 'La contraseña actual es incorrecta.');
      if (typeof body.nueva !== 'string' || body.nueva.length < 12 || body.nueva.length > 128 || !body.nueva.trim()) throw new HttpError(400, 'Usa una contraseña de 12 a 128 caracteres.');
      if (body.nueva !== body.confirmacion) throw new HttpError(400, 'Las contraseñas nuevas no coinciden.');
      const salt = randomBytes(16).toString('hex'), hash = (await deriveKey(body.nueva, salt, 64)).toString('hex');
      list[user.id] = { ...account, salt, hash, version: id() };
      await db('SET', key('users'), JSON.stringify(list));
      await audit('cambio de contraseña', { user: user.username });
      return { ok: true };
    },
    async logout(token) { const user = await sessionUser(token); await audit('cierre de sesión', { user: user.username }); await db('DEL', key(`session:${digest(token)}`)); },
    async createAccount(body, actor) {
      if (actor?.role !== 'superadmin') throw new HttpError(403, 'Solo el superadministrador puede crear cuentas.');
      const username = String(body.usuario || '').trim(), schoolId = String(body.colegioId || ''), deviceId = String(body.dispositivoId || '');
      if (!usernameOk(username)) throw new HttpError(400, 'El usuario debe tener 3–32 caracteres: letras, números, punto, guion o guion bajo.');
      if (username.toLowerCase() === (env.ADMIN_USER || 'admin').toLowerCase()) throw new HttpError(409, 'Ese usuario está reservado para el superadministrador.');
      const school = deviceId ? await findDevice(deviceId) : (await allSchools()).find(item => item.id === schoolId);
      if (!school) throw new HttpError(400, 'Selecciona un colegio o nivel válido.');
      if (typeof body.clave !== 'string' || body.clave.length < 12 || body.clave.length > 128 || !body.clave.trim()) throw new HttpError(400, 'Usa una contraseña de 12 a 128 caracteres.');
      const list = await accounts();
      if (Object.values(list).some(item => item.username.toLowerCase() === username.toLowerCase())) throw new HttpError(409, 'Ese nombre de usuario ya existe.');
      const accountId = id(), salt = randomBytes(16).toString('hex'), hash = (await deriveKey(body.clave, salt, 64)).toString('hex');
      list[accountId] = { id: accountId, username, role: 'admin', ...(deviceId ? { devices: [deviceId] } : { schoolId }), active: true, created: clock(), version: id(), salt, hash };
      await db('SET', key('users'), JSON.stringify(list));
      await audit('auxiliar creado', { user: actor.username, device: deviceId || '-', detail: `${username} · ${deviceId ? school.name : school.name}` });
      return { ok: true };
    },
    async createSchool(body, actor) {
      if (actor?.role !== 'superadmin') throw new HttpError(403, 'Solo el superadministrador puede crear colegios.');
      const name = String(body.nombre || '').trim(), username = String(body.usuario || '').trim();
      if (name.length < 2 || name.length > 60) throw new HttpError(400, 'El nombre del colegio debe tener entre 2 y 60 caracteres.');
      if (!usernameOk(username)) throw new HttpError(400, 'El usuario debe tener 3–32 caracteres: letras, números, punto, guion o guion bajo.');
      if (username.toLowerCase() === (env.ADMIN_USER || 'admin').toLowerCase()) throw new HttpError(409, 'Ese usuario está reservado para el superadministrador.');
      if (typeof body.clave !== 'string' || body.clave.length < 12 || body.clave.length > 128 || !body.clave.trim()) throw new HttpError(400, 'Usa una contraseña de 12 a 128 caracteres.');
      const list = await accounts();
      if (Object.values(list).some(item => item.username.toLowerCase() === username.toLowerCase())) throw new HttpError(409, 'Ese nombre de usuario ya existe.');
      const schoolId = `colegio-${id().slice(0, 8)}`, created = clock();
      const schools = parse(await db('GET', key('schools'))) || [];
      schools.push({ id: schoolId, name, created });
      const accountId = id(), salt = randomBytes(16).toString('hex'), hash = (await deriveKey(body.clave, salt, 64)).toString('hex');
      list[accountId] = { id: accountId, username, role: 'admin', schoolId, active: true, created, version: id(), salt, hash };
      await db('SET', key('schools'), JSON.stringify(schools));
      await db('SET', key('users'), JSON.stringify(list));
      await audit('colegio creado', { user: actor.username, detail: `${name} · auxiliar ${username}` });
      return { ok: true, colegio: { id: schoolId, nombre: name }, auxiliar: { usuario: username } };
    },
    async setAccountActive(accountId, active, actor) {
      if (actor?.role !== 'superadmin') throw new HttpError(403, 'Solo el superadministrador puede administrar cuentas.');
      if (!['0', '1', 0, 1, false, true].includes(active)) throw new HttpError(400, 'Estado de cuenta inválido.');
      const list = await accounts(), account = list[accountId];
      if (!account) throw new HttpError(404, 'Cuenta no encontrada.');
      account.active = active === true || active === 1 || active === '1'; account.version = id();
      await db('SET', key('users'), JSON.stringify(list));
      await audit(account.active ? 'auxiliar activado' : 'auxiliar desactivado', { user: actor.username, detail: account.username });
      return { ok: true };
    },
    async createLevel(body, actor) {
      if (actor?.role !== 'superadmin') throw new HttpError(403, 'Solo el superadministrador puede crear niveles.');
      const name = String(body.nombre || '').trim(), schoolId = String(body.colegioId || '');
      if (name.length < 2 || name.length > 32) throw new HttpError(400, 'El nombre del nivel debe tener entre 2 y 32 caracteres.');
      const school = (await allSchools()).find(item => item.id === schoolId);
      if (!school) throw new HttpError(400, 'Selecciona un colegio válido.');
      if ((await allDevices()).some(device => device.schoolId === schoolId && device.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Ese nivel ya existe en este colegio.');
      const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18);
      const deviceId = `d-${id().slice(0, 8)}-${slug || 'nivel'}`;
      if ((await allDevices()).some(device => device.id === deviceId)) throw new HttpError(409, 'Ese nivel ya existe.');
      const token = randomBytes(32).toString('hex'), created = clock();
      const registered = parse(await db('GET', key('devices'))) || [];
      registered.push({ id: deviceId, name, schoolId, created, tokenHash: digest(token) });
      await db('SET', key('devices'), JSON.stringify(registered));
      await db('SET', key(`device-token:${digest(token)}`), deviceId);
      await audit('nivel creado', { user: actor.username, device: deviceId, detail: `${school.name} · ${name}` });
      return { ok: true, dispositivo: { id: deviceId, nombre: name, colegio: school.name }, token };
    },
    async rotateDeviceToken(device, actor) {
      if (actor?.role !== 'superadmin') throw new HttpError(403, 'Solo el superadministrador puede renovar tokens.');
      const meta = await findDevice(device), registered = parse(await db('GET', key('devices'))) || [];
      const record = registered.find(item => item.id === device);
      const currentKey = key(`device-token-current:${device}`);
      const oldHash = record?.tokenHash || await db('GET', currentKey) || (deviceTokens[device] ? digest(deviceTokens[device]) : '');
      const token = randomBytes(32).toString('hex'), tokenHash = digest(token);
      if (oldHash) await db('DEL', key(`device-token:${oldHash}`));
      await db('SET', key(`device-token:${tokenHash}`), device);
      await db('SET', currentKey, tokenHash);
      if (record) {
        record.tokenHash = tokenHash;
        await db('SET', key('devices'), JSON.stringify(registered));
      } else {
        const rotated = parse(await db('GET', key('rotated-device-tokens'))) || {};
        rotated[device] = true;
        await db('SET', key('rotated-device-tokens'), JSON.stringify(rotated));
      }
      await audit('token de placa renovado', { user: actor.username, device, detail: 'El token anterior quedó invalidado.' });
      return { ok: true, dispositivo: { id: meta.id, nombre: meta.name }, token };
    },
    async adminData(actor) {
      if (actor?.role !== 'superadmin') throw new HttpError(403, 'Solo el superadministrador puede ver el panel global.');
      const placas = await Promise.all((await allDevices()).map(device => state(device.id)));
      for (const placa of placas) {
        const stateValue = placa.online ? 'online' : 'offline';
        const statusKey = key(`monitor:${placa.dispositivo}:online`);
        const previous = await db('GET', statusKey);
        if (previous && previous !== stateValue) {
          await db('SET', statusKey, stateValue);
          await audit(placa.online ? 'placa conectada' : 'placa sin conexión', { device: placa.dispositivo });
        }
        const activation = placa.ultimaActivacion?.id;
        const activationKey = key(`monitor:${placa.dispositivo}:activation`);
        const lastActivation = await db('GET', activationKey);
        if (activation && activation !== lastActivation) {
          await db('SET', activationKey, activation);
          await audit('timbre activado', { device: placa.dispositivo, detail: String(placa.ultimaActivacion.hora) });
        }
      }
      const deviceRecords = await allDevices(), devicesById = Object.fromEntries(deviceRecords.map(device => [device.id, device]));
      const schools = await allSchools(), schoolNames = Object.fromEntries(schools.map(school => [school.id, school.name]));
      const users = Object.values(await accounts()).map(({ id, username, role, active, created, devices, schoolId }) => {
        const scoped = Array.isArray(devices) ? devices.map(device => devicesById[device]).filter(Boolean) : [];
        const resolvedSchool = schoolId || scoped[0]?.schoolId;
        return { id, username, role, active, created, colegio: schoolNames[resolvedSchool] || 'Sin asignar', alcance: schoolId ? 'Todo el colegio' : scoped.map(device => device.name).join(', ') || 'Sin asignar' };
      });
      const historial = (await db('LRANGE', key('audit'), 0, 99) || []).map(parse).filter(Boolean);
      return { colegios: schools, placas, cuentas: users, historial };
    },
    async program(body, device = 'primaria', actor = 'sistema') {
      await findDevice(device);
      const configKey = deviceKey(device, 'config');
      if (body.alarmas !== undefined) {
        const alarmas = validarAlarmas(body.alarmas);
        const current = parse(await db('GET', configKey));
        const expected = current?.revision || '-';
        if (body.revision !== expected) throw new HttpError(409, 'Los horarios cambiaron. Cierra el editor y vuelve a intentarlo.');
        // Conservar la programacion del firmware antiguo hasta actualizar la placa.
        const legacy = current || { horaProgramada: '18:00', programacionActiva: false, dias: 62, duracion: 10 };
        const next = { ...legacy, alarmas, schema: 2, legacyRevision: current?.legacyRevision || current?.revision || id(), revision: id() };

        if (!await db('EVAL', CONFIG_CAS, 1, configKey, expected, JSON.stringify(next))) throw new HttpError(409, 'Los horarios cambiaron. Recarga antes de guardar.');
        await audit('horarios actualizados', { user: actor, device, detail: `${alarmas.length} timbres` });
      } else if (body.diasSuspendidos !== undefined) {
        const diasSuspendidos = Number(body.diasSuspendidos);
        if (!Number.isInteger(diasSuspendidos) || diasSuspendidos < 0 || diasSuspendidos > 127) throw new HttpError(400, 'Días suspendidos inválidos');
        const current = parse(await db('GET', configKey));
        const expected = current?.revision || '-';
        if (body.revision !== expected) throw new HttpError(409, 'La programación cambió. Recarga antes de modificar los días.');
        const base = current || { horaProgramada: '18:00', programacionActiva: false, dias: 62, duracion: 10 };
        const next = { ...base, alarmas: alarmasDe(current), diasSuspendidos, schema: 2,
          legacyRevision: current?.legacyRevision || current?.revision || id(), revision: id() };
        if (!await db('EVAL', CONFIG_CAS, 1, configKey, expected, JSON.stringify(next))) throw new HttpError(409, 'La programación cambió. Recarga antes de modificar los días.');
        await audit('días de timbre actualizados', { user: actor, device });
      } else {
        const current = parse(await db('GET', configKey));
        if (current?.alarmas) throw new HttpError(409, 'Actualiza la página para editar los horarios escolares');
        const next = { ...configFrom(body), revision: id() };
        if (!await db('EVAL', CONFIG_CAS, 1, configKey, current?.revision || '-', JSON.stringify(next))) throw new HttpError(409, 'Los horarios cambiaron. Recarga antes de guardar.');
        await audit('horario actualizado', { user: actor, device });
      }
      return state(device);
    },
    async command(action, body = {}, device = 'primaria', actor = 'sistema') {
      await findDevice(device);
      const configKey = deviceKey(device, 'config'), commandKey = deviceKey(device, 'command');
      const duration = body.duracion === undefined ? undefined : Number(body.duracion);
      if (action === 1 && duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 3600)) throw new HttpError(400, 'Escribe una duración de 1 a 3600 segundos, sin decimales.');
      const status = await state(device);
      if (!status.online) throw new HttpError(409, 'El ESP32 está desconectado. No se envió la orden.');
      if (action === 1 && duration !== undefined && duration !== status.duracion) {
        if (status.firmwareVersion !== 2) throw new HttpError(409, 'Actualiza la placa al firmware escolar para cambiar la duración manual.');
        const current = parse(await db('GET', configKey));
        if (!current) throw new HttpError(409, 'Espera a que la placa sincronice su configuración.');
        const next = { ...current, duracion: duration, revision: id(), legacyRevision: current.legacyRevision || current.revision };
        if (!await db('EVAL', CONFIG_CAS, 1, configKey, current.revision, JSON.stringify(next))) throw new HttpError(409, 'La configuración cambió. Vuelve a intentar.');
      }
      await db('SET', commandKey, JSON.stringify({ id: id(), action, expires: clock() + 30 }), 'EX', 35);
      await audit(action === 1 ? 'prueba manual enviada' : 'orden de detener enviada', { user: actor, device });
      return state(device);
    },
    async sync(body, authorization) {
      const auth = authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      let device = /^[a-f0-9]{64}$/.test(token) ? await db('GET', key(`device-token:${digest(token)}`)) : null;
      if (!device) {
        const envDevice = DEVICE_IDS.find(name => deviceTokens[name] && deviceTokens[name].length >= 32 && same(auth, `Bearer ${deviceTokens[name]}`));
        const rotated = envDevice ? parse(await db('GET', key('rotated-device-tokens'))) || {} : {};
        if (envDevice && !rotated[envDevice]) device = envDevice;
      }
      if (device) await findDevice(device);
      if (!device) throw new HttpError(401, 'Dispositivo no autorizado');
      const configKey = deviceKey(device, 'config'), telemetryKey = deviceKey(device, 'telemetry'), commandKey = deviceKey(device, 'command');
      const initial = configFrom(body);
      if (!/^(?:[a-f0-9]{32}|-)$/.test(body.revision || '') || !/^(?:[a-f0-9]{32}|-)$/.test(body.ack || '')) throw new HttpError(400, 'Identificador inválido');
      if (!/^\d{2}:\d{2}:\d{2}$/.test(body.reloj || '') || !['0', '1'].includes(String(body.encendido))) throw new HttpError(400, 'Estado inválido');
      const restante = Number(body.restante), proxima = Number(body.proxima);
      if (!Number.isInteger(restante) || restante < 0 || restante > 3600 || !Number.isSafeInteger(proxima) || proxima < 0) throw new HttpError(400, 'Telemetría inválida');
      const telemetry = { proto: body.proto === '2' ? 2 : 1, hora: body.reloj, encendido: body.encendido === '1', restante, proxima, revision: body.revision, ack: body.ack, seen: clock() };
      if (body.evento) {
        const eventoHora = Number(body.eventoHora);
        if (!/^[a-f0-9]{16}$/.test(body.evento) || !Number.isSafeInteger(eventoHora) || eventoHora < 0 || eventoHora > clock() + 60) throw new HttpError(400, 'Activación inválida');
        telemetry.evento = body.evento;
        telemetry.eventoHora = eventoHora;
      }
      // Una operación atómica: inicializa sin pisar cambios web y registra la confirmación.
      const script = `local previous=redis.call('GET',KEYS[2])
redis.call('SET',KEYS[1],ARGV[1],'NX')
redis.call('SET',KEYS[2],ARGV[2])
return {redis.call('GET',KEYS[1]),redis.call('GET',KEYS[3]),previous}`;
      const [config, command, previous] = (await db('EVAL', script, 3, configKey, telemetryKey, commandKey, JSON.stringify({ ...initial, revision: id() }), JSON.stringify(telemetry))).map(parse);
      if (!previous) await audit('placa conectada', { device });
      else if (clock() - previous.seen > 35) await audit('placa reconectada', { device, detail: 'La placa dejó de reportar más de 35 segundos.' });
      if (telemetry.evento && telemetry.evento !== previous?.evento) await audit('timbre activado', { device, detail: String(telemetry.eventoHora) });
      const cmd = command && command.expires > clock() && command.id !== body.ack ? command : null;
      if (body.proto === '2') {
        const diasSuspendidos = (Number(config.diasSuspendidos) || 0) & 0x7F;
        const alarmas = alarmasDe(config).map(a => {
          const dias = a.dias & ~diasSuspendidos;
          return { ...a, dias, activa: a.activa && dias !== 0 };
        });
        const header = `v2 ${config.revision} ${alarmas.length} ${config.duracion} ${cmd?.id || '-'} ${cmd?.action || 0} ${cmd?.expires || 0}`;
        const rows = alarmas.map(a => {
          const [h, m] = a.hora.split(':').map(Number);
          return `${a.id} ${h * 60 + m} ${a.activa ? 1 : 0} ${a.dias} ${a.duracion}`;
        });
        return [header, ...rows].join('\n') + '\n';
      }
      const [hour, minute] = config.horaProgramada.split(':').map(Number);
      return `v1 ${config.legacyRevision || config.revision} ${hour * 60 + minute} ${config.programacionActiva ? 1 : 0} ${config.dias} ${config.duracion} ${cmd?.id || '-'} ${cmd?.action || 0} ${cmd?.expires || 0}\n`;
    }
  };
}
