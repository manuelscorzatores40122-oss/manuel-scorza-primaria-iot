import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../lib/service.js';

test('la respuesta del servicio JS es aceptada por el parser C++ del ESP32', async () => {
  const token = 'a'.repeat(64);
  const db = async (command, ...args) => {
    assert.equal(command, 'EVAL');
    // Configuracion inicial que el servicio serializa para almacenamiento persistente.
    return [JSON.stringify({...JSON.parse(args[5]),alarmas:[{id:'00000001',hora:'07:30',activa:true,dias:62,duracion:5},{id:'00000002',hora:'10:15',activa:true,dias:62,duracion:8},{id:'00000003',hora:'13:00',activa:true,dias:32,duracion:10}]}), null];
  };
  const service = createService(db, { DEVICE_TOKEN: token });
  const response = await service.sync({
    proto:'2', hora: '06:30', activo: '1', dias: '62', duracion: '15',
    revision: '-', ack: '-', reloj: '08:39:00', encendido: '0', restante: '0', proxima: '1800069660'
  }, `Bearer ${token}`);
  const dir = mkdtempSync(join(tmpdir(), 'timbre-protocol-'));
  try {
    const binary = join(dir, 'test');
    const fixture = join(dir, 'response.txt');
    writeFileSync(fixture, response);
    execFileSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('../../tests/cloud_protocol_test.cpp', import.meta.url)), '-o', binary]);
    assert.match(execFileSync(binary, [fixture], { encoding: 'utf8' }), /OK: protocolo ESP32/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
