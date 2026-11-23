const crypto = require('crypto');
const telegramApiDefecto = require('./telegramApi');

const ESTADOS_ACTIVOS_VISITANTE = [
  'ESPERANDO_ANFITRION',
  'ELIGIENDO_ANFITRION',
  'ESPERANDO_MOTIVO',
  'PENDIENTE_APROBACION',
  'APROBADA',
];

const obtenerUrlPublicaApp = () =>
  String(process.env.URL_PUBLICA_APP || 'http://localhost:8080').trim().replace(/\/$/, '');

const obtenerMinutosExpiracionFormulario = () =>
  Math.max(Number(process.env.TELEGRAM_FORM_EXPIRACION_MIN) || 30, 5);

const obtenerGrupoAprobacionesId = () =>
  String(process.env.TELEGRAM_GRUPO_APROBACIONES_ID || '').trim();

const obtenerAdminsTelegramIds = () =>
  new Set(
    String(process.env.TELEGRAM_ADMINS_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );

const normalizarPalabrasNombre = (texto) =>
  String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

/**
 * Verifica si el nombre de perfil en Telegram corresponde al anfitrión seleccionado
 * (se usa únicamente la primera vez, mientras el empleado aún no tiene telegram_chat_id guardado).
 */
const nombresCoincidenParaAprobacion = (nombreTelegram, nombreAnfitrion) => {
  const palabrasTg = normalizarPalabrasNombre(nombreTelegram);
  const palabrasAnf = normalizarPalabrasNombre(nombreAnfitrion);
  if (palabrasTg.length === 0 || palabrasAnf.length === 0) return false;

  const setAnf = new Set(palabrasAnf);
  const coincidencias = palabrasTg.filter((w) => setAnf.has(w));

  if (palabrasTg.length >= 2 && palabrasAnf.length >= 2) {
    return coincidencias.length >= 2;
  }
  // Si el usuario solo tiene 1 palabra en su perfil de Telegram, debe coincidir con el primer nombre
  return palabrasTg.length === 1 && palabrasTg[0] === palabrasAnf[0];
};

const resolverDestinoAprobacion = (empleado) => {
  if (empleado?.telegram_chat_id) {
    return String(empleado.telegram_chat_id).trim();
  }
  return obtenerGrupoAprobacionesId();
};

const construirNombrePerfilTelegram = (fromObj) => {
  if (!fromObj) return 'Visitante';
  const partes = [fromObj.first_name, fromObj.last_name].filter(Boolean);
  return partes.join(' ').trim() || fromObj.username || 'Visitante';
};

const vincularEmpleadoPorTelefonoOCedula = async (
  pool,
  { chatId, telefono = '', cedula = '' },
  clienteTg
) => {
  const ultimos10 = telegramApiDefecto.normalizarUltimos10Digitos(telefono);
  const cedulaLimpia = String(cedula || '').trim();

  let empleados = [];
  if (cedulaLimpia) {
    const [filas] = await pool.query(
      `SELECT cedula, nombre_completo, telefono, telegram_chat_id
       FROM personas
       WHERE id_rol = 2 AND cedula = ?
       LIMIT 1`,
      [cedulaLimpia]
    );
    empleados = filas;
  } else if (ultimos10.length >= 7) {
    const [filas] = await pool.query(
      `SELECT cedula, nombre_completo, telefono, telegram_chat_id
       FROM personas
       WHERE id_rol = 2
         AND telefono IS NOT NULL
         AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(telefono, ' ', ''), '-', ''), '+', ''), '(', ''), 10) = ?
       LIMIT 1`,
      [ultimos10]
    );
    empleados = filas;
  }

  if (empleados.length === 0) {
    await clienteTg.enviarMensajeTelegram(
      chatId,
      'No encontré un empleado registrado con ese dato.\n' +
        'Verifica que tu número esté cargado en UniFi Access y sincronizado en el Dashboard, ' +
        'o intenta con: /vincular TU_CEDULA',
      { reply_markup: { remove_keyboard: true } }
    );
    return;
  }

  const emp = empleados[0];
  await pool.query(
    'UPDATE personas SET telegram_chat_id = NULL WHERE telegram_chat_id = ? AND cedula <> ?',
    [String(chatId), emp.cedula]
  );
  await pool.query('UPDATE personas SET telegram_chat_id = ? WHERE cedula = ?', [
    String(chatId),
    emp.cedula,
  ]);

  await clienteTg.enviarMensajeTelegram(
    chatId,
    `✅ Vinculado correctamente como empleado: ${emp.nombre_completo}.\n` +
      'A partir de ahora recibirás aquí las solicitudes de aprobación cuando un visitante pregunte por ti.',
    { reply_markup: { remove_keyboard: true } }
  );
};

const notificarAnfitrionSolicitud = async (pool, solicitud, motivo, clienteTg) => {
  await pool.query(
    `UPDATE solicitudes_visita_telegram
     SET motivo = ?, estado = 'PENDIENTE_APROBACION'
     WHERE id_solicitud = ?`,
    [motivo, solicitud.id_solicitud]
  );

  const textoAnfitrion =
    `🔔 Nueva solicitud de visita (#${solicitud.id_solicitud})\n\n` +
    `🏢 Anfitrión solicitado: ${solicitud.nombre_anfitrion}\n` +
    `👤 Visitante: ${solicitud.nombre_telegram_visitante || 'Visitante'}\n` +
    `📝 Motivo: ${motivo}\n\n` +
    '¿Autorizas el ingreso para enviarle el formulario de registro y generar su código QR?';

  await clienteTg.enviarMensajeTelegram(solicitud.chat_id_anfitrion, textoAnfitrion, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Aprobar visita', callback_data: `aprobar_${solicitud.id_solicitud}` },
          { text: '❌ Rechazar', callback_data: `rechazar_${solicitud.id_solicitud}` },
        ],
      ],
    },
  });

  await clienteTg.enviarMensajeTelegram(
    solicitud.chat_id_visitante,
    `⏳ Solicitud enviada a ${solicitud.nombre_anfitrion}.\n` +
      'Apenas apruebe tu visita, te enviaré aquí el enlace del formulario para generar tu código QR.'
  );
};

const manejarCallbackQuery = async (pool, callbackQuery, clienteTg) => {
  const data = String(callbackQuery.data || '');
  const chatId = String(callbackQuery.message?.chat?.id || callbackQuery.from?.id || '');
  const messageId = callbackQuery.message?.message_id;

  // 1) Aprobación o rechazo por parte del anfitrión
  const matchDecision = /^(aprobar|rechazar)_(\d+)$/.exec(data);
  if (matchDecision) {
    const accion = matchDecision[1];
    const idSolicitud = Number(matchDecision[2]);

    const [filas] = await pool.query(
      'SELECT * FROM solicitudes_visita_telegram WHERE id_solicitud = ? LIMIT 1',
      [idSolicitud]
    );
    if (filas.length === 0) {
      await clienteTg.responderCallbackTelegram(callbackQuery.id, 'Solicitud no encontrada.');
      return;
    }

    const sol = filas[0];
    const fromUserId = String(callbackQuery.from?.id || '').trim();
    const nombreQuienResponde = construirNombrePerfilTelegram(callbackQuery.from);
    const adminsIds = obtenerAdminsTelegramIds();
    const esAdminRespaldo = Boolean(fromUserId && adminsIds.has(fromUserId));

    // Consultar si el anfitrión ya tiene su telegram_chat_id guardado en personas
    let anfitrionChatIdGuardado = '';
    if (sol.cedula_anfitrion) {
      const [filasAnf] = await pool.query(
        'SELECT telegram_chat_id FROM personas WHERE cedula = ? LIMIT 1',
        [sol.cedula_anfitrion]
      );
      anfitrionChatIdGuardado = String(filasAnf[0]?.telegram_chat_id || '').trim();
    }

    let autorizado = false;
    let debeAutoVincular = false;

    if (esAdminRespaldo) {
      autorizado = true;
    } else if (anfitrionChatIdGuardado) {
      // Ya vinculado: verificación estricta por ID numérico único de Telegram
      autorizado = fromUserId === anfitrionChatIdGuardado;
    } else if (fromUserId && nombresCoincidenParaAprobacion(nombreQuienResponde, sol.nombre_anfitrion)) {
      // Primera vez en el grupo: coincide su nombre de Telegram -> autoriza y auto-vincula su ID
      autorizado = true;
      debeAutoVincular = Boolean(sol.cedula_anfitrion);
    }

    if (!autorizado) {
      await clienteTg.responderCallbackTelegram(
        callbackQuery.id,
        `⛔ Solo ${sol.nombre_anfitrion || 'el anfitrión asignado'} puede aprobar o rechazar esta visita.`,
        true
      );
      return;
    }

    if (debeAutoVincular && sol.cedula_anfitrion && fromUserId) {
      await pool
        .query(
          'UPDATE personas SET telegram_chat_id = NULL WHERE telegram_chat_id = ? AND cedula <> ?',
          [fromUserId, sol.cedula_anfitrion]
        )
        .catch(() => {});
      await pool
        .query('UPDATE personas SET telegram_chat_id = ? WHERE cedula = ?', [
          fromUserId,
          sol.cedula_anfitrion,
        ])
        .catch(() => {});
    }

    if (sol.estado !== 'PENDIENTE_APROBACION') {
      await clienteTg.responderCallbackTelegram(
        callbackQuery.id,
        `Esta solicitud ya fue procesada (${sol.estado}).`
      );
      return;
    }

    if (accion === 'aprobar') {
      const tokenFormulario = crypto.randomBytes(24).toString('hex');
      const minutosExp = obtenerMinutosExpiracionFormulario();

      await pool.query(
        `UPDATE solicitudes_visita_telegram
         SET estado = 'APROBADA',
             token_formulario = ?,
             token_expira_en = DATE_ADD(NOW(), INTERVAL ? MINUTE)
         WHERE id_solicitud = ?`,
        [tokenFormulario, minutosExp, idSolicitud]
      );

      const urlFormulario = `${obtenerUrlPublicaApp()}/registro-visita/${tokenFormulario}`;

      await clienteTg.responderCallbackTelegram(callbackQuery.id, 'Visita aprobada ✅');
      if (messageId) {
        await clienteTg
          .editarMensajeTelegram(
            chatId,
            messageId,
            `✅ Visita #${idSolicitud} aprobada por ${nombreQuienResponde}\n` +
              `🏢 Anfitrión: ${sol.nombre_anfitrion}\n` +
              `👤 Visitante: ${sol.nombre_telegram_visitante || 'Visitante'} (${sol.motivo})\n` +
              'Ya se envió el formulario de registro al invitado.'
          )
          .catch(() => {});
      }

      const opcionesEnlace = urlFormulario.startsWith('https://')
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: '📝 Completar registro y obtener QR', url: urlFormulario }]],
            },
          }
        : {};

      await clienteTg.enviarMensajeTelegram(
        sol.chat_id_visitante,
        `✅ ¡Tu visita con ${sol.nombre_anfitrion} fue aprobada!\n\n` +
          `Completa tus datos en el siguiente enlace para generar tu código QR de ingreso (válido por ${minutosExp} minutos, un solo uso):\n\n` +
          `${urlFormulario}`,
        opcionesEnlace
      );
      return;
    }

    // Rechazar
    await pool.query(
      "UPDATE solicitudes_visita_telegram SET estado = 'RECHAZADA' WHERE id_solicitud = ?",
      [idSolicitud]
    );
    await clienteTg.responderCallbackTelegram(callbackQuery.id, 'Visita rechazada ❌');
    if (messageId) {
      await clienteTg
        .editarMensajeTelegram(
          chatId,
          messageId,
          `❌ Visita #${idSolicitud} rechazada por ${nombreQuienResponde}\n` +
            `🏢 Anfitrión: ${sol.nombre_anfitrion}\n` +
            `👤 Visitante: ${sol.nombre_telegram_visitante || 'Visitante'}`
        )
        .catch(() => {});
    }
    await clienteTg.enviarMensajeTelegram(
      sol.chat_id_visitante,
      `❌ Tu solicitud de visita con ${sol.nombre_anfitrion} no fue autorizada.\n` +
        'Si necesitas intentarlo con otra persona, escribe /start.'
    );
    return;
  }

  // 2) Visitante eligiendo un anfitrión de la lista de coincidencias
  const matchElegir = /^elegir_(\d+)_(\d+)$/.exec(data);
  if (matchElegir) {
    const idSolicitud = Number(matchElegir[1]);
    const indice = Number(matchElegir[2]);

    const [filas] = await pool.query(
      'SELECT * FROM solicitudes_visita_telegram WHERE id_solicitud = ? LIMIT 1',
      [idSolicitud]
    );
    if (filas.length === 0) {
      await clienteTg.responderCallbackTelegram(callbackQuery.id, 'Solicitud no encontrada.');
      return;
    }

    const sol = filas[0];
    if (String(sol.chat_id_visitante) !== chatId || sol.estado !== 'ELIGIENDO_ANFITRION') {
      await clienteTg.responderCallbackTelegram(callbackQuery.id, 'Esta selección ya no está vigente.');
      return;
    }

    let candidatos = [];
    try {
      candidatos = JSON.parse(sol.candidatos_json || '[]');
    } catch {
      candidatos = [];
    }

    const elegido = candidatos[indice];
    if (!elegido) {
      await clienteTg.responderCallbackTelegram(callbackQuery.id, 'Opción inválida.');
      return;
    }

    const destinoAprobacion = resolverDestinoAprobacion(elegido);
    await clienteTg.responderCallbackTelegram(callbackQuery.id, `Elegido: ${elegido.nombre_completo}`);
    if (!destinoAprobacion) {
      await clienteTg.enviarMensajeTelegram(
        chatId,
        `⚠️ ${elegido.nombre_completo} no tiene un canal de aprobación configurado.\n` +
          'Configura TELEGRAM_GRUPO_APROBACIONES_ID en server/.env o pide al empleado vincularse con /empleado.'
      );
      await pool.query(
        "UPDATE solicitudes_visita_telegram SET estado = 'ESPERANDO_ANFITRION', candidatos_json = NULL WHERE id_solicitud = ?",
        [idSolicitud]
      );
      return;
    }

    await pool.query(
      `UPDATE solicitudes_visita_telegram
       SET cedula_anfitrion = ?, nombre_anfitrion = ?, chat_id_anfitrion = ?,
           candidatos_json = NULL, estado = 'ESPERANDO_MOTIVO'
       WHERE id_solicitud = ?`,
      [elegido.cedula, elegido.nombre_completo, destinoAprobacion, idSolicitud]
    );

    if (messageId) {
      await clienteTg
        .editarMensajeTelegram(chatId, messageId, `👤 Anfitrión seleccionado: ${elegido.nombre_completo}`)
        .catch(() => {});
    }

    await clienteTg.enviarMensajeTelegram(
      chatId,
      `Perfecto, avisaremos a ${elegido.nombre_completo}.\n📝 ¿Cuál es el motivo de tu visita?`
    );
  }
};

/**
 * Procesa una actualización (mensaje o callback_query) de Telegram Bot API.
 */
const procesarActualizacionTelegram = async (
  pool,
  update,
  clienteTg = telegramApiDefecto
) => {
  if (!update || typeof update !== 'object') return;

  if (update.callback_query) {
    await manejarCallbackQuery(pool, update.callback_query, clienteTg);
    return;
  }

  const mensaje = update.message;
  if (!mensaje || !mensaje.chat?.id) return;

  const chatId = String(mensaje.chat.id);
  const tipoChat = String(mensaje.chat.type || 'private');
  const nombrePerfil = construirNombrePerfilTelegram(mensaje.from);
  const texto = String(mensaje.text || '').trim();

  // Comando auxiliar para obtener el ID de cualquier chat o grupo (pegarlo en TELEGRAM_GRUPO_APROBACIONES_ID)
  if (/^\/chatid(@\w+)?\b/i.test(texto)) {
    await clienteTg.enviarMensajeTelegram(
      chatId,
      `ℹ️ El ID de este chat (${tipoChat}) es:\n${chatId}\n\n` +
        'Si este es el grupo de aprobaciones, colócalo en server/.env como:\n' +
        `TELEGRAM_GRUPO_APROBACIONES_ID=${chatId}`
    );
    return;
  }

  // En grupos/supergrupos ignoramos conversaciones normales (solo atendemos /chatid y botones Aprobar/Rechazar)
  if (tipoChat === 'group' || tipoChat === 'supergroup') {
    return;
  }

  // 1) Contacto compartido para vincular empleado
  if (mensaje.contact?.phone_number) {
    await vincularEmpleadoPorTelefonoOCedula(
      pool,
      { chatId, telefono: mensaje.contact.phone_number },
      clienteTg
    );
    return;
  }

  // 2) Comandos de vinculación de empleado
  if (/^\/empleado\b/i.test(texto)) {
    await clienteTg.enviarMensajeTelegram(
      chatId,
      'Para vincularte como empleado anfitrión y recibir solicitudes de visitantes, pulsa el botón de abajo para compartir tu número telefónico (o escribe /vincular TU_CEDULA):',
      {
        reply_markup: {
          keyboard: [[{ text: '📱 Compartir mi número de teléfono', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
    return;
  }

  const matchVincular = /^\/vincular\s+(.+)$/i.exec(texto);
  if (matchVincular) {
    await vincularEmpleadoPorTelefonoOCedula(
      pool,
      { chatId, cedula: matchVincular[1].trim() },
      clienteTg
    );
    return;
  }

  // 3) Cancelar / reiniciar flujo del visitante
  if (/^\/(cancelar|reiniciar)\b/i.test(texto) || /^cancelar$/i.test(texto)) {
    await pool.query(
      `UPDATE solicitudes_visita_telegram
       SET estado = 'EXPIRADA'
       WHERE chat_id_visitante = ? AND estado IN (?, ?, ?, ?, ?)`,
      [chatId, ...ESTADOS_ACTIVOS_VISITANTE]
    );
    await clienteTg.enviarMensajeTelegram(
      chatId,
      'Solicitud cancelada. Cuando quieras solicitar un nuevo ingreso escribe /start.'
    );
    return;
  }

  // Buscar si el visitante ya tiene una solicitud activa
  const [activas] = await pool.query(
    `SELECT *
     FROM solicitudes_visita_telegram
     WHERE chat_id_visitante = ?
       AND estado IN (?, ?, ?, ?, ?)
     ORDER BY id_solicitud DESC
     LIMIT 1`,
    [chatId, ...ESTADOS_ACTIVOS_VISITANTE]
  );

  // Si escribe /start o no tiene solicitud activa, iniciar flujo
  if (/^\/start\b/i.test(texto) || activas.length === 0) {
    if (activas.length > 0) {
      await pool.query(
        "UPDATE solicitudes_visita_telegram SET estado = 'EXPIRADA' WHERE id_solicitud = ?",
        [activas[0].id_solicitud]
      );
    }

    await pool.query(
      `INSERT INTO solicitudes_visita_telegram (
        chat_id_visitante, nombre_telegram_visitante, estado
      ) VALUES (?, ?, 'ESPERANDO_ANFITRION')`,
      [chatId, nombrePerfil]
    );

    await clienteTg.enviarMensajeTelegram(
      chatId,
      `¡Hola ${nombrePerfil}! Bienvenido al sistema de ingreso.\n\n` +
        '👤 ¿A qué empleado de la empresa vienes a visitar? (Escribe su nombre o apellido)\n' +
        '_(Si eres empleado y quieres recibir aprobaciones, escribe /empleado)_'
    );
    return;
  }

  const sol = activas[0];

  if (sol.estado === 'ESPERANDO_ANFITRION') {
    if (texto.length < 2) {
      await clienteTg.enviarMensajeTelegram(
        chatId,
        'Por favor escribe al menos 2 letras del nombre o apellido de la persona a la que visitas.'
      );
      return;
    }

    const [coincidencias] = await pool.query(
      `SELECT cedula, nombre_completo, telegram_chat_id
       FROM personas
       WHERE id_rol = 2 AND nombre_completo LIKE ?
       ORDER BY nombre_completo ASC
       LIMIT 5`,
      [`%${texto}%`]
    );

    if (coincidencias.length === 0) {
      await clienteTg.enviarMensajeTelegram(
        chatId,
        `No encontré ningún empleado que coincida con "${texto}". Intenta con otro nombre o apellido (o escribe /cancelar).`
      );
      return;
    }

    if (coincidencias.length === 1) {
      const emp = coincidencias[0];
      const destinoAprobacion = resolverDestinoAprobacion(emp);
      if (!destinoAprobacion) {
        await clienteTg.enviarMensajeTelegram(
          chatId,
          `⚠️ Encontré a ${emp.nombre_completo}, pero aún no hay un grupo de aprobaciones configurado.\n` +
            'Configura TELEGRAM_GRUPO_APROBACIONES_ID en server/.env o pide al empleado vincularse con /empleado.'
        );
        return;
      }

      await pool.query(
        `UPDATE solicitudes_visita_telegram
         SET cedula_anfitrion = ?, nombre_anfitrion = ?, chat_id_anfitrion = ?, estado = 'ESPERANDO_MOTIVO'
         WHERE id_solicitud = ?`,
        [emp.cedula, emp.nombre_completo, destinoAprobacion, sol.id_solicitud]
      );

      await clienteTg.enviarMensajeTelegram(
        chatId,
        `👤 Anfitrión: ${emp.nombre_completo}\n📝 ¿Cuál es el motivo de tu visita?`
      );
      return;
    }

    // Múltiples coincidencias -> botones inline
    await pool.query(
      `UPDATE solicitudes_visita_telegram
       SET candidatos_json = ?, estado = 'ELIGIENDO_ANFITRION'
       WHERE id_solicitud = ?`,
      [JSON.stringify(coincidencias), sol.id_solicitud]
    );

    await clienteTg.enviarMensajeTelegram(
      chatId,
      'Encontré varias personas con ese nombre. Toca el botón de la persona a la que visitas:',
      {
        reply_markup: {
          inline_keyboard: coincidencias.map((emp, idx) => [
            {
              text: emp.nombre_completo,
              callback_data: `elegir_${sol.id_solicitud}_${idx}`,
            },
          ]),
        },
      }
    );
    return;
  }

  if (sol.estado === 'ELIGIENDO_ANFITRION') {
    await clienteTg.enviarMensajeTelegram(
      chatId,
      'Por favor selecciona uno de los botones de la lista anterior (o escribe /cancelar para buscar otro nombre).'
    );
    return;
  }

  if (sol.estado === 'ESPERANDO_MOTIVO') {
    if (texto.length < 2) {
      await clienteTg.enviarMensajeTelegram(
        chatId,
        'Por favor indícame brevemente el motivo de tu visita.'
      );
      return;
    }
    await notificarAnfitrionSolicitud(pool, sol, texto.slice(0, 250), clienteTg);
    return;
  }

  if (sol.estado === 'PENDIENTE_APROBACION') {
    await clienteTg.enviarMensajeTelegram(
      chatId,
      `⏳ Tu solicitud aún está esperando la aprobación de ${sol.nombre_anfitrion}. ` +
        'Te avisaré en cuanto responda (escribe /cancelar si deseas iniciar otra solicitud).'
    );
    return;
  }

  if (sol.estado === 'APROBADA' && sol.token_formulario) {
    const urlFormulario = `${obtenerUrlPublicaApp()}/registro-visita/${sol.token_formulario}`;
    await clienteTg.enviarMensajeTelegram(
      chatId,
      `✅ Tu visita con ${sol.nombre_anfitrion} ya está aprobada.\n` +
        `Completa tus datos aquí para recibir tu código QR:\n${urlFormulario}`
    );
  }
};

/**
 * Inicia el ciclo de long polling de Telegram Bot API si TELEGRAM_BOT_TOKEN está configurado.
 * Devuelve una función `detener()` para cierre limpio del servidor.
 */
const iniciarMonitorTelegram = (pool, clienteTg = telegramApiDefecto) => {
  if (!clienteTg.telegramConfigurado()) {
    return () => {};
  }

  let activo = true;
  let ultimoUpdateId = 0;
  let controladorActual = null;

  const bucle = async () => {
    console.log('[Telegram Bot] Monitor de invitaciones activo (long polling).');
    while (activo) {
      try {
        controladorActual = new AbortController();
        const updates = await clienteTg.obtenerActualizacionesTelegram(
          ultimoUpdateId ? ultimoUpdateId + 1 : 0,
          25,
          controladorActual.signal
        );

        if (Array.isArray(updates)) {
          for (const upd of updates) {
            if (typeof upd.update_id === 'number' && upd.update_id >= ultimoUpdateId) {
              ultimoUpdateId = upd.update_id;
            }
            try {
              await procesarActualizacionTelegram(pool, upd, clienteTg);
            } catch (errUpdate) {
              console.error('[Telegram Bot] Error procesando actualización:', errUpdate.message);
            }
          }
        }
      } catch (errPoll) {
        if (!activo) break;
        if (errPoll.name !== 'AbortError') {
          console.warn('[Telegram Bot] Error en getUpdates, reintentando en 5s:', errPoll.message);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  };

  bucle();

  return () => {
    activo = false;
    if (controladorActual) controladorActual.abort();
  };
};

module.exports = {
  procesarActualizacionTelegram,
  iniciarMonitorTelegram,
};
