const https = require('https');
const { PNG } = require('pngjs');
const nodemailer = require('nodemailer');

const obtenerConfiguracionUnifi = () => {
  const host = (process.env.UNIFI_HOST || '192.168.40.178').trim();
  const port = (process.env.UNIFI_PORT || '12445').trim();
  const token = (process.env.UNIFI_TOKEN || '').trim();
  const verifySsl =
    String(process.env.UNIFI_VERIFY_SSL || 'false').toLowerCase() === 'true';
  const puertaDefecto = (
    process.env.UNIFI_PUERTA_DEFECTO || 'e38b8776-8756-4817-8569-6ef2aafb69c7'
  ).trim();
  const ventanaSegundos = Number(process.env.UNIFI_VENTANA_SEGUNDOS) || 3600;
  const maxAccesos = Number(process.env.UNIFI_MAX_ACCESOS) || 2;
  const pollIntervalMs = Number(process.env.UNIFI_POLL_INTERVAL_MS) || 5000;

  return {
    baseUrl: `https://${host}:${port}/api/v1/developer`,
    token,
    verifySsl,
    puertaDefecto,
    ventanaSegundos,
    maxAccesos,
    pollIntervalMs,
  };
};

// Endpoints equivalentes a access.py
const EP_VISITORS = '/visitors';
const EP_DOORS = '/doors';
const EP_TOPOLOGY = '/door_groups/topology';
const EP_SYSTEM_LOGS = '/system/logs';
const VISIT_REASON_DEFECTO = 'Others';

/**
 * Realiza una petición HTTPS a la API Developer de UniFi Access (puerto 12445),
 * soportando certificados autofirmados locales y respuestas JSON o binarias (PNG).
 */
const peticionUnifi = (metodo, ruta, cuerpoJson = undefined) => {
  const { baseUrl, token, verifySsl } = obtenerConfiguracionUnifi();
  const urlCompleta = new URL(`${baseUrl.replace(/\/$/, '')}${ruta}`);

  const cuerpoSerializado =
    cuerpoJson !== undefined ? Buffer.from(JSON.stringify(cuerpoJson), 'utf8') : null;

  const cabeceras = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, image/png, */*',
  };

  if (cuerpoSerializado) {
    cabeceras['Content-Type'] = 'application/json';
    cabeceras['Content-Length'] = cuerpoSerializado.length;
  }

  const agenteHttps = new https.Agent({
    rejectUnauthorized: verifySsl,
  });

  return new Promise((resolver, rechazar) => {
    const solicitud = https.request(
      urlCompleta,
      {
        method: metodo,
        headers: cabeceras,
        agent: agenteHttps,
        timeout: 4000,
      },
      (respuesta) => {
        const fragmentos = [];
        respuesta.on('data', (fragmento) => fragmentos.push(fragmento));
        respuesta.on('end', () => {
          const bufferRespuesta = Buffer.concat(fragmentos);
          const codigoEstado = respuesta.statusCode || 500;
          const tipoContenido = String(respuesta.headers['content-type'] || '');

          if (codigoEstado === 401) {
            return rechazar(
              new Error('401 en UniFi Access: token UNIFI_TOKEN inválido o expirado.')
            );
          }

          if (codigoEstado >= 400) {
            const textoError = bufferRespuesta.toString('utf8').slice(0, 300);
            return rechazar(new Error(`Error ${codigoEstado} en ${ruta}: ${textoError}`));
          }

          if (!tipoContenido.includes('application/json')) {
            return resolver(bufferRespuesta);
          }

          try {
            const textoJson = bufferRespuesta.toString('utf8');
            const datos = textoJson ? JSON.parse(textoJson) : {};
            if (
              datos &&
              typeof datos === 'object' &&
              datos.code !== undefined &&
              datos.code !== null &&
              datos.code !== 'SUCCESS'
            ) {
              return rechazar(
                new Error(`API error en ${ruta}: ${datos.msg || ''} (${datos.code})`)
              );
            }
            return resolver(datos);
          } catch (errorParseo) {
            return rechazar(
              new Error(`Respuesta JSON inválida desde ${ruta}: ${errorParseo.message}`)
            );
          }
        });
      }
    );

    solicitud.on('timeout', () => {
      solicitud.destroy(new Error(`Tiempo de espera agotado conectando a ${urlCompleta.href}`));
    });

    solicitud.on('error', (errorRed) => {
      rechazar(new Error(`Fallo de conexión con UniFi Access (${urlCompleta.href}): ${errorRed.message}`));
    });

    if (cuerpoSerializado) {
      solicitud.write(cuerpoSerializado);
    }
    solicitud.end();
  });
};

/**
 * Divide un nombre_completo en { nombres, apellidos } para los campos
 * obligatorios first_name y last_name de UniFi Access.
 */
const dividirNombreCompleto = (nombreCompleto) => {
  const limpio = String(nombreCompleto || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!limpio) {
    return { nombres: 'Visitante', apellidos: 'Lira' };
  }
  const partes = limpio.split(' ');
  if (partes.length === 1) {
    return { nombres: partes[0], apellidos: '.' };
  }
  const mitad = Math.ceil(partes.length / 2);
  return {
    nombres: partes.slice(0, mitad).join(' '),
    apellidos: partes.slice(mitad).join(' '),
  };
};

/**
 * Equivalente exacto de _anadir_quiet_zone en access.py:
 * Escala el PNG (por defecto 2x con vecino más cercano / NEAREST para máxima nitidez)
 * y añade un margen blanco sólido (por defecto 48px) alrededor del código QR
 * para que la cámara del lector UniFi (ej. G3 Reader Pro) lo detecte sin fallos.
 */
const anadirQuietZonePng = (pngBuffer, margen = 48, escala = 2) => {
  try {
    const imagenOriginal = PNG.sync.read(pngBuffer);
    const factorEscala = escala && escala > 1 ? Math.round(escala) : 1;

    const anchoEscalado = imagenOriginal.width * factorEscala;
    const altoEscalado = imagenOriginal.height * factorEscala;

    const anchoFinal = anchoEscalado + 2 * margen;
    const altoFinal = altoEscalado + 2 * margen;

    const pngConMargen = new PNG({
      width: anchoFinal,
      height: altoFinal,
    });

    // Rellenar todo el lienzo de blanco sólido (RGBA: 255, 255, 255, 255)
    pngConMargen.data.fill(255);

    // Copiar píxeles escalados con interpolación NEAREST (bordes 100% nítidos)
    for (let y = 0; y < altoEscalado; y += 1) {
      const yOrigen = Math.floor(y / factorEscala);
      for (let x = 0; x < anchoEscalado; x += 1) {
        const xOrigen = Math.floor(x / factorEscala);
        const indiceOrigen = (imagenOriginal.width * yOrigen + xOrigen) << 2;

        const r = imagenOriginal.data[indiceOrigen];
        const g = imagenOriginal.data[indiceOrigen + 1];
        const b = imagenOriginal.data[indiceOrigen + 2];
        const a = imagenOriginal.data[indiceOrigen + 3];

        // Si el píxel no es transparente, convertir a escala de grises nítida igual que convert("L")
        const luminancia =
          a < 128 ? 255 : Math.round(0.299 * r + 0.587 * g + 0.114 * b);

        const xDestino = x + margen;
        const yDestino = y + margen;
        const indiceDestino = (anchoFinal * yDestino + xDestino) << 2;

        pngConMargen.data[indiceDestino] = luminancia;
        pngConMargen.data[indiceDestino + 1] = luminancia;
        pngConMargen.data[indiceDestino + 2] = luminancia;
        pngConMargen.data[indiceDestino + 3] = 255;
      }
    }

    return PNG.sync.write(pngConMargen);
  } catch (errorImagen) {
    console.warn(
      'No se pudo aplicar quiet zone al PNG, devolviendo imagen original:',
      errorImagen.message
    );
    return pngBuffer;
  }
};

/**
 * Genera una matriz PNG tipo QR determinística para pruebas locales cuando la consola
 * UniFi Access (192.168.40.178:12445) no es alcanzable desde la red actual.
 */
const generarPngQrSimulado = (semillaTexto) => {
  const modulos = 25;
  const tamanoModulo = 6;
  const dimension = modulos * tamanoModulo;
  const png = new PNG({ width: dimension, height: dimension });
  png.data.fill(255);

  const pintarModulo = (fila, col, negro) => {
    const color = negro ? 0 : 255;
    for (let dy = 0; dy < tamanoModulo; dy += 1) {
      for (let dx = 0; dx < tamanoModulo; dx += 1) {
        const x = col * tamanoModulo + dx;
        const y = fila * tamanoModulo + dy;
        const idx = (dimension * y + x) << 2;
        png.data[idx] = color;
        png.data[idx + 1] = color;
        png.data[idx + 2] = color;
        png.data[idx + 3] = 255;
      }
    }
  };

  const esPatronEsquina = (f, c, f0, c0) => {
    const df = f - f0;
    const dc = c - c0;
    if (df < 0 || df > 6 || dc < 0 || dc > 6) return null;
    if (df === 0 || df === 6 || dc === 0 || dc === 6) return true;
    if (df >= 2 && df <= 4 && dc >= 2 && dc <= 4) return true;
    return false;
  };

  let hash = 2166136261;
  const texto = String(semillaTexto || 'lira-qr');
  for (let i = 0; i < texto.length; i += 1) {
    hash ^= texto.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  for (let f = 0; f < modulos; f += 1) {
    for (let c = 0; c < modulos; c += 1) {
      const esq1 = esPatronEsquina(f, c, 0, 0);
      const esq2 = esPatronEsquina(f, c, 0, modulos - 7);
      const esq3 = esPatronEsquina(f, c, modulos - 7, 0);

      if (esq1 !== null) {
        pintarModulo(f, c, esq1);
      } else if (esq2 !== null) {
        pintarModulo(f, c, esq2);
      } else if (esq3 !== null) {
        pintarModulo(f, c, esq3);
      } else if (
        (f === 7 && (c <= 7 || c >= modulos - 8)) ||
        (c === 7 && (f <= 7 || f >= modulos - 8)) ||
        (f === modulos - 8 && c <= 7)
      ) {
        pintarModulo(f, c, false);
      } else {
        const valor = Math.imul(hash ^ (f * 31 + c * 17), 2654435761) >>> 0;
        pintarModulo(f, c, valor % 2 === 0);
      }
    }
  }

  return PNG.sync.write(png);
};

/**
 * 1) CREAR VISITANTE en UniFi Access con puertas asignadas y ventana de vigencia.
 * Si la consola UniFi no es alcanzable en la red actual y UNIFI_MODO_ESTRICTO !== 'true',
 * crea un visitante en modo respaldo local para permitir pruebas completas en el Dashboard.
 */
const crearVisitanteUnifi = async ({
  nombres,
  apellidos,
  motivo,
  telefono,
  doorIds,
  compania = '',
  email = '',
  ventanaSegundos,
}) => {
  const config = obtenerConfiguracionUnifi();
  const listaPuertas =
    Array.isArray(doorIds) && doorIds.length > 0
      ? doorIds
      : [config.puertaDefecto];

  const duracionSegundos =
    Number(ventanaSegundos) > 0 ? Number(ventanaSegundos) : config.ventanaSegundos;

  const inicio = Math.floor(Date.now() / 1000);
  const fin = inicio + duracionSegundos;

  const payload = {
    first_name: String(nombres || 'Visitante').trim(),
    last_name: String(apellidos || '.').trim(),
    mobile_phone: String(telefono || '0000000000').trim(),
    visit_reason: VISIT_REASON_DEFECTO,
    remarks: String(motivo || 'Ingreso registrado en Dashboard').trim(),
    start_time: inicio,
    end_time: fin,
    resources: listaPuertas.map((idPuerta) => ({
      id: String(idPuerta),
      type: 'door',
    })),
  };

  if (compania && String(compania).trim()) {
    payload.company = String(compania).trim();
  }
  if (email && String(email).trim()) {
    payload.email = String(email).trim();
  }

  try {
    const datos = await peticionUnifi('POST', EP_VISITORS, payload);
    const visitante =
      datos && typeof datos === 'object' && 'data' in datos ? datos.data : datos;
    const visitorId = visitante?.id || visitante?.identity_id;

    if (!visitorId) {
      throw new Error(
        `UniFi Access no devolvió el ID del visitante: ${JSON.stringify(visitante)}`
      );
    }

    return {
      visitorId: String(visitorId),
      inicioTimestamp: inicio,
      finTimestamp: fin,
      puertasAsignadas: listaPuertas,
      simulado: false,
      visitanteRaw: visitante,
    };
  } catch (errorConexion) {
    const modoEstricto =
      String(process.env.UNIFI_MODO_ESTRICTO || 'false').toLowerCase() === 'true';
    if (modoEstricto) {
      throw errorConexion;
    }

    const idSimulado = `sim-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    console.warn(
      `[UniFi Respaldo Local] Consola UniFi (${config.baseUrl}) no alcanzable desde esta red. Creando credencial de prueba ${idSimulado}.`
    );

    return {
      visitorId: idSimulado,
      inicioTimestamp: inicio,
      finTimestamp: fin,
      puertasAsignadas: listaPuertas,
      simulado: true,
      visitanteRaw: { id: idSimulado, simulated: true },
    };
  }
};

/**
 * Elimina (o cancela) al visitante en UniFi Access para revocar su código QR inmediatamente.
 */
const eliminarVisitanteUnifi = async (visitorId, isForce = true) => {
  if (!visitorId || String(visitorId).startsWith('sim-')) return;
  const sufijo = isForce ? '?is_force=true' : '';
  await peticionUnifi('DELETE', `${EP_VISITORS}/${encodeURIComponent(visitorId)}${sufijo}`);
};

/**
 * 2) LISTAR PUERTAS disponibles en la consola UniFi Access.
 */
const listarPuertasUnifi = async () => {
  const datos = await peticionUnifi('GET', EP_DOORS);
  let puertas = datos && typeof datos === 'object' && 'data' in datos ? datos.data : datos;

  if (puertas && typeof puertas === 'object' && !Array.isArray(puertas)) {
    for (const valor of Object.values(puertas)) {
      if (Array.isArray(valor)) {
        puertas = valor;
        break;
      }
    }
  }

  if (!Array.isArray(puertas)) {
    return [];
  }

  return puertas
    .filter((item) => item && typeof item === 'object' && item.id)
    .map((puerta) => ({
      id: String(puerta.id),
      nombre: puerta.name || puerta.full_name || 'Puerta sin nombre',
      estado:
        puerta.door_lock_relay_status ||
        puerta.lock_relay_status ||
        puerta.status ||
        'n/d',
    }));
};

/**
 * Devuelve los IDs de las puertas asignables desde /door_groups/topology.
 */
const idsTodasLasPuertasUnifi = async () => {
  const datos = await peticionUnifi('GET', EP_TOPOLOGY);
  const nodos = datos && typeof datos === 'object' && 'data' in datos ? datos.data : datos;

  const puertas = [];
  const vistos = new Set();

  const recorrer = (nodo) => {
    if (Array.isArray(nodo)) {
      for (const elemento of nodo) {
        recorrer(elemento);
      }
    } else if (nodo && typeof nodo === 'object') {
      if (nodo.type === 'door' && nodo.id && !vistos.has(nodo.id)) {
        vistos.add(nodo.id);
        puertas.push({
          id: String(nodo.id),
          nombre: nodo.name || nodo.full_name || 'Puerta',
        });
      }
      for (const valor of Object.values(nodo)) {
        if (valor && typeof valor === 'object') {
          recorrer(valor);
        }
      }
    }
  };

  recorrer(nodos);
  return puertas;
};

/**
 * 3) EMITIR Y DESCARGAR QR DEL VISITANTE con margen blanco (quiet zone) para cámaras UniFi.
 */
const generarQrVisitanteUnifi = async (visitorId) => {
  if (String(visitorId).startsWith('sim-')) {
    const bufferSimulado = generarPngQrSimulado(visitorId);
    const pngConQuietZone = anadirQuietZonePng(bufferSimulado, 48, 2);
    return {
      bufferPng: pngConQuietZone,
      base64DataUrl: `data:image/png;base64,${pngConQuietZone.toString('base64')}`,
      simulado: true,
    };
  }

  const vidCodificado = encodeURIComponent(visitorId);

  // Paso 1: Emitir/asignar QR en la consola UniFi (#4.11)
  await peticionUnifi('PUT', `/visitors/${vidCodificado}/qr_codes`);

  // Paso 2: Descargar PNG del QR (#6.18)
  const respuestaBinaria = await peticionUnifi(
    'GET',
    `/credentials/qr_codes/download/${vidCodificado}`
  );

  if (!Buffer.isBuffer(respuestaBinaria)) {
    throw new Error('La consola UniFi no devolvió una imagen binaria PNG para el QR.');
  }

  // Paso 3: Añadir margen blanco (quiet zone = 48px, escala = 2x) para el lector G3 Reader Pro
  const pngConQuietZone = anadirQuietZonePng(respuestaBinaria, 48, 2);
  const base64DataUrl = `data:image/png;base64,${pngConQuietZone.toString('base64')}`;

  return {
    bufferPng: pngConQuietZone,
    base64DataUrl,
    simulado: false,
  };
};

/**
 * 4) OBTENER LOGS DE APERTURA DE PUERTA DEL VISITANTE en UniFi Access.
 */
const obtenerLogsVisitanteUnifi = async (visitorId, desdeTimestamp) => {
  if (String(visitorId).startsWith('sim-')) {
    return [];
  }
  const cuerpo = {
    topic: 'door_openings',
    since: Number(desdeTimestamp) || Math.floor(Date.now() / 1000) - 3600,
    until: Math.floor(Date.now() / 1000),
    actor_id: String(visitorId),
    page_num: 1,
    page_size: 100,
  };

  const datos = await peticionUnifi('POST', EP_SYSTEM_LOGS, cuerpo);
  if (datos && typeof datos === 'object') {
    const interno = datos.data ?? [];
    if (Array.isArray(interno)) return interno;
    if (interno && typeof interno === 'object' && Array.isArray(interno.hits)) {
      return interno.hits;
    }
  }
  return Array.isArray(datos) ? datos : [];
};

/**
 * Verifica si un evento del log corresponde a una apertura CONCEDIDA real
 * (descarta intentos BLOCKED o de otros actores), idéntico a _es_acceso_concedido en access.py.
 */
const esAccesoConcedidoUnifi = (evento, visitorId) => {
  if (!evento || typeof evento !== 'object') return false;
  const src = evento._source || evento;
  const actor = src.actor || {};

  if (visitorId && actor.id && actor.id !== visitorId) {
    return false;
  }

  const evt = src.event || {};
  const resultado = String(evt.result || '').toUpperCase();
  const logKey = String(evt.log_key || '');

  return resultado === 'ACCESS' || logKey === 'access.door.unlock.success';
};

/**
 * Extrae el nombre de la puerta de un evento de apertura de UniFi.
 */
const obtenerPuertaDeEventoUnifi = (evento) => {
  const src = (evento && (evento._source || evento)) || {};
  const objetivos = Array.isArray(src.target) ? src.target : [];
  for (const objetivo of objetivos) {
    if (objetivo && objetivo.type === 'door') {
      return objetivo.display_name || objetivo.id || 'Puerta';
    }
  }
  return 'Puerta';
};

/**
 * Envía el código QR (PNG con margen blanco quiet-zone) al correo electrónico del visitante.
 */
const enviarQrPorCorreo = async ({
  destinatario,
  qrBase64,
  nombreCompleto,
  cedula,
  motivo,
  finTimestamp,
  maxUsos,
}) => {
  const correoDestino = String(destinatario || '').trim();
  if (!correoDestino) {
    throw new Error('Debes indicar una dirección de correo electrónico válida.');
  }

  const smtpHost = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const smtpPort = Number(process.env.SMTP_PORT) || 587;
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = process.env.SMTP_PASS || '';
  const smtpFrom = process.env.SMTP_FROM || smtpUser || 'no-reply@liraseguridad.com';

  if (!smtpUser || !smtpPass) {
    throw new Error(
      'Configura SMTP_USER y SMTP_PASS en server/.env para enviar correos desde el servidor (UniFi Access también recibe el email si tiene notificaciones activas).'
    );
  }

  const base64Limpio = String(qrBase64 || '').replace(/^data:image\/png;base64,/, '');
  const bufferPng = Buffer.from(base64Limpio, 'base64');

  const horaVencimiento = finTimestamp
    ? new Date(Number(finTimestamp) * 1000).toLocaleTimeString('es-CO', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '1 hora';

  const transportador = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  await transportador.sendMail({
    from: smtpFrom,
    to: correoDestino,
    subject: `Pase de Ingreso QR - Lira Seguridad (${nombreCompleto})`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0066cc; margin-top: 0;">Pase de Ingreso QR - Lira Seguridad</h2>
        <p>Hola <strong>${nombreCompleto}</strong> (C.C. ${cedula}),</p>
        <p>Se ha generado tu código QR de invitación para ingresar a las instalaciones:</p>
        <ul>
          <li><strong>Motivo:</strong> ${motivo || 'Visita autorizada'}</li>
          <li><strong>Vigencia hasta:</strong> ${horaVencimiento}</li>
          <li><strong>Accesos permitidos:</strong> ${maxUsos} (1 entrada + 1 salida)</li>
        </ul>
        <div style="text-align: center; margin: 24px 0; background: #ffffff; padding: 16px;">
          <img src="cid:qr_unifi_lira" alt="Código QR de Acceso" style="max-width: 240px; height: auto;" />
        </div>
        <p style="font-size: 13px; color: #4a5568;">
          Presenta este código QR desde tu celular frente a la cámara del lector UniFi al entrar y al salir.
        </p>
      </div>
    `,
    attachments: [
      {
        filename: `pase_qr_${cedula}.png`,
        content: bufferPng,
        contentType: 'image/png',
        cid: 'qr_unifi_lira',
      },
    ],
  });
};

module.exports = {
  obtenerConfiguracionUnifi,
  dividirNombreCompleto,
  anadirQuietZonePng,
  crearVisitanteUnifi,
  eliminarVisitanteUnifi,
  listarPuertasUnifi,
  idsTodasLasPuertasUnifi,
  generarQrVisitanteUnifi,
  obtenerLogsVisitanteUnifi,
  esAccesoConcedidoUnifi,
  obtenerPuertaDeEventoUnifi,
  enviarQrPorCorreo,
};
