import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { AlarmList } from './AlarmList.jsx';
import { leerJson } from './apiResponse.js';
import { activationTracker } from './activation.js';
let nuevaActivacion = activationTracker();
const $ = id => document.getElementById(id);
const listaRoot = createRoot($('lista'));
const DIAS = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'], DIAS_COMPLETOS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'], ORDEN = [1,2,3,4,5,6,0];
let datos = null, autenticado = false, ocupado = false, filtro = -1, editId = null, editBase = null, generacion = 0;
let dispositivoActual = localStorage.getItem('timbre_dispositivo') || '';
let configNivel = null;
let avisoGuardado = null;
const avisosConexionAceptados = new Set();
let esperaManual = null, timerManual = null;
$('dias').innerHTML = ORDEN.map(d => `<label class="day"><input type="checkbox" data-dia="${d}" aria-label="${DIAS[d]}" aria-describedby="editorError"><span>${['D','L','M','X','J','V','S'][d]}</span></label>`).join('');
$('diasGlobales').innerHTML = ORDEN.map(d => `<button type="button" data-dia-global="${d}" aria-pressed="true">${DIAS[d]}</button>`).join('');
$('deviceSelector').value = dispositivoActual;
$('filtros').innerHTML = [-1,...ORDEN].map(d => `<button data-filtro="${d}" aria-pressed="${d===-1}">${d===-1?'Todos':DIAS[d]}</button>`).join('');
function escribirAviso(id, texto, tipo = 'info') {
 const aviso = $(id);
 if (aviso.textContent !== texto) aviso.textContent = texto;
 aviso.dataset.tipo = tipo;
 if (id === 'avisoConexion') {
  $('avisoConexionPanel').dataset.tipo = tipo;
  $('avisoConexionPanel').hidden = !texto || avisosConexionAceptados.has(tipo);
 }
}
function limpiarError(formulario, aviso) {
 $(formulario).querySelectorAll('[aria-invalid]').forEach(campo => campo.removeAttribute('aria-invalid'));
 escribirAviso(aviso, '');
}
function mostrarError(error, aviso = 'alerta', campo = null) {
 if (error.sesionCerrada) return;
 if (aviso === 'alerta') { avisoGuardado = null; escribirAviso('mensaje', ''); }
 escribirAviso(aviso, error.message || error, 'error');
 if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.focus(); }
}
$('aceptarAvisoConexion').onclick = () => {
 avisosConexionAceptados.add($('avisoConexion').dataset.tipo);
 $('avisoConexionPanel').hidden = true;
 $('estadoBreve').focus({ preventScroll: true });
};
function mostrarLogin(mensaje = '', tipo = 'info') {
 ocultarClave();
 avisosConexionAceptados.clear();
 clearTimeout(timerManual); esperaManual = null; $('avisoManual').hidden = true;
 nuevaActivacion = activationTracker();
 escribirAviso('avisoActivacion', '');
 generacion++; autenticado=false; datos=null; avisoGuardado=null;
 $('duracionManual').value='';
 $('app').hidden=true; $('login').hidden=false; $('conexion').hidden=true;
 $('confirmacion').close(); $('editor').close(); $('clave').value='';
 limpiarError('loginForm', 'loginError');
 escribirAviso('loginInfo', tipo === 'info' ? mensaje : '');
 if (tipo === 'error') escribirAviso('loginError', mensaje, 'error');
 for (const id of ['mensaje','alerta','avisoConexion']) escribirAviso(id, '');
 $('usuario').focus();
}
async function pedir(url, body) {
 const g = generacion;
 const ctrl=new AbortController(), timer=setTimeout(()=>ctrl.abort(),10000);
 let respuestaRecibida = false;
 try {
  const scoped = ['/login','/logout','/cambiar-clave','/administracion','/cuenta','/crear-nivel','/crear-colegio','/estado-cuenta','/renovar-token'].includes(url) || !dispositivoActual ? '' : `?device=${encodeURIComponent(dispositivoActual)}`;
  const r=await fetch('/api'+url+scoped,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'X-Timbre-Request':'1'},body:body===undefined?undefined:new URLSearchParams(body),cache:'no-store',signal:ctrl.signal});
  respuestaRecibida = true;
  if(r.status===401){
   const error = new Error(url === '/login' ? 'Usuario o contraseña incorrectos. Revisa tus datos e inténtalo de nuevo.' : 'Tu sesión venció. Vuelve a ingresar para continuar.');
   if (url !== '/login') { error.sesionCerrada=true; if (g === generacion) mostrarLogin(autenticado ? error.message : '', 'error'); }
   throw error;
  }
  if(!r.ok){
   const texto = r.status >= 500 ? 'El servicio no está disponible en este momento. Espera un momento y vuelve a intentar.' : r.status === 429 ? 'Demasiados intentos. Espera 10 minutos antes de volver a intentar.' : await r.text();
   throw new Error(texto || 'No se pudo completar la acción. Vuelve a intentar.');
  }
  return await leerJson(r);
 }catch(e){
  if(import.meta.env.DEV)console.error(`[api-client] ${url}${respuestaRecibida?' (respuesta recibida)':''}:`,e);
  if(e.name==='AbortError'||(!respuestaRecibida&&e instanceof TypeError))throw new Error('No se pudo conectar. Vuelve a intentar.');
  throw e;
 }finally{clearTimeout(timer);}
}
function renderLista() {
 const all=datos?.alarmas||[], list=all.filter(a=>filtro<0||(a.dias&(1<<filtro))).sort((a,b)=>a.hora.localeCompare(b.hora));
 $('contador').textContent=`${all.length} de 32 horarios · ${all.filter(a=>a.activa).length} activos`;
 listaRoot.render(createElement(AlarmList, { alarmas: list, ocupado, onEdit: editar, onToggle: alternar }));
 $('vacio').hidden=!!list.length;$('vacioTitulo').textContent=all.length?'Sin timbres para este día':'Tu jornada empieza aquí';
 $('vacioTexto').textContent=all.length?'Agrega un horario o selecciona otro día de la semana.':'Agrega los timbres de entrada, recreo y salida.';
 document.querySelectorAll('[data-filtro]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.filtro)===filtro)));
 renderDiasGlobales();
}
function renderDiasGlobales() {
 const suspendidos = Number(datos?.diasSuspendidos) || 0;
 const diasEnPausa = ORDEN.filter(d => suspendidos & (1 << d));
 document.querySelectorAll('[data-dia-global]').forEach(b => {
  const dia = Number(b.dataset.diaGlobal), suspendido = !!(suspendidos & (1 << dia));
  b.setAttribute('aria-pressed', String(!suspendido));
  b.disabled = ocupado || !datos;
  b.title = `${DIAS_COMPLETOS[dia]}: ${suspendido ? 'alarmas suspendidas; toca para reactivar' : 'habilitado; toca para suspender todas sus alarmas'}`;
 });
 $('estadoDiasGlobales').textContent = diasEnPausa.length
  ? `Alarmas suspendidas: ${diasEnPausa.map(d => DIAS[d]).join(', ')}`
  : 'Todos los días están habilitados.';
}
function pintar(d) {
 if(Array.isArray(d.dispositivos)){
  const opciones=d.dispositivos;
  const actual=Array.from($('deviceSelector').options).map(o=>`${o.value}:${o.textContent}`).join('|');
  const nuevas=opciones.map(o=>`${o.id}:${o.name}`).join('|');
  if(actual!==nuevas)$('deviceSelector').replaceChildren(...opciones.map(o=>new Option(o.name,o.id)));
  if(!opciones.some(o=>o.id===dispositivoActual))dispositivoActual=d.dispositivo||opciones[0]?.id||'';
  $('deviceSelector').value=dispositivoActual;
  if(dispositivoActual)localStorage.setItem('timbre_dispositivo',dispositivoActual);
 }
 if (esperaManual && d.ultimoComando === esperaManual) {
  terminarEsperaManual('Orden recibida por la placa', 'La placa confirmó la recepción de tu solicitud.', 'success');
 } else if (esperaManual && d.orden && d.orden.id !== esperaManual) {
  terminarEsperaManual('La solicitud fue reemplazada', 'Se recibió otra orden. No se pudo confirmar esta solicitud.', 'warning');
 }
 if (nuevaActivacion(d)) {
  const hora = new Intl.DateTimeFormat('es-PE', {timeZone:'America/Lima', hour:'2-digit', minute:'2-digit', second:'2-digit'}).format(new Date((d.ultimaActivacion?.hora || d.ahora) * 1000));
  escribirAviso('avisoActivacion', `Timbre activado · ${hora}. La placa confirmó la activación.`, 'success');
  if (document.visibilityState === 'visible' && typeof navigator.vibrate === 'function') {
   try { navigator.vibrate([200, 100, 200]); } catch { /* La confirmación visual sigue disponible. */ }
  }
 }
 datos=d;autenticado=true;$('estadoBreve').textContent=d.online?(d.encendido?'Sonando':'En línea'):'Sin conexión';$('estadoBreve').classList.toggle('offline',!d.online);$('estadoBreve').classList.toggle('online',d.online);$('login').hidden=true;$('app').hidden=false;$('conexion').hidden=true;
 const esSuperadmin=d.user?.role==='superadmin';$('tabAdmin').hidden=!esSuperadmin;if(!esSuperadmin&&!$('panelAdmin').hidden)$('tabAlarmas').click();
 $('estado').textContent=!d.online?'Timbre sin conexión':d.encendido?`Sonando · ${d.restante} s restantes`:'Timbre conectado';
 $('punto').classList.toggle('on',d.online);$('actualizacion').hidden=!d.requiereActualizacion;
 $('nube').textContent=!d.tokenConfigurado?'Falta registrar el token de esta placa en el servidor.':d.requiereActualizacion?'Actualiza la placa para sincronizar los horarios escolares.':!d.online?'Los cambios quedan pendientes hasta que se conecte la placa.':d.pendiente?'Horarios guardados. Esperando confirmación de la placa…':d.ordenPendiente?'Orden enviada. Esperando confirmación…':'Todos los horarios están sincronizados.';
 $('reloj').textContent='Reloj de la placa · '+d.hora;
 if (!$('duracionManual').value) $('duracionManual').value = d.duracion;
 actualizarDuracionManual();
 const active=d.alarmas.filter(a=>a.activa);
 $('avisoEstado').hidden=d.online&&!d.pendiente&&!d.ordenPendiente&&!d.requiereActualizacion;
 $('punto').classList.toggle('ringing',d.online&&d.encendido);
 if(!active.length){$('proxima').textContent='Sin timbres activos';$('fecha').textContent='Agrega un horario o activa uno de la lista.';}
 else if(!d.online||d.pendiente||d.requiereActualizacion||!d.proxima){$('proxima').textContent=`${active.length} ${active.length===1?'horario activo':'horarios activos'}`;$('fecha').textContent='La próxima ejecución se confirma al sincronizar la placa.';}
 else {
  const minutes=Math.max(1,Math.ceil((d.proxima-d.ahora)/60)),hours=Math.floor(minutes/60),rest=minutes%60;
  $('proxima').textContent='Alarma dentro de '+(hours?`${hours} ${hours===1?'hora':'horas'} `:'')+(rest?`${rest} ${rest===1?'minuto':'minutos'}`:'');
  const next=new Date(d.proxima*1000), hm=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(next);
  const day=new Date(next.getTime()-5*3600000).getUTCDay(), bell=active.find(a=>a.hora===hm&&(a.dias&(1<<day)));
  $('proxima').textContent=hm+(bell?' · '+bell.nombre:'');
  $('fecha').textContent='En '+(hours?`${hours} h `:'')+(rest?`${rest} min`:'')+' · '+new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12:true}).format(next);
 }
 avisosConexionAceptados.delete('error');
 if (d.online) avisosConexionAceptados.delete('warning');
 escribirAviso('avisoConexion', d.online ? '' : 'El timbre está sin conexión. Puedes seguir guardando horarios; se aplicarán cuando vuelva a conectarse.', 'warning');
 if (avisoGuardado) {
  if (avisoGuardado.revision !== d.revision) { avisoGuardado=null; escribirAviso('mensaje', 'La lista de horarios se ha actualizado.'); }
  else mostrarGuardado(d);
 }
 renderLista();controles();
}
function controles() {
 document.querySelectorAll('[data-editor-tab]').forEach(button => { button.disabled = ocupado; });
 for (const id of ['nuevo','nuevoVacio','guardar','salir','cancelar','cerrarEditor','eliminarEditor','cancelarEliminar','confirmarEliminar']) $(id).disabled=ocupado;
 $('nuevo').disabled=ocupado||(datos?.alarmas.length>=32);
 $('nuevoVacio').disabled=$('nuevo').disabled;
 for (const id of ['probar','duracionManual']) $(id).disabled=ocupado||!datos?.online;
 $('probar').disabled ||= !!esperaManual;
 renderLista();
 $('alarmForm').setAttribute('aria-busy',String(ocupado));
 $('guardar').textContent=ocupado?'Guardando…':'Guardar horario';
 $('confirmarEliminar').textContent=ocupado?'Eliminando…':'Eliminar horario';
}
async function consultar() {
 const g=generacion;
 if (!ocupado&&!$('entrar').disabled&&(autenticado||$('login').hidden)) {
  try {
   const d=await pedir('/estado');
   if(g===generacion&&!ocupado){pintar(d);if(d.user?.role==='superadmin')cargarAdministracion();}
  } catch(e) {
   if(g===generacion&&!ocupado) {
    if(autenticado) {
     escribirAviso('avisoConexion','No se pudo conectar con el servicio. Revisa tu conexión; volveremos a intentarlo automáticamente.','error');
     $('estado').textContent='Sin conexión con el servidor';
     $('estadoBreve').textContent='Sin conexión';
     $('estadoBreve').classList.add('offline');
     $('estadoBreve').classList.remove('online');
     $('punto').classList.remove('on','ringing');
     $('avisoEstado').hidden=false;
     if(datos)datos.online=false;
     controles();
    } else if($('login').hidden) escribirAviso('conexion',e.message,'error');
   }
  }
 }
 setTimeout(consultar,esperaManual ? 2000 : 10000);
}
for (const [formulario, aviso] of [['loginForm','loginError'],['alarmForm','editorError']]) {
 $(formulario).noValidate=true;
 $(formulario).addEventListener('input',()=>limpiarError(formulario,aviso));
}
function ocultarClave() {
 $('clave').type = 'password';
 $('mostrarClave').textContent = 'Mostrar';
 $('mostrarClave').setAttribute('aria-pressed', 'false');
 $('mostrarClave').setAttribute('aria-label', 'Mostrar contraseña');
}
$('mostrarClave').onclick = () => {
 const mostrar = $('clave').type === 'password';
 $('clave').type = mostrar ? 'text' : 'password';
 $('mostrarClave').textContent = mostrar ? 'Ocultar' : 'Mostrar';
 $('mostrarClave').setAttribute('aria-pressed', String(mostrar));
 $('mostrarClave').setAttribute('aria-label', mostrar ? 'Ocultar contraseña' : 'Mostrar contraseña');
};
$('deviceSelector').onchange=async()=>{
 if (ocupado) { $('deviceSelector').value=dispositivoActual; return; }
 dispositivoActual=$('deviceSelector').value;
 localStorage.setItem('timbre_dispositivo',dispositivoActual);
 generacion++; datos=null; avisoGuardado=null; esperaManual=null; clearTimeout(timerManual);
 $('avisoManual').hidden=true; nuevaActivacion=activationTracker(); filtro=-1;
 escribirAviso('mensaje',''); escribirAviso('alerta','');
 $('estado').textContent='Conectando…'; $('estadoBreve').textContent='Conectando';
 const g=generacion;
 try { const d=await pedir('/estado'); if(g===generacion)pintar(d); } catch(e) { if(g===generacion)mostrarError(e); }
};
$('loginForm').onsubmit=async e=>{
 e.preventDefault();if($('entrar').disabled)return;
 limpiarError('loginForm','loginError');escribirAviso('loginInfo','');
 const usuario=$('usuario').value.trim(),clave=$('clave').value;
 if(!usuario)return mostrarError('Escribe tu usuario.','loginError',$('usuario'));
 if(!clave.trim())return mostrarError('Escribe tu contraseña.','loginError',$('clave'));
 generacion++;$('entrar').disabled=true;$('entrar').textContent='Ingresando…';$('loginForm').setAttribute('aria-busy','true');
 try{await pedir('/login',{usuario,clave});$('clave').value='';ocultarClave();dispositivoActual='';localStorage.removeItem('timbre_dispositivo');generacion++;pintar(await pedir('/estado'));}
 catch(e){mostrarError(e,'loginError');}
 finally{$('entrar').disabled=false;$('entrar').textContent='Iniciar sesión';$('loginForm').setAttribute('aria-busy','false');}
};
$('salir').onclick=async()=>{if(ocupado)return;ocupado=true;generacion++;controles();try{await pedir('/logout',{});mostrarLogin('Cerraste sesión correctamente.');}catch(e){mostrarError(e);}finally{ocupado=false;controles();}};
function resumirDias(){
 const seleccion=ORDEN.filter(d=>document.querySelector(`[data-dia="${d}"]`).checked);
 $('resumenDias').textContent=seleccion.length===7?'Todos los días':seleccion.length?'Cada '+seleccion.map(d=>DIAS[d]).join(', '):'Selecciona los días';
}
function seleccionarDias(mask){document.querySelectorAll('[data-dia]').forEach(c=>c.checked=!!(mask&(1<<c.dataset.dia)));resumirDias();limpiarError('alarmForm','editorError');}
$('dias').addEventListener('change',resumirDias);
function editar(id=null){if(!datos||ocupado)return;editBase=structuredClone(datos);editId=id;const a=datos.alarmas.find(a=>a.id===id)||{nombre:'',hora:'07:30',duracion:5,dias:filtro<0?62:1<<filtro,activa:true};$('eliminarEditor').hidden=!id;$('tituloEditor').textContent=id?'Editar timbre':'Nuevo timbre';$('nombre').value=a.nombre;[$('horas').value,$('minutos').value]=a.hora.split(':');$('duracion').value=a.duracion;$('activo').checked=a.activa;seleccionarDias(a.dias);$('editorError').textContent='';$('editor').showModal();}
$('nuevo').onclick=()=>editar();$('nuevoVacio').onclick=()=>editar();
$('cancelar').onclick=$('cerrarEditor').onclick=()=>{if(!ocupado)$('editor').close();};$('editor').addEventListener('cancel',e=>{if(ocupado)e.preventDefault();});
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>seleccionarDias(Number(b.dataset.preset)));
$('filtros').onclick=e=>{const b=e.target.closest('[data-filtro]');if(b){filtro=Number(b.dataset.filtro);renderLista();}};
$('diasGlobales').onclick=e=>{const b=e.target.closest('[data-dia-global]');if(b)alternarDiaGlobal(Number(b.dataset.diaGlobal));};
function mostrarGuardado(d) {
 const pendiente=d.pendiente||!d.online||d.requiereActualizacion;
 const detalle=d.requiereActualizacion?'Actualiza la placa para aplicar los horarios.':!d.online?'El timbre está sin conexión; los cambios se aplicarán al reconectarse.':d.pendiente?'Esperando confirmación de la placa.':'La placa confirmó los cambios.';
 escribirAviso('mensaje', `${avisoGuardado.texto} ${detalle}`, pendiente?'warning':'success');
}
async function guardarLista(list,base,texto='Horario guardado.'){
 ocupado=true;generacion++;avisoGuardado=null;escribirAviso('alerta','');escribirAviso('mensaje','');controles();
 try{const d=await pedir('/programar',{alarmas:JSON.stringify(list),revision:base.revision||'-'});avisoGuardado={revision:d.revision,texto};pintar(d);}
 finally{ocupado=false;controles();}
}
async function alternarDiaGlobal(dia) {
 if (ocupado || !datos || dia < 0 || dia > 6) return;
 const mascaraActual = Number(datos.diasSuspendidos) || 0;
 const bit = 1 << dia, suspender = !(mascaraActual & bit);
 const diasSuspendidos = suspender ? mascaraActual | bit : mascaraActual & ~bit;
 ocupado = true; generacion++; avisoGuardado = null;
 escribirAviso('alerta',''); escribirAviso('mensaje',''); controles();
 try {
  const d = await pedir('/programar', {diasSuspendidos, revision:datos.revision || '-'});
  avisoGuardado = {revision:d.revision, texto:`Alarmas del ${DIAS_COMPLETOS[dia]} ${suspender?'suspendidas':'reactivadas'}.`};
  pintar(d);
 } catch(e) { mostrarError(e); }
 finally { ocupado = false; controles(); }
}
$('alarmForm').onsubmit=async e=>{
 e.preventDefault();if(ocupado||!editBase)return;limpiarError('alarmForm','editorError');
 const nombre=$('nombre').value.trim(),h=$('horas').value.trim(),m=$('minutos').value.trim(),duracion=Number($('duracion').value);
 if(!nombre||nombre.length>40)return mostrarError('Escribe un nombre de 1 a 40 caracteres.','editorError',$('nombre'));
 if(!/^\d{1,2}$/.test(h)||Number(h)>23)return mostrarError('Escribe una hora de 00 a 23.','editorError',$('horas'));
 if(!/^\d{1,2}$/.test(m)||Number(m)>59)return mostrarError('Escribe los minutos de 00 a 59.','editorError',$('minutos'));
 if(!Number.isInteger(duracion)||duracion<1||duracion>3600)return mostrarError('Escribe una duración de 1 a 3600 segundos, sin decimales.','editorError',$('duracion'));
 let dias=0;document.querySelectorAll('[data-dia]').forEach(c=>{if(c.checked)dias|=1<<c.dataset.dia;});
 const a={id:editId||Array.from(crypto.getRandomValues(new Uint8Array(4)),b=>b.toString(16).padStart(2,'0')).join(''),nombre,hora:h.padStart(2,'0')+':'+m.padStart(2,'0'),dias,duracion,activa:$('activo').checked};
 if(a.activa&&!dias)return mostrarError('Selecciona al menos un día para activar el timbre.','editorError',document.querySelector('[data-dia]'));
 const repetido=editBase.alarmas.find(x=>x.id!==a.id&&a.activa&&x.activa&&x.hora===a.hora&&(x.dias&a.dias));
 if(repetido)return mostrarError(`El horario coincide con «${repetido.nombre}» a las ${a.hora}. Cambia la hora o los días.`,'editorError',$('horas'));
 const list=editId?editBase.alarmas.map(x=>x.id===editId?a:x):[...editBase.alarmas,a];
 try{await guardarLista(list,editBase);$('editor').close();}catch(e){mostrarError(e,'editorError');}
};
$('eliminarEditor').onclick=()=>{
 if(ocupado||!editId||!editBase)return;
 const a=editBase.alarmas.find(a=>a.id===editId);
 if(!a)return;
 $('detalleEliminar').textContent=`Vas a eliminar «${a.nombre}» de las ${a.hora}. Si lo necesitas después, tendrás que agregarlo de nuevo.`;
 escribirAviso('confirmacionError','');$('confirmacion').showModal();$('cancelarEliminar').focus();
};
$('cancelarEliminar').onclick=()=>{if(!ocupado)$('confirmacion').close();};
$('confirmacion').addEventListener('cancel',e=>{if(ocupado)e.preventDefault();});
$('confirmarEliminar').onclick=async()=>{
 if(ocupado||!editId||!editBase)return;
 escribirAviso('confirmacionError','');
 try{await guardarLista(editBase.alarmas.filter(x=>x.id!==editId),editBase,'Horario eliminado.');$('confirmacion').close();$('editor').close();}
 catch(e){mostrarError(e,'confirmacionError');}
};
async function alternar(id, checked) {
 if (ocupado) return;
 try { await guardarLista(datos.alarmas.map(a=>a.id===id?{...a,activa:checked}:a),datos,checked?'Horario activado.':'Horario desactivado.'); }
 catch(e) { mostrarError(e); renderLista(); }
}
function avisoManual(titulo, detalle, tipo, cargando = false) {
 const aviso = $('avisoManual');
 aviso.hidden = false;
 aviso.dataset.tipo = tipo;
 aviso.classList.toggle('loading', cargando);
 $('manualTitulo').textContent = titulo;
 $('manualDetalle').textContent = detalle;
}
function terminarEsperaManual(titulo, detalle, tipo) {
 clearTimeout(timerManual); esperaManual = null;
 avisoManual(titulo, detalle, tipo);
 controles();
}
async function manual(url) {
 if (ocupado || esperaManual) return;
 ocupado=true;generacion++;avisoGuardado=null;
 escribirAviso('alerta','');escribirAviso('mensaje','');controles();
 avisoManual('Enviando solicitud…', 'Conectando con el servicio del timbre.', 'info', true);
 try {
  const d = await pedir(url,url==='/encender'?{duracion:$('duracionManual').value}:{});
  esperaManual = d.orden?.id || null;
  if (!esperaManual) {
   avisoManual('Solicitud enviada', 'No se pudo obtener el identificador para confirmar la respuesta de la placa.', 'warning');
  } else {
   avisoManual('Prueba solicitada', 'Esperando la confirmación de la placa…', 'info', true);
   timerManual = setTimeout(() => terminarEsperaManual('Sin confirmación de la placa', 'No se recibió confirmación a tiempo. Revisa el estado del dispositivo antes de volver a intentar.', 'warning'), Math.max(0, d.orden.vence - d.ahora + 15) * 1000);
  }
  pintar(d);
 } catch(e) {
  clearTimeout(timerManual); esperaManual = null;
  if (!e.sesionCerrada) avisoManual('No se pudo confirmar la solicitud', e.message, 'error');
 } finally {ocupado=false;controles();}
}
function pintarAdministracion(resumen){
 const schools=resumen.colegios||[];
 for(const id of ['colegioNivel','colegioCuenta']){
  const select=$(id), previous=select.value;
  select.replaceChildren(...schools.map(school=>new Option(school.name,school.id)));
  if(schools.some(school=>school.id===previous))select.value=previous;
 }
 const boardSelect=$('dispositivoCuenta'),previousBoard=boardSelect.value;
 boardSelect.replaceChildren(...resumen.placas.map(placa=>new Option(`${placa.colegioNombre} · ${placa.nombreDispositivo}`,placa.dispositivo)));
 if(resumen.placas.some(placa=>placa.dispositivo===previousBoard))boardSelect.value=previousBoard;
 const schoolList=$('colegiosAdmin');schoolList.replaceChildren();
 const counts=new Map();for(const placa of resumen.placas){counts.set(placa.colegioNombre,(counts.get(placa.colegioNombre)||0)+1);}
 for(const school of schools){
  const row=document.createElement('div');row.className='admin-row';
  const name=document.createElement('strong');name.textContent=school.name;
  const count=document.createElement('span');count.textContent=`${counts.get(school.name)||0} placas`;
  const assistants=document.createElement('span');assistants.textContent=`${resumen.cuentas.filter(cuenta=>cuenta.colegio===school.name&&cuenta.active).length} auxiliares activos`;
  row.append(name,count,assistants);schoolList.append(row);
 }
 const placas=$('placasAdmin');placas.replaceChildren();
 for(const placa of resumen.placas){
  const card=document.createElement('article');card.className='admin-board-card';
  const title=document.createElement('h3');title.textContent=`${placa.colegioNombre} · ${placa.nombreDispositivo}`;
  const status=document.createElement('strong');status.className=placa.online?'admin-online':'admin-offline';status.textContent=placa.online?'Conectada':'Sin conexión';
  const last=document.createElement('p');last.className='small';last.textContent=placa.ultimaConexion?`Último reporte: ${new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',dateStyle:'short',timeStyle:'medium'}).format(new Date(placa.ultimaConexion*1000))}`:'Aún no reporta';
  const ring=document.createElement('p');ring.className='small';ring.textContent=placa.encendido?'Timbre sonando':`Firmware v${placa.firmwareVersion}`;
  const replace=document.createElement('button');replace.type='button';replace.className='secondary';replace.dataset.renovarToken=placa.dispositivo;replace.textContent=placa.tokenConfigurado?'Preparar placa de reemplazo':'Configurar token de placa';
  card.append(title,status,last,ring,replace);placas.append(card);
 }
 const cuentas=$('cuentasAdmin');cuentas.replaceChildren();
 if(!resumen.cuentas.length){cuentas.textContent='Todavía no hay cuentas adicionales.';}else for(const cuenta of resumen.cuentas){
  const row=document.createElement('div');row.className='admin-row';
  const name=document.createElement('strong');name.textContent=cuenta.username;
  const role=document.createElement('span');role.textContent='Administrador';
  const scope=document.createElement('span');scope.textContent=`${cuenta.colegio} · ${cuenta.alcance}`;
  const state=document.createElement('span');state.textContent=cuenta.active?'Activa':'Inactiva';
  const toggle=document.createElement('button');toggle.type='button';toggle.className='secondary';toggle.dataset.cuentaId=cuenta.id;toggle.dataset.cuentaActive=String(cuenta.active);toggle.textContent=cuenta.active?'Desactivar':'Activar';
  row.append(name,role,scope,state,toggle);cuentas.append(row);
 }
 const history=$('historialAdmin');history.replaceChildren();
 if(!resumen.historial.length){history.textContent='Todavía no hay actividad registrada.';}else for(const item of resumen.historial){
  const row=document.createElement('div');row.className='admin-row admin-event';
  const action=document.createElement('strong');action.textContent=item.action;
  const device=resumen.placas.find(placa=>placa.dispositivo===item.device);
  const detail=document.createElement('span');detail.textContent=[device?.colegioNombre,device?.nombreDispositivo,item.user==='sistema'?'':item.user,item.detail].filter(Boolean).join(' · ');
  const when=document.createElement('time');when.dateTime=new Date(item.time*1000).toISOString();when.textContent=new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',dateStyle:'short',timeStyle:'short'}).format(new Date(item.time*1000));
  row.append(action,detail,when);history.append(row);
 }
}
async function cargarAdministracion(){
 if(!autenticado||datos?.user?.role!=='superadmin')return;
 try{pintarAdministracion(await pedir('/administracion'));}catch(e){if(!e.sesionCerrada)$('historialAdmin').textContent=e.message;}
}
$('crearCuentaForm').onsubmit=async e=>{
 e.preventDefault();$('cuentaMensaje').textContent='';
 const scope=$('alcanceCuenta').value, assignment=scope==='nivel'?{dispositivoId:$('dispositivoCuenta').value}:{colegioId:$('colegioCuenta').value};
 try{await pedir('/cuenta',{...assignment,usuario:$('nuevoUsuario').value.trim(),clave:$('nuevaClaveCuenta').value});$('crearCuentaForm').reset();$('alcanceCuenta').onchange();$('cuentaMensaje').textContent=scope==='nivel'?'Usuario creado para ese nivel.':'Auxiliar creado para todo el colegio.';await cargarAdministracion();}
 catch(error){$('cuentaMensaje').textContent=error.message;}
};
$('alcanceCuenta').onchange=()=>{
 const nivel=$('alcanceCuenta').value==='nivel';$('asignarNivel').hidden=!nivel;$('asignarColegio').hidden=nivel;
 $('colegioCuenta').required=!nivel;$('dispositivoCuenta').required=nivel;
};
$('crearColegioForm').onsubmit=async e=>{
 e.preventDefault();$('colegioMensaje').textContent='';
 try{const result=await pedir('/crear-colegio',{nombre:$('nuevoColegio').value.trim(),usuario:$('usuarioColegio').value.trim(),clave:$('claveColegio').value});$('crearColegioForm').reset();$('colegioMensaje').textContent=`Colegio ${result.colegio.nombre} creado y asignado a ${result.auxiliar.usuario}.`;await cargarAdministracion();}
 catch(error){$('colegioMensaje').textContent=error.message;}
};
$('crearNivelForm').onsubmit=async e=>{
 e.preventDefault();$('nivelMensaje').textContent='';configNivel=null;$('configNivel').hidden=true;
 try{
  const creado=await pedir('/crear-nivel',{colegioId:$('colegioNivel').value,nombre:$('nuevoNivel').value.trim()});
  configNivel={nombre:creado.dispositivo.nombre,token:creado.token};
  $('crearNivelForm').reset();$('configNivel').hidden=false;
  $('nivelMensaje').textContent=`Nivel ${creado.dispositivo.nombre} creado en ${creado.dispositivo.colegio}. Descarga el archivo de configuración para la placa.`;
  await cargarAdministracion();
 }catch(error){$('nivelMensaje').textContent=error.message;}
};
$('cuentasAdmin').onclick=async e=>{
 const button=e.target.closest('[data-cuenta-id]');if(!button)return;
 const active=button.dataset.cuentaActive!=='true';
 if(!confirm(active?'¿Activar esta cuenta?':'¿Desactivar esta cuenta? El auxiliar perderá acceso al instante.'))return;
 try{await pedir('/estado-cuenta',{id:button.dataset.cuentaId,active:active?'1':'0'});await cargarAdministracion();}
 catch(error){$('cuentaMensaje').textContent=error.message;}
};
function descargarConfiguracion(config){
 if(!config)return;
 const contenido=`#pragma once\n// Configuracion privada de la placa ${config.nombre}.\n#define TIMBRE_CLOUD_URL "${location.origin}"\n#define TIMBRE_DEVICE_TOKEN "${config.token}"\n`;
 const url=URL.createObjectURL(new Blob([contenido],{type:'text/plain'})),link=document.createElement('a');
 link.href=url;link.download='cloud_config.h';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('descargarConfigNivel').onclick=()=>descargarConfiguracion(configNivel);
$('placasAdmin').onclick=async e=>{
 const button=e.target.closest('[data-renovar-token]');if(!button)return;
 if(!confirm('Esto invalidará el token anterior de esta placa. Descarga el archivo y cárgalo en la placa de reemplazo. ¿Continuar?'))return;
 button.disabled=true;
 try{const r=await pedir('/renovar-token',{dispositivo:button.dataset.renovarToken});descargarConfiguracion({nombre:r.dispositivo.nombre,token:r.token});await cargarAdministracion();}
 catch(error){$('historialAdmin').textContent=error.message;}
 finally{button.disabled=false;}
};
document.querySelectorAll('[data-panel]').forEach(button=>button.onclick=()=>{
 document.querySelector('.next').hidden=button.dataset.panel!=='panelAlarmas';
 document.querySelectorAll('[data-panel]').forEach(tab=>{const selected=tab===button;$(tab.dataset.panel).hidden=!selected;if(selected)tab.setAttribute('aria-current','page');else tab.removeAttribute('aria-current');});
 if(button.dataset.panel==='panelAdmin')cargarAdministracion();
});
document.querySelectorAll('[data-editor-tab]').forEach(button => {
 button.onclick = () => {
  if (ocupado) return;
  $('editor').close();
  const tab = $(button.dataset.editorTab);
  tab.click();
  tab.focus();
 };
});
function actualizarDuracionManual() {
 const input = $('duracionManual');
 const seconds = Number(input.value);
 $('manualInfo').textContent = input.value && input.checkValidity() ? `Se apagará automáticamente después de ${seconds} segundos. Esta duración se guarda al tocar el timbre.` : 'Elige entre 1 y 3600 segundos (máximo 1 hora).';
}
$('duracionManual').addEventListener('input', () => {
 $('duracionManual').removeAttribute('aria-invalid');
 escribirAviso('manualError', '');
 actualizarDuracionManual();
});
$('probar').onclick=()=>{
 const input = $('duracionManual');
 if (!input.value || !input.checkValidity()) return mostrarError('Escribe una duración de 1 a 3600 segundos, sin decimales.', 'manualError', input);
 escribirAviso('manualError', '');
 manual('/encender');
};
consultar();

$('abrirRecuperacion').onclick = () => $('recuperacion').showModal();
$('cerrarRecuperacion').onclick = () => $('recuperacion').close();
