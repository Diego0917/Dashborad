/**
 * Cliente ligero para Meta WhatsApp Cloud API (https://graph.facebook.com).
 * Usa fetch, FormData y Blob nativos de Node.js (>= 20), sin dependencias externas.
 */
const crypto = require('crypto');

const obtenerTokenWhatsapp = () => String(process.env.WHATSAPP_TOKEN || '').trim();
const obtenerPhoneNumberIdWhatsapp = () =>
  String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const obtenerVersionApiWhatsapp = () =>
  String(process.env.WHATSAPP_API_VERSION || 'v22.0').trim() || 'v22.0';
const obtenerVerifyTokenWhatsapp = () =>
  String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
const obtenerAppSecretWhatsapp = () =>
  String(process.env.WHATSAPP_APP_SECRET || '').trim();
const obtenerCodigoPaisDefecto = () =>
  String(process.env.WHATSAPP_CODIGO_PAIS_DEFECTO || '57')
    .replace(/\D/g, '') || '57';

const whatsappConfigurado = () =>
  Boolean(obtenerTokenWhatsapp() && obtenerPhoneNumberIdWhatsapp());

const soloDigitos = (valor) => String(valor || '').replace(/\D/g, '');

const normalizarUltimos10Digitos = (telefono) => {
  const digitos = soloDigitos(telefono);
  return digitos.length >= 10 ? digitos.slice(-10) : digitos;
};

/**
 * Normaliza un número telefónico al formato E.164 sin '+' que espera Meta Cloud API.
 * Ej.: "300 123 4567" con código de país "57" -> "573001234567".
 */
const normalizarTelefonoWhatsapp = (telefono, codigoPais = obtenerCodigoPaisDefecto()) => {
  const digitos = soloDigitos(telefono);
  if (!digitos) return '';
  if (digitos.length === 10 && codigoPais) {
    return `${codigoPais}${digitos}`;
  }
  return digitos;
};

const truncarTexto = (texto, maxLen) => {
  const limpio = String(texto || '').trim();
  if (limpio.length <= maxLen) return limpio;
  return `${limpio.slice(0, Math.max(maxLen - 1, 1))}…`;
};

const construirUrlGraph = (rutaRelativa) => {
  const version = obtenerVersionApiWhatsapp();
  const phoneNumberId = obtenerPhoneNumberIdWhatsapp();
  return `https://graph.facebook.com/${version}/${phoneNumberId}/${rutaRelativa}`;
};

const peticionGraphJson = async (rutaRelativa, cuerpoJson, { timeoutMs = 15000 } = {}) => {
  const token = obtenerTokenWhatsapp();
  const phoneNumberId = obtenerPhoneNumberIdWhatsapp();
  if (!token || !phoneNumberId) {
    throw new Error(
      'WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID deben estar configurados en server/.env'
    );
  }

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);

  try {
    const respuesta = await fetch(construirUrlGraph(rutaRelativa), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cuerpoJson),
      signal: controlador.signal,
    });

    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok || datos.error) {
      const codigoMeta = datos?.error?.code;
      const detalleMeta =
        datos?.error?.error_data?.details ||
        datos?.error?.message ||
        `HTTP ${respuesta.status}`;
      const error = new Error(
        `WhatsApp Cloud API error en ${rutaRelativa} (${respuesta.status}${codigoMeta ? ` / code ${codigoMeta}` : ''}): ${detalleMeta}`
      );
      error.codigoMeta = codigoMeta;
      error.statusHttp = respuesta.status;
      throw error;
    }

    return datos;
  } finally {
    clearTimeout(temporizador);
  }
};

const enviarTextoWhatsapp = async (telefonoDestino, texto, { previewUrl = false } = {}) => {
  const destino = normalizarTelefonoWhatsapp(telefonoDestino);
  if (!destino) {
    throw new Error('Teléfono de destino inválido para enviar mensaje de WhatsApp.');
  }

  return peticionGraphJson('messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destino,
    type: 'text',
    text: {
      preview_url: Boolean(previewUrl),
      body: String(texto || ''),
    },
  });
};

/**
 * Envía un mensaje interactivo con hasta 3 botones de respuesta rápida.
 * Cada botón: { id: string, title: string (máx. 20 caracteres) }.
 */
const enviarBotonesWhatsapp = async (telefonoDestino, cuerpoTexto, botones = []) => {
  const destino = normalizarTelefonoWhatsapp(telefonoDestino);
  if (!destino) {
    throw new Error('Teléfono de destino inválido para enviar botones de WhatsApp.');
  }

  const listaBotones = botones.slice(0, 3).map((b) => ({
    type: 'reply',
    reply: {
      id: String(b.id),
      title: truncarTexto(b.title, 20),
    },
  }));

  return peticionGraphJson('messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destino,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(cuerpoTexto || '') },
      action: { buttons: listaBotones },
    },
  });
};

/**
 * Envía un mensaje interactivo tipo lista (ideal para elegir entre 2 a 10 empleados).
 * filas: [{ id: string, title: string (máx. 24 chars), description?: string (máx. 72 chars) }]
 */
const enviarListaWhatsapp = async (
  telefonoDestino,
  cuerpoTexto,
  textoBoton,
  tituloSeccion,
  filas = []
) => {
  const destino = normalizarTelefonoWhatsapp(telefonoDestino);
  if (!destino) {
    throw new Error('Teléfono de destino inválido para enviar lista de WhatsApp.');
  }

  const filasFormateadas = filas.slice(0, 10).map((fila) => {
    const item = {
      id: String(fila.id),
      title: truncarTexto(fila.title, 24),
    };
    if (fila.description) {
      item.description = truncarTexto(fila.description, 72);
    }
    return item;
  });

  return peticionGraphJson('messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destino,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: String(cuerpoTexto || '') },
      action: {
        button: truncarTexto(textoBoton || 'Ver opciones', 20),
        sections: [
          {
            title: truncarTexto(tituloSeccion || 'Opciones', 24),
            rows: filasFormateadas,
          },
        ],
      },
    },
  });
};

const subirMediaPngWhatsapp = async (bufferPng, nombreArchivo = 'pase_qr.png') => {
  const token = obtenerTokenWhatsapp();
  const phoneNumberId = obtenerPhoneNumberIdWhatsapp();
  if (!token || !phoneNumberId) {
    throw new Error(
      'WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID deben estar configurados en server/.env'
    );
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/png');
  form.append('file', new Blob([bufferPng], { type: 'image/png' }), nombreArchivo);

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), 20000);

  try {
    const respuesta = await fetch(construirUrlGraph('media'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
      signal: controlador.signal,
    });

    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok || !datos.id) {
      const detalle = datos?.error?.message || `HTTP ${respuesta.status}`;
      throw new Error(`WhatsApp Cloud API error subiendo media (${respuesta.status}): ${detalle}`);
    }

    return datos.id;
  } finally {
    clearTimeout(temporizador);
  }
};

const enviarImagenQrWhatsapp = async (telefonoDestino, bufferPng, caption = '') => {
  const destino = normalizarTelefonoWhatsapp(telefonoDestino);
  if (!destino) {
    throw new Error('Teléfono de destino inválido para enviar imagen QR de WhatsApp.');
  }

  const mediaId = await subirMediaPngWhatsapp(bufferPng, 'pase_qr.png');

  return peticionGraphJson('messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destino,
    type: 'image',
    image: {
      id: mediaId,
      caption: String(caption || '').slice(0, 1024),
    },
  });
};

const enviarPlantillaWhatsapp = async (
  telefonoDestino,
  nombrePlantilla,
  { idioma = 'es', componentes = [] } = {}
) => {
  const destino = normalizarTelefonoWhatsapp(telefonoDestino);
  const plantillaLimpia = String(nombrePlantilla || '').trim();
  if (!destino || !plantillaLimpia) {
    throw new Error('Teléfono o nombre de plantilla inválido para WhatsApp.');
  }

  const template = {
    name: plantillaLimpia,
    language: { code: idioma },
  };
  if (Array.isArray(componentes) && componentes.length > 0) {
    template.components = componentes;
  }

  return peticionGraphJson('messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destino,
    type: 'template',
    template,
  });
};

const marcarMensajeLeidoWhatsapp = async (messageId) => {
  if (!messageId || !whatsappConfigurado()) return null;
  try {
    return await peticionGraphJson('messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: String(messageId),
    });
  } catch {
    return null;
  }
};

/**
 * Valida la firma HMAC-SHA256 enviada por Meta en el header `X-Hub-Signature-256`.
 * Si `WHATSAPP_APP_SECRET` no está configurado, retorna true (modo desarrollo).
 */
const verificarFirmaMeta = (rawBodyBuffer, firmaHeader, appSecret = obtenerAppSecretWhatsapp()) => {
  if (!appSecret) return true;
  if (!rawBodyBuffer || !firmaHeader) return false;

  const firma = String(firmaHeader).trim();
  if (!firma.startsWith('sha256=')) return false;

  const hashRecibido = firma.slice('sha256='.length);
  const hashEsperado = crypto
    .createHmac('sha256', appSecret)
    .update(rawBodyBuffer)
    .digest('hex');

  const bufRecibido = Buffer.from(hashRecibido, 'hex');
  const bufEsperado = Buffer.from(hashEsperado, 'hex');
  if (bufRecibido.length !== bufEsperado.length) return false;

  return crypto.timingSafeEqual(bufRecibido, bufEsperado);
};

module.exports = {
  whatsappConfigurado,
  obtenerVerifyTokenWhatsapp,
  obtenerAppSecretWhatsapp,
  normalizarUltimos10Digitos,
  normalizarTelefonoWhatsapp,
  enviarTextoWhatsapp,
  enviarBotonesWhatsapp,
  enviarListaWhatsapp,
  subirMediaPngWhatsapp,
  enviarImagenQrWhatsapp,
  enviarPlantillaWhatsapp,
  marcarMensajeLeidoWhatsapp,
  verificarFirmaMeta,
};
