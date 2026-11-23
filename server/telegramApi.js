/**
 * Cliente ligero para la API oficial de Telegram Bot (https://api.telegram.org).
 * Usa `fetch`, `FormData` y `Blob` nativos de Node.js >= 20 sin dependencias externas.
 */

const obtenerTokenTelegram = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();

const telegramConfigurado = () => Boolean(obtenerTokenTelegram());

const normalizarUltimos10Digitos = (telefono) => {
  const soloDigitos = String(telefono || '').replace(/\D/g, '');
  if (soloDigitos.length >= 10) {
    return soloDigitos.slice(-10);
  }
  return soloDigitos;
};

const peticionTelegram = async (metodo, cuerpoJson = null, { signal, timeoutMs = 15000 } = {}) => {
  const token = obtenerTokenTelegram();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN no está configurado en server/.env');
  }

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controlador.abort();
    else signal.addEventListener('abort', () => controlador.abort(), { once: true });
  }

  try {
    const respuesta = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: cuerpoJson ? JSON.stringify(cuerpoJson) : undefined,
      signal: controlador.signal,
    });

    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok || !datos.ok) {
      throw new Error(
        `Telegram API error en ${metodo} (${respuesta.status}): ${datos.description || 'Error desconocido'}`
      );
    }
    return datos.result;
  } finally {
    clearTimeout(temporizador);
  }
};

const obtenerActualizacionesTelegram = async (offset = 0, timeoutSeg = 25, signal = undefined) => {
  return peticionTelegram(
    'getUpdates',
    {
      offset,
      timeout: timeoutSeg,
      allowed_updates: ['message', 'callback_query'],
    },
    { signal, timeoutMs: (timeoutSeg + 10) * 1000 }
  );
};

const enviarMensajeTelegram = async (chatId, texto, opciones = {}) => {
  return peticionTelegram('sendMessage', {
    chat_id: String(chatId),
    text: String(texto),
    ...opciones,
  });
};

const responderCallbackTelegram = async (callbackQueryId, texto = '', showAlert = false) => {
  return peticionTelegram('answerCallbackQuery', {
    callback_query_id: String(callbackQueryId),
    text: texto ? String(texto) : undefined,
    show_alert: Boolean(showAlert),
  });
};

const editarMensajeTelegram = async (chatId, messageId, texto, opciones = {}) => {
  return peticionTelegram('editMessageText', {
    chat_id: String(chatId),
    message_id: Number(messageId),
    text: String(texto),
    ...opciones,
  });
};

const enviarFotoQrTelegram = async (chatId, bufferPng, caption = '') => {
  const token = obtenerTokenTelegram();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN no está configurado en server/.env');
  }

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', String(caption));
  }
  const blobPng = new Blob([bufferPng], { type: 'image/png' });
  form.append('photo', blobPng, 'pase_qr.png');

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), 20000);

  try {
    const respuesta = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: controlador.signal,
    });
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok || !datos.ok) {
      throw new Error(
        `Telegram API error en sendPhoto (${respuesta.status}): ${datos.description || 'Error desconocido'}`
      );
    }
    return datos.result;
  } finally {
    clearTimeout(temporizador);
  }
};

module.exports = {
  telegramConfigurado,
  normalizarUltimos10Digitos,
  obtenerActualizacionesTelegram,
  enviarMensajeTelegram,
  responderCallbackTelegram,
  editarMensajeTelegram,
  enviarFotoQrTelegram,
};
