import { neon } from '@neondatabase/serverless';

// Server-side key/value storage backed by Neon. Values remain JSON/text so the
// device protocol and API payloads stay unchanged.
export function createNeonStore(env = process.env) {
  let sql;
  let initialized;
  function client() {
    if (!env.DATABASE_URL?.startsWith('postgres')) throw new Error('Falta configurar DATABASE_URL');
    return sql ||= neon(env.DATABASE_URL);
  }
  async function init() {
    if (!initialized) initialized = client()`CREATE TABLE IF NOT EXISTS timbre_kv (
      key text PRIMARY KEY, value text NOT NULL, expires_at timestamptz
    )`;
    await initialized;
  }
  async function get(k) {
    await init();
    const rows = await client()`SELECT value FROM timbre_kv WHERE key=${k} AND (expires_at IS NULL OR expires_at > now())`;
    return rows[0]?.value ?? null;
  }
  async function set(k, v, ...opts) {
    await init();
    const ttl = opts[0] === 'EX' ? Number(opts[1]) : null;
    await client()`INSERT INTO timbre_kv(key,value,expires_at) VALUES (${k},${String(v)},${ttl ? new Date(Date.now()+ttl*1000) : null})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`;
    return 'OK';
  }
  return async function db(command, ...args) {
    await init();
    const q = client();
    switch (command) {
      case 'GET': return get(args[0]);
      case 'MGET': return Promise.all(args.map(get));
      case 'SET': return set(...args);
      case 'DEL': { const rows=await q`DELETE FROM timbre_kv WHERE key=${args[0]}`; return rows.length ? 1 : 0; }
      case 'INCR': {
        const rows=await q`INSERT INTO timbre_kv(key,value) VALUES (${args[0]},'1') ON CONFLICT(key) DO UPDATE SET value=(CASE WHEN timbre_kv.expires_at IS NOT NULL AND timbre_kv.expires_at<=now() THEN 1 ELSE timbre_kv.value::bigint+1 END)::text, expires_at=NULL RETURNING value`;
        return Number(rows[0].value);
      }
      case 'EXPIRE': { const rows=await q`UPDATE timbre_kv SET expires_at=now()+(${Number(args[1])} * interval '1 second') WHERE key=${args[0]}`; return rows.length ? 1 : 0; }
      case 'LPUSH': { const items=JSON.parse(await get(args[0]) || '[]'); items.unshift(args[1]); await set(args[0],JSON.stringify(items)); return items.length; }
      case 'LTRIM': { const items=JSON.parse(await get(args[0]) || '[]').slice(Number(args[1]),Number(args[2])+1); await set(args[0],JSON.stringify(items)); return 'OK'; }
      case 'LRANGE': return JSON.parse(await get(args[0]) || '[]').slice(Number(args[1]),Number(args[2])+1);
      case 'EVAL': {
        const [, , key, expected, next] = args;
        if (args[0].includes('compare-and-set')) {
          const current=await get(key);
          const revision=current ? (args[0].includes('credentials') ? current : JSON.parse(current).revision) : (args[0].includes('credentials') ? '' : '-');
          if (revision!==expected) return 0;
          await set(key,next); return 1;
        }
        const [, , configKey, telemetryKey, commandKey, config, telemetry] = args;
        await init();
        const current=await get(configKey), previous=await get(telemetryKey), command=await get(commandKey);
        await q.transaction([
          q`INSERT INTO timbre_kv(key,value) VALUES (${configKey},${config}) ON CONFLICT(key) DO NOTHING`,
          q`INSERT INTO timbre_kv(key,value) VALUES (${telemetryKey},${telemetry}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        ]);
        return [current || config, command, previous];
      }
      default: throw new Error(`Operación no soportada: ${command}`);
    }
  };
}
