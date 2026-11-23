#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <time.h>
#include <esp_system.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "cloud_ca.h"
#include "cloud_protocol.h"
#if __has_include("cloud_config.h")
#include "cloud_config.h"
#else
#include "cloud_config.example.h"
#endif

// HTTPS corre en otra tarea: los fallos de red no retrasan el apagado.
struct CloudSnapshot { char body[512]; };

QueueHandle_t colaEstado = nullptr;
QueueHandle_t colaNube = nullptr;
char revisionNube[33] = "-";
char ultimoComando[33] = "-";
bool nubeConfigurada() {
  return strlen(TIMBRE_CLOUD_URL) > 0 && strlen(TIMBRE_DEVICE_TOKEN) >= 32;
}

// ===================================
// CONFIGURACION
// ===================================
struct RedWiFi {
  const char* nombre;
  const char* clave;
};
// REDES WIFI MANUALES: agrega aquí una línea por cada router que usará el timbre.
// Formato: {"NOMBRE_EXACTO_DE_LA_RED", "CONTRASEÑA"},
// Ejemplo para copiar y editar: {"MiWiFi_2.4GHz", "mi-clave-wifi"},
// Usa una red de 2.4 GHz. El ESP32 prueba estas redes en orden y vuelve a
// empezar la lista cada 10 segundos hasta conectarse. No borres la coma final
// de las líneas que agregues, excepto si esa línea queda al final del arreglo.
const RedWiFi REDES_WIFI[] = {
  {"Ls", "123456789"},
  {"COMPUTO_2.4GHz", "escorcino2025"},
  {"RT_5B", "123456789"},
  {"MinEdu-5GHz", "1234567890"},
  {"MinEdu-2.4GHz", "1234567890"},
};
const size_t CANTIDAD_REDES_WIFI = sizeof(REDES_WIFI) / sizeof(REDES_WIFI[0]);
const char* HOSTNAME      = "luces";   // accesible en http://luces.local
const char* ZONA_HORARIA  = "PET5";    // Peru (UTC-5, sin horario de verano)

const char* ADMIN_USUARIO = "admin";
const char* ADMIN_CLAVE = "123456";
const uint32_t SESION_MS = 12UL * 60 * 60 * 1000;
String tokenSesion;
uint32_t inicioSesion = 0;

const uint8_t  PIN_RELE              = 15;
// Ajustar al módulo: true = activa con LOW; false = activa con HIGH.
const bool     RELE_ACTIVO_BAJO      = true;
const uint8_t  RELE_NIVEL_ACTIVO     = RELE_ACTIVO_BAJO ? LOW : HIGH;
const uint8_t  RELE_NIVEL_INACTIVO   = RELE_ACTIVO_BAJO ? HIGH : LOW;
// LED azul indicador: ajustar el pin y la polaridad según la placa.
const uint8_t  PIN_LED_AZUL          = 2;
const bool     LED_AZUL_ACTIVO_BAJO  = false;
const uint8_t  LED_AZUL_NIVEL_ACTIVO = LED_AZUL_ACTIVO_BAJO ? LOW : HIGH;
const uint8_t  LED_AZUL_NIVEL_INACTIVO = LED_AZUL_ACTIVO_BAJO ? HIGH : LOW;
const uint32_t TIMEOUT_WIFI_INICIAL  = 20000;  // ms de espera en el arranque
const uint32_t INTERVALO_RECONEXION  = 10000;  // ms entre reintentos de WiFi
const uint32_t INTERVALO_HORARIO     = 500;    // ms entre revisiones del horario
const time_t   EPOCH_MINIMO_VALIDO   = 1700000000; // hora NTP valida (>= nov 2023)

WebServer servidor(80);
Preferences memoria;

// ===================================
// ESTADO
// ===================================
struct Config {
  uint16_t minuto;      // minutos desde las 00:00 (ej. 18:00 = 1080)
  bool     activa;      // programacion diaria activa
  uint8_t  dias;        // bit0 = domingo ... bit6 = sabado (como tm_wday)
  uint16_t duracionSeg; // duracion del encendido en segundos
} cfg;

const uint32_t SCHOOL_MAGIC = 0x54494D32;
struct SchoolProgram {
  uint32_t magic;
  char revision[33];
  unsigned cantidad;
  uint16_t duracionManual;
  SchoolBell timbres[MAX_TIMBRES];
} escuela = {};
bool modoEscolar = false;
uint16_t duracionActualSeg = 10;

bool     releEncendido     = false;
uint32_t inicioEncendido  = 0;
uint32_t ultimaRevision   = 0;
uint32_t ultimoIntentoWiFi = 0;
size_t siguienteRedWiFi = 0;
String redesUsuarioSSID[4], redesUsuarioClave[4];
size_t cantidadRedesUsuario = 0;
bool portalWiFiActivo = false;
char clavePortalWiFi[16] = {};
uint32_t ultimoDia        = 0;     // AAAAMMDD del ultimo disparo
bool     mdnsIniciado     = false;
bool     wifiAnterior     = false;

// ===================================
// UTILIDADES
// ===================================
inline uint32_t duracionMs() { return (uint32_t)duracionActualSeg * 1000UL; }

// Devuelve false si el reloj aun no se sincroniza por NTP (no bloquea)
bool obtenerHora(struct tm &t) {
  time_t ahora = time(nullptr);
  if (ahora < EPOCH_MINIMO_VALIDO) return false;
  localtime_r(&ahora, &t);
  return true;
}

// Convierte "HH:MM" a minutos. Devuelve false si es invalida.
bool parseHora(const String &s, uint16_t &minutos) {
  if (s.length() != 5 || s[2] != ':') return false;
  for (int i : {0, 1, 3, 4}) {
    if (s[i] < '0' || s[i] > '9') return false;
  }
  int h = s.substring(0, 2).toInt();
  int m = s.substring(3, 5).toInt();
  if (h > 23 || m > 59) return false;
  minutos = h * 60 + m;
  return true;
}

void formatearHora(uint16_t minutos, char *buf, size_t n) {
  snprintf(buf, n, "%02u:%02u", minutos / 60, minutos % 60);
}

// ===================================
// PERSISTENCIA
// ===================================
void cargarConfig() {
  cfg.minuto      = memoria.getUShort("minuto", 18 * 60);
  cfg.activa      = memoria.getBool("activo", false);
  cfg.dias        = memoria.getUChar("dias", 0x7F);   // todos los dias
  cfg.duracionSeg = memoria.getUShort("duracion", 10);
  ultimoDia       = memoria.getUInt("ultimoDia", 0);
  memoria.getString("cloudRev", "-").toCharArray(revisionNube, sizeof(revisionNube));
  memoria.getString("cloudCmd", "-").toCharArray(ultimoComando, sizeof(ultimoComando));

  if (cfg.minuto >= 24 * 60) cfg.minuto = 18 * 60;
  if (cfg.duracionSeg < 1 || cfg.duracionSeg > 3600) cfg.duracionSeg = 10;
  cfg.dias &= 0x7F;
}

void cargarHorarioEscolar() {
  if (memoria.getBytesLength("escuelaV2") == sizeof(escuela)) {
    memoria.getBytes("escuelaV2", &escuela, sizeof(escuela));
    modoEscolar = escuela.magic == SCHOOL_MAGIC && escuela.cantidad <= MAX_TIMBRES && idNubeValido(escuela.revision);
    for (unsigned i = 0; modoEscolar && i < escuela.cantidad; ++i) {
      const SchoolBell &b = escuela.timbres[i];
      if (!b.id || b.minuto >= 1440 || b.duracion < 1 || b.duracion > 3600 || b.dias > 127 || b.activa > 1) modoEscolar = false;
    }
  }
  if (!modoEscolar && nubeConfigurada()) {
    escuela = {};
    escuela.magic = SCHOOL_MAGIC;
    strlcpy(escuela.revision, "-", sizeof(escuela.revision));
    escuela.cantidad = 1;
    escuela.duracionManual = cfg.duracionSeg;
    escuela.timbres[0] = { 1, cfg.minuto, cfg.duracionSeg, (uint8_t)cfg.activa, cfg.dias, ultimoDia };
    modoEscolar = true;
  }
  if (modoEscolar) {
    strlcpy(revisionNube, escuela.revision, sizeof(revisionNube));
    cfg.duracionSeg = escuela.duracionManual;
  }
}

void guardarConfig() {
  memoria.putUShort("minuto", cfg.minuto);
  memoria.putBool("activo", cfg.activa);
  memoria.putUChar("dias", cfg.dias);
  memoria.putUShort("duracion", cfg.duracionSeg);
}

// ===================================
// CONTROL DEL RELE
// ===================================
char ultimaActivacion[17] = "";
unsigned long ultimaActivacionHora = 0;

void encenderPor(uint16_t segundos) {
  snprintf(ultimaActivacion, sizeof(ultimaActivacion), "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
  ultimaActivacionHora = (unsigned long)time(nullptr);
  duracionActualSeg = segundos;
  digitalWrite(PIN_RELE, RELE_NIVEL_ACTIVO);
  digitalWrite(PIN_LED_AZUL, LED_AZUL_NIVEL_ACTIVO);
  releEncendido = true;
  inicioEncendido = millis();
  Serial.printf("TIMBRE ENCENDIDO - %u s\n", segundos);
}

void encenderRele() { encenderPor(cfg.duracionSeg); }

void apagarRele() {
  digitalWrite(PIN_RELE, RELE_NIVEL_INACTIVO);
  digitalWrite(PIN_LED_AZUL, LED_AZUL_NIVEL_INACTIVO);
  releEncendido = false;
  Serial.println("TIMBRE APAGADO");
}

void revisarApagado() {
  if (releEncendido && millis() - inicioEncendido >= duracionMs()) {
    apagarRele();
  }
}

// ===================================
// PROGRAMACION DIARIA
// ===================================
void revisarHorario() {
  if (modoEscolar) {
    struct tm t;
    if (!obtenerHora(t)) return;
    uint32_t fecha = (t.tm_year + 1900) * 10000UL + (t.tm_mon + 1) * 100 + t.tm_mday;
    uint16_t segundos = 0;
    for (unsigned i = 0; i < escuela.cantidad; ++i) {
      SchoolBell &bell = escuela.timbres[i];
      if (debeSonar(bell, t.tm_hour * 60 + t.tm_min, t.tm_wday, fecha)) {
        bell.ultimoDia = fecha;
        if (bell.duracion > segundos) segundos = bell.duracion;
      }
    }
    if (segundos) {
      // Una escritura atomica conserva los ultimos disparos de todos los timbres.
      if (memoria.putBytes("escuelaV2", &escuela, sizeof(escuela)) == sizeof(escuela)) {
        Serial.printf("HORARIO ESCOLAR ACTIVADO: %02d:%02d, %u s\n", t.tm_hour, t.tm_min, segundos);
        encenderPor(segundos);
      } else Serial.println("No se pudo guardar el disparo escolar");
    }
    return;
  }
  if (!cfg.activa) return;

  struct tm t;
  if (!obtenerHora(t)) return;

  if (!(cfg.dias & (1 << t.tm_wday))) return;           // dia no seleccionado
  if (t.tm_hour * 60 + t.tm_min != cfg.minuto) return;  // no es la hora

  uint32_t dia = (t.tm_year + 1900) * 10000UL + (t.tm_mon + 1) * 100 + t.tm_mday;
  if (dia == ultimoDia) return;                          // ya se disparo hoy

  ultimoDia = dia;
  memoria.putUInt("ultimoDia", ultimoDia);  // evita repetir tras un reinicio
  encenderRele();
  Serial.println("ENCENDIDO PROGRAMADO");
}

// ===================================
// WIFI (no bloqueante tras el arranque)
// ===================================
void iniciarPortalWiFi() {
  if (portalWiFiActivo) return;
  snprintf(clavePortalWiFi, sizeof(clavePortalWiFi), "T%08lx", (unsigned long)esp_random());
  WiFi.mode(WIFI_AP_STA);
  if (WiFi.softAP("Timbre-Config", clavePortalWiFi)) {
    portalWiFiActivo = true;
    Serial.printf("Portal WiFi: SSID=Timbre-Config clave=%s URL=http://192.168.4.1/wifi\n", clavePortalWiFi);
  } else Serial.println("No se pudo iniciar el portal WiFi");
}

void detenerPortalWiFi() {
  if (!portalWiFiActivo) return;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  portalWiFiActivo = false;
  Serial.println("Portal WiFi cerrado: placa conectada a una red guardada");
}

void intentarSiguienteRedWiFi() {
  size_t total = cantidadRedesUsuario + CANTIDAD_REDES_WIFI;
  if (!total) { iniciarPortalWiFi(); return; }
  size_t indice = siguienteRedWiFi;
  siguienteRedWiFi = (siguienteRedWiFi + 1) % total;
  WiFi.disconnect();
  if (indice < cantidadRedesUsuario) {
    Serial.printf("Conectando a WiFi configurada: %s\n", redesUsuarioSSID[indice].c_str());
    WiFi.begin(redesUsuarioSSID[indice].c_str(), redesUsuarioClave[indice].c_str());
  } else {
    const RedWiFi& red = REDES_WIFI[indice - cantidadRedesUsuario];
    Serial.printf("Conectando a WiFi: %s\n", red.nombre);
    WiFi.begin(red.nombre, red.clave);
  }
  ultimoIntentoWiFi = millis();
}

void mantenerWiFi() {
  bool conectado = WiFi.status() == WL_CONNECTED;

  if (conectado != wifiAnterior) {
    wifiAnterior = conectado;
    if (conectado) {
      detenerPortalWiFi();
      Serial.printf("WiFi conectado a %s. IP: ", WiFi.SSID().c_str());
      Serial.println(WiFi.localIP());
    } else {
      Serial.println("WiFi desconectado");
      if (mdnsIniciado) MDNS.end();
      mdnsIniciado = false;
    }
  }

  if (conectado) {
    if (!mdnsIniciado && MDNS.begin(HOSTNAME)) {
      MDNS.addService("http", "tcp", 80);
      mdnsIniciado = true;
      Serial.printf("Disponible en http://%s.local\n", HOSTNAME);
    }
  } else {
    if (!portalWiFiActivo && millis() - ultimoIntentoWiFi >= INTERVALO_RECONEXION) iniciarPortalWiFi();
    if (millis() - ultimoIntentoWiFi >= INTERVALO_RECONEXION) intentarSiguienteRedWiFi();
  }
}

// ===================================
// PAGINA WEB
// ===================================
const char PAGINA[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#080808">
<title>Alarmas · Timbre</title>
<style>
:root{color-scheme:dark;--bg:#080808;--card:#191919;--muted:#99999f;--accent:#9690ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#f7f7fa;font-family:system-ui,-apple-system,sans-serif}button,input{font:inherit}button{cursor:pointer;border:0;color:inherit}button:disabled{opacity:.45;cursor:wait}button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:5px}[hidden]{display:none!important}main{max-width:720px;margin:auto;padding:24px 22px 100px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;color:var(--muted)}.brand{color:#eee;font-weight:600;letter-spacing:.04em}.quiet{background:transparent;color:var(--muted);padding:12px}.hero{text-align:center;min-height:300px;display:flex;flex-direction:column;justify-content:center;padding:35px 15px}.hero h1{font-size:clamp(28px,6vw,42px);font-weight:400;line-height:1.2;margin:0 0 14px;letter-spacing:-1px}.hero p{color:var(--muted);margin:0;font-size:15px;line-height:1.6}.section-title{display:flex;align-items:center;justify-content:space-between;margin:12px 6px;color:var(--muted);font-size:14px}.card{background:var(--card);border-radius:32px;padding:28px;margin-bottom:18px}.alarm{display:flex;align-items:center;gap:16px;min-height:150px}.edit{background:none;text-align:left;padding:0;flex:1;min-width:0}.time{font-size:clamp(44px,10vw,64px);font-weight:300;letter-spacing:-2px}.period{font-size:19px;letter-spacing:0;margin-left:8px}.alarm.off .time,.alarm.off .period{color:#818186}.repeat{display:flex;gap:10px;color:#89898e;font-size:13px;margin-top:14px}.repeat .selected{color:var(--accent);font-weight:700}.hint{font-size:12px;color:var(--muted);margin:12px 0 0}.switch{position:relative;display:block;flex:0 0 54px;height:32px}.switch input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;margin:0}.track{display:block;border-radius:40px;background:#5b5b60;height:32px;pointer-events:none}.track:after{content:'';position:absolute;width:26px;height:26px;top:3px;left:3px;background:#fafafa;border-radius:50%;transition:transform .18s}.switch input:checked+.track{background:var(--accent)}.switch input:checked+.track:after{transform:translateX(22px)}.switch input:focus-visible+.track{outline:3px solid #fff;outline-offset:5px}.status{display:flex;align-items:center;gap:9px;font-size:14px}.dot{width:8px;height:8px;border-radius:50%;background:#777}.dot.on{background:#a8e4bd;box-shadow:0 0 16px #a8e4bd66}.muted{color:var(--muted);font-size:14px;line-height:1.6}.actions{display:flex;gap:10px;margin-top:20px}.primary,.secondary{border-radius:18px;padding:14px 20px;font-weight:600}.primary{background:var(--accent);color:#15132c}.secondary{background:#303034;color:#eee}.actions>*{flex:1}footer{text-align:center;margin-top:42px;color:var(--muted);font-size:13px}footer span{display:inline-block;color:#eee;border-bottom:3px solid var(--accent);padding:12px}.login{max-width:420px;margin:10vh auto 0}.icon{width:56px;height:56px;display:grid;place-items:center;background:#9690ff20;color:var(--accent);border-radius:19px;font-size:28px;margin-bottom:24px}.login h1{font-size:32px;font-weight:500;margin:0}.field{display:block;margin:20px 0 8px;color:#bbb;font-size:14px}input[type=text],input[type=password],input[type=time],input[type=number]{width:100%;background:#252528;border:1px solid #404045;border-radius:16px;padding:14px;color:#fff}input[type=time]{font-size:36px;text-align:center}.wide{width:100%;margin-top:24px}.notice{min-height:24px;color:#c6c1ff;font-size:14px;line-height:1.5;margin:18px 4px}.error{color:#ffb4b4}dialog{width:calc(100% - 28px);max-width:460px;max-height:90dvh;overflow:auto;background:#191919;color:#fff;border:1px solid #333;border-radius:30px;padding:26px}dialog::backdrop{background:#000b;backdrop-filter:blur(5px)}dialog h2{margin:0;font-weight:500}.days{display:flex;justify-content:space-between;gap:5px;margin:14px 0}.day{position:relative;flex:1;text-align:center}.day input{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}.day span{display:grid;place-items:center;height:40px;border-radius:50%;background:#303034;font-size:14px}.day input:checked+span{background:var(--accent);color:#15132c;font-weight:bold}.day input:focus-visible+span{outline:2px solid #fff;outline-offset:3px}.check{display:flex;gap:10px;align-items:center;margin:22px 0;font-size:14px}.check input{accent-color:var(--accent);width:18px;height:18px}@media(max-width:400px){main{padding:18px 14px 50px}.card{padding:22px}.hero{min-height:270px}.actions{flex-wrap:wrap}.actions button{padding:14px 12px}}
</style>
</head>
<body>
<main>
<section id="login" class="login" hidden>
<div class="icon" aria-hidden="true">◷</div><h1>Tu timbre, a tiempo.</h1>
<p class="muted">Inicia sesión para administrar tu alarma.</p>
<form id="loginForm" class="card">
<label class="field" for="usuario">Usuario</label><input type="text" id="usuario" name="usuario" autocomplete="username" required>
<label class="field" for="clave">Contraseña</label><input type="password" id="clave" name="clave" autocomplete="current-password" required>
<button class="primary wide" id="entrar">Iniciar sesión</button>
<p id="loginError" class="notice error" role="alert"></p>
</form><p class="muted">Timbre inteligente · Acceso de administrador</p>
</section>
<section id="app" hidden>
<header class="top"><span class="brand">TIMBRE / ALARMAS</span><button id="salir" class="quiet">Cerrar sesión</button></header>
<section class="hero"><h1 id="proxima">Consultando alarma…</h1><p id="fecha">Conectando con tu timbre</p></section>
<div class="section-title"><span>Tu alarma</span><span>Hora de Perú</span></div>
<article class="card alarm" id="tarjeta">
<button class="edit" id="editar" aria-label="Editar alarma"><span class="time" id="horaTarjeta">--:--</span><span class="period" id="periodo"></span><span id="repeticion" class="repeat"></span><p class="hint">Toca para editar</p></button>
<label class="switch"><input type="checkbox" id="interruptor" aria-label="Activar alarma"><span class="track"></span></label>
</article>
<section class="card"><div class="status"><span id="punto" class="dot"></span><span id="estado">Consultando…</span></div><p id="manualInfo" class="muted"></p><div class="actions"><button id="probar" class="secondary">Probar timbre</button><button id="detener" class="secondary">Detener</button></div></section>
<p id="mensaje" class="notice" role="status" aria-live="polite"></p>
<footer><span>Alarmas</span><p id="reloj">Sincronizando reloj…</p></footer>
</section>
<p id="conexion" class="notice" role="status">Conectando con el timbre…</p>
</main>
<dialog id="editor" aria-labelledby="tituloEditor"><form id="alarmForm">
<h2 id="tituloEditor">Editar alarma</h2><label class="field" for="hora">Hora</label><input type="time" id="hora" required>
<label class="field">Repetir los días</label><div class="days" id="dias" role="group" aria-label="Días de repetición"></div>
<label class="field" for="duracion">Duración del timbre (segundos)</label><input type="number" id="duracion" min="1" max="3600" step="1" required>
<label class="check"><input type="checkbox" id="activo">Activar alarma</label>
<p id="editorError" class="notice error" role="alert"></p><div class="actions"><button type="button" id="cancelar" class="secondary">Cancelar</button><button id="guardar" class="primary">Guardar</button></div>
</form></dialog>
<script>
const $=id=>document.getElementById(id);
const LETRAS=['D','L','M','X','J','V','S'], NOMBRES=['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
let datos=null, autenticado=false, ocupado=false;
$('dias').innerHTML=LETRAS.map((n,i)=>`<label class="day"><input type="checkbox" data-dia="${i}" aria-label="${NOMBRES[i]}"><span>${n}</span></label>`).join('');
function mostrarLogin(){autenticado=false;datos=null;$('app').hidden=true;$('login').hidden=false;$('conexion').hidden=true;$('editor').close();}
async function pedir(url,body){
 const ctrl=new AbortController(), timeout=setTimeout(()=>ctrl.abort(),5000);
 try{const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'X-Timbre-Request':'1'},body:body===undefined?undefined:new URLSearchParams(body),cache:'no-store',signal:ctrl.signal});
 if(r.status===401){mostrarLogin();throw new Error(url==='/login'?'Usuario o contraseña incorrectos.':'Inicia sesión para continuar.');}
 if(!r.ok)throw new Error(await r.text());return await r.json();
 }catch(e){if(e.name==='AbortError'||e instanceof TypeError)throw new Error('No se pudo conectar con el timbre. Vuelve a intentar.');throw e;}finally{clearTimeout(timeout);}
}
function pintar(d){
 datos=d;autenticado=true;$('login').hidden=true;$('app').hidden=false;$('conexion').hidden=true;
 const [h,m]=d.horaProgramada.split(':').map(Number);
 $('horaTarjeta').textContent=`${h%12||12}:${String(m).padStart(2,'0')}`;$('periodo').textContent=h<12?'a. m.':'p. m.';
 $('tarjeta').classList.toggle('off',!d.programacionActiva);$('interruptor').checked=d.programacionActiva;
 $('repeticion').innerHTML=LETRAS.map((n,i)=>`<span class="${d.dias&(1<<i)?'selected':''}" title="${NOMBRES[i]}">${n}</span>`).join('');
 $('estado').textContent=d.encendido?`Sonando · quedan ${d.restante} s`:'Timbre en espera';$('punto').classList.toggle('on',d.encendido);
 $('manualInfo').textContent=`El timbre se apaga automáticamente después de ${d.duracion} segundos.`;$('detener').disabled=!d.encendido||ocupado;
 $('reloj').textContent='Hora de Perú · '+d.hora;
 if(!d.programacionActiva){$('proxima').textContent='Alarma desactivada';$('fecha').textContent='Actívala cuando la necesites.';}
 else if(!d.proxima){$('proxima').textContent='Sincronizando la hora';$('fecha').textContent='La alarma estará lista al sincronizar el reloj.';}
 else {const minutos=Math.max(1,Math.ceil((d.proxima-d.ahora)/60)),horas=Math.floor(minutos/60),resto=minutos%60;
 $('proxima').textContent='Alarma dentro de '+(horas?`${horas} ${horas===1?'hora':'horas'}`:'')+(horas&&resto?' y ':'')+(resto?`${resto} ${resto===1?'minuto':'minutos'}`:'');
 $('fecha').textContent=new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(d.proxima*1000));}
}
function bloquear(valor){ocupado=valor;['interruptor','probar','editar','guardar','salir'].forEach(id=>$(id).disabled=valor);$('detener').disabled=valor||!datos?.encendido;}
async function consultar(){if(!ocupado)try{pintar(await pedir('/estado'));}catch(e){if(autenticado){$('mensaje').textContent=e.message;$('estado').textContent='Sin conexión';}else if($('login').hidden)$('conexion').textContent=e.message;}setTimeout(consultar,2000);}
$('loginForm').onsubmit=async e=>{e.preventDefault();$('entrar').disabled=true;$('loginError').textContent='';try{await pedir('/login',{usuario:$('usuario').value,clave:$('clave').value});$('clave').value='';pintar(await pedir('/estado'));}catch(e){$('loginError').textContent=e.message;}finally{$('entrar').disabled=false;}};
$('salir').onclick=async()=>{bloquear(true);try{await pedir('/logout',{});mostrarLogin();}catch(e){$('mensaje').textContent=e.message;}finally{bloquear(false);}};
$('editar').onclick=()=>{if(!datos)return;$('hora').value=datos.horaProgramada;$('duracion').value=datos.duracion;$('activo').checked=datos.programacionActiva;document.querySelectorAll('[data-dia]').forEach(c=>c.checked=!!(datos.dias&(1<<c.dataset.dia)));$('editorError').textContent='';$('editor').showModal();};
$('cancelar').onclick=()=>$('editor').close();
async function modificar(body){bloquear(true);try{pintar(await pedir('/programar',body));$('mensaje').textContent='Alarma guardada.';return true;}finally{bloquear(false);}}
$('alarmForm').onsubmit=async e=>{e.preventDefault();let dias=0;document.querySelectorAll('[data-dia]').forEach(c=>{if(c.checked)dias|=1<<c.dataset.dia;});if($('activo').checked&&!dias){$('editorError').textContent='Selecciona al menos un día.';return;}try{await modificar({hora:$('hora').value,dias,activo:$('activo').checked?'1':'0',duracion:$('duracion').value});$('editor').close();}catch(e){$('editorError').textContent=e.message;}};
$('interruptor').onchange=async()=>{if(!datos)return;const anterior=datos.programacionActiva;try{await modificar({hora:datos.horaProgramada,dias:datos.dias,activo:$('interruptor').checked?'1':'0',duracion:datos.duracion});}catch(e){$('interruptor').checked=anterior;$('mensaje').textContent=e.message;}};
async function manual(url){bloquear(true);try{pintar(await pedir(url,{}));$('mensaje').textContent=url==='/encender'?'Prueba de timbre iniciada.':'Timbre detenido.';}catch(e){$('mensaje').textContent=e.message;}finally{bloquear(false);}}
$('probar').onclick=()=>manual('/encender');$('detener').onclick=()=>manual('/apagar');consultar();
</script>
</body>
</html>
)HTML";

// ===================================
// API
// ===================================
// Sesion en RAM: expira a las 12 horas y al reiniciar el ESP32.
bool autorizado() {
  if (tokenSesion.isEmpty() || millis() - inicioSesion >= SESION_MS) return false;
  String cookies = "; " + servidor.header("Cookie") + ";";
  return cookies.indexOf("; timbre_session=" + tokenSesion + ";") >= 0;
}

bool proteger() {
  servidor.sendHeader("Cache-Control", "no-store");
  if (!autorizado()) {
    servidor.send(401, "text/plain; charset=utf-8", "Sesion requerida");
    return false;
  }
  if (servidor.method() == HTTP_POST && servidor.header("X-Timbre-Request") != "1") {
    servidor.send(403, "text/plain", "Solicitud no permitida");
    return false;
  }
  return true;
}

void iniciarSesion() {
  servidor.sendHeader("Cache-Control", "no-store");
  if (servidor.header("X-Timbre-Request") != "1") {
    servidor.send(403, "text/plain", "Solicitud no permitida");
    return;
  }
  if (servidor.arg("usuario") != ADMIN_USUARIO || servidor.arg("clave") != ADMIN_CLAVE) {
    servidor.send(401, "text/plain", "Credenciales incorrectas");
    return;
  }
  char token[33];
  snprintf(token, sizeof(token), "%08lx%08lx%08lx%08lx",
           (unsigned long)esp_random(), (unsigned long)esp_random(),
           (unsigned long)esp_random(), (unsigned long)esp_random());
  tokenSesion = token;
  inicioSesion = millis();
  servidor.sendHeader("Set-Cookie", "timbre_session=" + tokenSesion + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200");
  servidor.send(200, "application/json", "{\"ok\":true}");
}

void enviarPortalWiFi() {
  servidor.sendHeader("Cache-Control", "no-store");
  servidor.send(200, "text/html; charset=utf-8", R"HTML(<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configurar Wi-Fi del timbre</title><style>body{font:16px system-ui;max-width:440px;margin:40px auto;padding:0 18px;background:#111;color:#fff}input,button{box-sizing:border-box;width:100%;padding:13px;margin:8px 0;border-radius:10px;border:1px solid #555;background:#222;color:#fff}button{background:#9690ff;color:#111;font-weight:bold}</style><h1>Configurar Wi-Fi</h1><p>Inicia sesión como administrador de la placa. Usa una red de 2.4 GHz.</p><section id="login"><input id="usuario" autocomplete="username" placeholder="Usuario"><input id="clave" type="password" autocomplete="current-password" placeholder="Contraseña"><button onclick="entrar()">Iniciar sesión</button></section><section id="config" hidden><form onsubmit="guardar(event)"><label>Nombre de red (SSID)<input id="ssid" maxlength="32" required></label><label>Contraseña Wi-Fi<input id="pass" type="password" maxlength="63"></label><button>Guardar red y conectar</button></form></section><p id="estado" role="status"></p><script>async function entrar(){let r=await fetch('/login',{method:'POST',headers:{'X-Timbre-Request':'1','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({usuario:document.getElementById('usuario').value,clave:document.getElementById('clave').value})});if(!r.ok){document.getElementById('estado').textContent='Credenciales incorrectas';return}document.getElementById('login').hidden=true;document.getElementById('config').hidden=false;document.getElementById('estado').textContent='Acceso de administrador confirmado'}async function guardar(e){e.preventDefault();let r=await fetch('/wifi/guardar',{method:'POST',headers:{'X-Timbre-Request':'1','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ssid:document.getElementById('ssid').value,clave:document.getElementById('pass').value})});document.getElementById('estado').textContent=r.ok?'Red guardada. La placa intentará conectarse; el portal se cerrará al conectar.':await r.text()}</script></html>)HTML");
}

void guardarRedWiFi() {
  if (!proteger()) return;
  String ssid = servidor.arg("ssid"), clave = servidor.arg("clave");
  ssid.trim();
  if (ssid.isEmpty() || ssid.length() > 32 || clave.length() > 63) {
    servidor.send(400, "text/plain; charset=utf-8", "SSID o contraseña inválidos");
    return;
  }
  size_t indice = cantidadRedesUsuario;
  for (size_t i = 0; i < cantidadRedesUsuario; ++i) {
    if (redesUsuarioSSID[i] == ssid) { indice = i; break; }
  }
  if (indice == 4 && cantidadRedesUsuario == 4) {
    servidor.send(400, "text/plain; charset=utf-8", "La placa admite hasta cuatro redes guardadas");
    return;
  }
  redesUsuarioSSID[indice] = ssid;
  redesUsuarioClave[indice] = clave;
  if (indice == cantidadRedesUsuario) ++cantidadRedesUsuario;
  for (size_t i = 0; i < cantidadRedesUsuario; ++i) {
    char ssidKey[8], passKey[8];
    snprintf(ssidKey, sizeof(ssidKey), "wssid%u", (unsigned)i);
    snprintf(passKey, sizeof(passKey), "wpass%u", (unsigned)i);
    memoria.putString(ssidKey, redesUsuarioSSID[i]);
    memoria.putString(passKey, redesUsuarioClave[i]);
  }
  memoria.putUChar("wcount", cantidadRedesUsuario);
  siguienteRedWiFi = 0;
  ultimoIntentoWiFi = millis() - INTERVALO_RECONEXION;
  servidor.send(200, "application/json", "{\"ok\":true}");
}

void cerrarSesion() {
  if (!proteger()) return;
  tokenSesion = "";
  servidor.sendHeader("Set-Cookie", "timbre_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  servidor.send(200, "application/json", "{\"ok\":true}");
}

time_t proximaAlarma(time_t ahora) {
  if (modoEscolar) {
    if (ahora < EPOCH_MINIMO_VALIDO) return 0;
    time_t proxima = 0;
    for (unsigned i = 0; i < escuela.cantidad; ++i) {
      const SchoolBell &bell = escuela.timbres[i];
      if (!bell.activa || !bell.dias) continue;
      for (int offset = 0; offset <= 7; ++offset) {
        struct tm t;
        localtime_r(&ahora, &t);
        t.tm_mday += offset;
        t.tm_hour = bell.minuto / 60;
        t.tm_min = bell.minuto % 60;
        t.tm_sec = 0;
        t.tm_isdst = -1;
        time_t siguiente = mktime(&t);
        uint32_t fecha = (t.tm_year + 1900) * 10000UL + (t.tm_mon + 1) * 100 + t.tm_mday;
        if (siguiente > ahora && debeSonar(bell, bell.minuto, t.tm_wday, fecha)) {
          if (!proxima || siguiente < proxima) proxima = siguiente;
          break;
        }
      }
    }
    return proxima;
  }
  if (!cfg.activa || !cfg.dias || ahora < EPOCH_MINIMO_VALIDO) return 0;
  for (int offset = 0; offset <= 7; ++offset) {
    struct tm candidato;
    localtime_r(&ahora, &candidato);
    candidato.tm_mday += offset;
    candidato.tm_hour = cfg.minuto / 60;
    candidato.tm_min = cfg.minuto % 60;
    candidato.tm_sec = 0;
    candidato.tm_isdst = -1;
    time_t siguiente = mktime(&candidato);
    uint32_t dia = (candidato.tm_year + 1900) * 10000UL +
                   (candidato.tm_mon + 1) * 100 + candidato.tm_mday;
    if (siguiente > ahora && dia != ultimoDia && (cfg.dias & (1 << candidato.tm_wday))) return siguiente;
  }
  return 0;
}

void enviarEstado() {
  if (!proteger()) return;
  time_t ahora = time(nullptr);
  struct tm t;
  char reloj[16] = "Sin sincronizar";
  if (obtenerHora(t)) strftime(reloj, sizeof(reloj), "%H:%M:%S", &t);

  uint32_t restante = 0;
  if (releEncendido) {
    uint32_t transcurrido = millis() - inicioEncendido;
    if (transcurrido < duracionMs()) {
      restante = (duracionMs() - transcurrido + 999) / 1000;
    }
  }

  char horaProg[6];
  formatearHora(cfg.minuto, horaProg, sizeof(horaProg));

  char json[384];
  snprintf(json, sizeof(json),
    "{\"encendido\":%s,\"restante\":%lu,\"hora\":\"%s\","
    "\"horaProgramada\":\"%s\",\"programacionActiva\":%s,"
    "\"dias\":%u,\"duracion\":%u,\"ahora\":%lu,\"proxima\":%lu}",
    releEncendido ? "true" : "false",
    (unsigned long)restante, reloj, horaProg,
    cfg.activa ? "true" : "false",
    cfg.dias, cfg.duracionSeg, (unsigned long)ahora, (unsigned long)proximaAlarma(ahora));

  servidor.sendHeader("Cache-Control", "no-store");
  servidor.send(200, "application/json", json);
}

void encenderManual() {
  if (!proteger()) return;
  encenderRele();
  enviarEstado();
}

void apagarManual() {
  if (!proteger()) return;
  apagarRele();
  enviarEstado();
}

void guardarProgramacion() {
  if (!proteger()) return;
  if (nubeConfigurada()) {
    servidor.send(409, "text/plain", "Edita la alarma desde la web de Vercel");
    return;
  }
  uint16_t minuto;
  if (!parseHora(servidor.arg("hora"), minuto)) {
    servidor.send(400, "text/plain", "Hora invalida");
    return;
  }

  int dias = servidor.arg("dias").toInt();
  int duracion = servidor.arg("duracion").toInt();
  bool activa = servidor.arg("activo") == "1";

  if (dias < 0 || dias > 0x7F || (activa && dias == 0)) {
    servidor.send(400, "text/plain", "Dias invalidos");
    return;
  }
  if (duracion < 1 || duracion > 3600) {
    servidor.send(400, "text/plain", "Duracion invalida (1-3600 s)");
    return;
  }

  // Si cambia la hora, permitir que dispare de nuevo hoy
  if (minuto != cfg.minuto) {
    ultimoDia = 0;
    memoria.putUInt("ultimoDia", 0);
  }

  cfg.minuto = minuto;
  cfg.dias = dias;
  cfg.activa = activa;
  cfg.duracionSeg = duracion;
  guardarConfig();

  char buf[6];
  formatearHora(cfg.minuto, buf, sizeof(buf));
  Serial.printf("Programacion: %s, dias=0x%02X, %us, activa=%d\n",
                buf, cfg.dias, cfg.duracionSeg, cfg.activa);

  revisarHorario();
  enviarEstado();
}

// ===================================
// SINCRONIZACION CON VERCEL
// ===================================
void publicarEstadoNube() {
  if (!colaEstado) return;
  struct tm t;
  if (!obtenerHora(t)) return;
  char reloj[9], hora[6];
  strftime(reloj, sizeof(reloj), "%H:%M:%S", &t);
  formatearHora(cfg.minuto, hora, sizeof(hora));
  uint32_t transcurrido = millis() - inicioEncendido;
  uint32_t restante = releEncendido && transcurrido < duracionMs()
    ? (duracionMs() - transcurrido + 999) / 1000 : 0;
  CloudSnapshot estado;
  snprintf(estado.body, sizeof(estado.body),
    "proto=2&hora=%s&activo=%u&dias=%u&duracion=%u&revision=%s&ack=%s&reloj=%s&encendido=%u&restante=%lu&proxima=%lu&evento=%s&eventoHora=%lu",
    hora, cfg.activa, cfg.dias, cfg.duracionSeg, revisionNube, ultimoComando,
    reloj, releEncendido, (unsigned long)restante, (unsigned long)proximaAlarma(time(nullptr)), ultimaActivacion, ultimaActivacionHora);
  xQueueOverwrite(colaEstado, &estado);
}


void tareaNube(void*) {
  for (;;) {
    CloudSnapshot estado;
    if (WiFi.status() == WL_CONNECTED && time(nullptr) >= EPOCH_MINIMO_VALIDO &&
        xQueuePeek(colaEstado, &estado, 0) == pdTRUE) {
      WiFiClientSecure cliente;
      cliente.setCACert(CLOUD_ROOT_CA);
      cliente.setHandshakeTimeout(10);
      HTTPClient http;
      http.setConnectTimeout(10000);
      // El almacenamiento remoto puede tardar hasta 7 s; dejar margen a Vercel.
      http.setTimeout(10000);
      String url = String(TIMBRE_CLOUD_URL) + "/api/sync";
      if (url.startsWith("https://") && http.begin(cliente, url)) {
        http.addHeader("Authorization", String("Bearer ") + TIMBRE_DEVICE_TOKEN);
        http.addHeader("Content-Type", "application/x-www-form-urlencoded");
        int codigo = http.POST(String(estado.body));
        if (codigo == 200) {
          String respuesta = http.getString();
          SchoolUpdate cambio = {};
          if (parseHorarioEscolar(respuesta.c_str(), cambio)) {
            xQueueOverwrite(colaNube, &cambio);
          } else Serial.println("Respuesta de nube invalida");
        } else if (codigo < 0) {
          Serial.printf("Fallo de conexion a nube (%d): %s. WiFi: %s, RSSI: %ld dBm\n",
            codigo, HTTPClient::errorToString(codigo).c_str(),
            WiFi.status() == WL_CONNECTED ? "conectado" : "desconectado",
            (long)WiFi.RSSI());
          char detalleTLS[160] = {};
          int errorTLS = cliente.lastError(detalleTLS, sizeof(detalleTLS));
          if (errorTLS) Serial.printf("Error TLS (%d): %s\n", errorTLS, detalleTLS);
        } else Serial.printf("Nube no disponible (HTTP %d)\n", codigo);
        http.end();
      }
    }
    vTaskDelay(pdMS_TO_TICKS(5000));
  }
}

void aplicarNube() {
  if (!colaNube) return;
  SchoolUpdate cambio;
  if (xQueueReceive(colaNube, &cambio, 0) != pdTRUE) return;
  if (strcmp(revisionNube, cambio.revision) != 0) {
    SchoolProgram nueva = {};
    nueva.magic = SCHOOL_MAGIC;
    nueva.cantidad = cambio.cantidad;
    nueva.duracionManual = cambio.duracion;
    strlcpy(nueva.revision, cambio.revision, sizeof(nueva.revision));
    for (unsigned i = 0; i < nueva.cantidad; ++i) {
      nueva.timbres[i] = cambio.timbres[i];
      for (unsigned j = 0; j < escuela.cantidad; ++j) {
        if (escuela.timbres[j].id == nueva.timbres[i].id && escuela.timbres[j].minuto == nueva.timbres[i].minuto)
          nueva.timbres[i].ultimoDia = escuela.timbres[j].ultimoDia;
      }
    }
    if (memoria.putBytes("escuelaV2", &nueva, sizeof(nueva)) != sizeof(nueva)) {
      Serial.println("No se pudo guardar el horario escolar");
      return;
    }
    escuela = nueva;
    modoEscolar = true;
    cfg.duracionSeg = nueva.duracionManual;
    strlcpy(revisionNube, cambio.revision, sizeof(revisionNube));
    Serial.printf("Horarios escolares sincronizados: %u timbres\n", escuela.cantidad);
    revisarHorario();
  }
  if (cambio.accion && idNubeValido(cambio.comando) && strcmp(ultimoComando, cambio.comando) != 0) {
    // Persistir antes de accionar: una respuesta repetida o reinicio no repite el timbre.
    strlcpy(ultimoComando, cambio.comando, sizeof(ultimoComando));
    memoria.putString("cloudCmd", ultimoComando);
    if ((unsigned long)time(nullptr) < cambio.vence) {
      if (cambio.accion == 1) encenderRele();
      else apagarRele();
    }
  }
  publicarEstadoNube();
}

// ===================================
// SETUP
// ===================================
void setup() {
  Serial.begin(115200);

  // Preparar el nivel de reposo antes de habilitar la salida.
  digitalWrite(PIN_RELE, RELE_NIVEL_INACTIVO);
  pinMode(PIN_RELE, OUTPUT);
  digitalWrite(PIN_RELE, RELE_NIVEL_INACTIVO);

  digitalWrite(PIN_LED_AZUL, LED_AZUL_NIVEL_INACTIVO);
  pinMode(PIN_LED_AZUL, OUTPUT);
  digitalWrite(PIN_LED_AZUL, LED_AZUL_NIVEL_INACTIVO);

  memoria.begin("luces", false);
  cargarConfig();
  cargarHorarioEscolar();
  cantidadRedesUsuario = memoria.getUChar("wcount", 0);
  if (cantidadRedesUsuario > 4) cantidadRedesUsuario = 4;
  for (size_t i = 0; i < cantidadRedesUsuario; ++i) {
    char ssidKey[8], passKey[8];
    snprintf(ssidKey, sizeof(ssidKey), "wssid%u", (unsigned)i);
    snprintf(passKey, sizeof(passKey), "wpass%u", (unsigned)i);
    redesUsuarioSSID[i] = memoria.getString(ssidKey, "");
    redesUsuarioClave[i] = memoria.getString(passKey, "");
  }

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  // Los reintentos se gestionan aqui para alternar entre todas las redes.
  WiFi.setAutoReconnect(false);
  intentarSiguienteRedWiFi();

  Serial.print("Conectando al WiFi");
  uint32_t inicio = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - inicio < TIMEOUT_WIFI_INICIAL) {
    delay(500);
    mantenerWiFi();
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) iniciarPortalWiFi();
  ultimoIntentoWiFi = millis();

  // Hora de Peru por NTP
  configTzTime(ZONA_HORARIA, "pool.ntp.org", "time.google.com");

  // Cabeceras necesarias para la sesion y las solicitudes de la interfaz.
  const char* cabeceras[] = {"Cookie", "X-Timbre-Request"};
  servidor.collectHeaders(cabeceras, 2);

  // Rutas web
  servidor.on("/", HTTP_GET, []() {
    servidor.sendHeader("Cache-Control", "no-store");
    if (portalWiFiActivo) {
      enviarPortalWiFi();
      return;
    }
    // Con Vercel configurado, abre la interfaz actual del sistema en producción.
    // La interfaz embebida antigua queda disponible explícitamente en /local.
    if (nubeConfigurada()) {
      servidor.sendHeader("Location", TIMBRE_CLOUD_URL, true);
      servidor.send(302, "text/plain; charset=utf-8", "Abriendo la interfaz de Vercel");
      return;
    }
    servidor.send_P(200, "text/html; charset=utf-8", PAGINA);
  });
  servidor.on("/local", HTTP_GET, []() {
    servidor.sendHeader("Cache-Control", "no-store");
    servidor.send_P(200, "text/html; charset=utf-8", PAGINA);
  });
  servidor.on("/wifi", HTTP_GET, enviarPortalWiFi);
  servidor.on("/wifi/guardar", HTTP_POST, guardarRedWiFi);
  servidor.on("/login", HTTP_POST, iniciarSesion);
  servidor.on("/logout", HTTP_POST, cerrarSesion);
  servidor.on("/estado", HTTP_GET, enviarEstado);
  servidor.on("/encender", HTTP_POST, encenderManual);
  servidor.on("/apagar", HTTP_POST, apagarManual);
  servidor.on("/programar", HTTP_POST, guardarProgramacion);
  servidor.onNotFound([]() {
    if (portalWiFiActivo) {
      servidor.sendHeader("Location", "http://192.168.4.1/wifi", true);
      servidor.send(302, "text/plain", "Portal de configuración Wi-Fi");
      return;
    }
    servidor.send(404, "text/plain", "No encontrado");
  });
  servidor.begin();

  if (nubeConfigurada()) {
    colaEstado = xQueueCreate(1, sizeof(CloudSnapshot));
    colaNube = xQueueCreate(1, sizeof(SchoolUpdate));
    if (colaEstado && colaNube) {
      if (xTaskCreate(tareaNube, "vercel", 12288, nullptr, 1, nullptr) != pdPASS)
        Serial.println("No se pudo iniciar sincronizacion con Vercel");
    } else Serial.println("Memoria insuficiente para sincronizacion con Vercel");
  }
  Serial.println("Servidor iniciado");
}

// ===================================
// LOOP
// ===================================
void loop() {
  servidor.handleClient();
  revisarApagado();
  aplicarNube();
  mantenerWiFi();

  if (millis() - ultimaRevision >= INTERVALO_HORARIO) {
    ultimaRevision = millis();
    revisarHorario();
    publicarEstadoNube();
  }
}
