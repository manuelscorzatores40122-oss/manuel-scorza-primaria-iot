import { defineConfig, loadEnv } from 'vite';
import handler from './api/control.js';

export default defineConfig(({ mode }) => ({
  plugins: [{
    name: 'timbre-local-api',
    configureServer(server) {
      // Estas variables pertenecen al servidor; no se exponen al navegador.
      const env = loadEnv(mode, server.config.root, '');
      for (const name of ['ADMIN_USER', 'ADMIN_PASSWORD', 'DEVICE_TOKEN', 'DEVICE_TOKENS', 'DATABASE_URL']) {
        if (process.env[name] === undefined && env[name] !== undefined) process.env[name] = env[name];
      }
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();
        res.status = code => { res.statusCode = code; return res; };
        res.send = value => { res.end(value); return res; };
        res.json = value => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(value));
          return res;
        };
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 65536) return res.status(413).send('Solicitud demasiado grande');
          }
          req.query = { action: url.pathname === '/api/control' ? url.searchParams.get('action') : url.pathname.slice(5), device: url.searchParams.get('device') || 'primaria' };
          req.body = body;
          await handler(req, res);
        } catch {
          if (!res.writableEnded) res.status(500).send('Servicio temporalmente no disponible');
        }
      });
    }
  }]
}));
