const crypto = require('crypto');
const whatsappApiDefecto = require('./whatsappApi');

const ESTADOS_ACTIVOS_VISITANTE = [
  'ESPERANDO_ANFITRION',
  'ELIGIENDO_ANFITRION',
  'ESPERANDO_MOTIVO',
  'PENDIENTE_APROBACION',
  'APROBADA',
];

const ESTADOS_BORRADOR_ANFITRION = [
  'ANFITRION_ESPERANDO_NOMBRE',
  'ANFITRION_ESPERANDO_MOTIVO',
];

const MAX_IDS_DEDUP = 500;
const mensajesProcesados = new Set();

const registrarMensajeProcesado = (messageId) => {
  if (!messageId) return true;
  if (mensajesProcesados.has(messageId)) return false;
  mensajesProcesados.add(messageId);
  if (mensajesProcesados.size > MAX_IDS_DEDUP) {
    const primero = mensajesProcesados.values().next().value;
    if (primero) mensajesProcesados.delete(primero);
  }
  return true;
};

const obtenerUrlPublicaApp = () =>
  String(process.env.URL_PUBLICA_APP || 'http://localhost:8080').trim().replace(/\/$/, '');

const obtenerMinutosExpiracionFormulario = () =>
  Math.max(Number(process.env.WHATSAPP_FORM_EXPIRACION_MIN) || 30, 5);

const obtenerHorasExpiracionAnfitrion = () =>
  Math.max(Number(process.env.WHATSAPP_ANFITRION_FORM_EXPIRACION_HORAS) || 24, 1);

const obtenerTelefonoRespaldo = () =>
  whatsappApiDefecto.normalizarTelefonoWhatsapp(process.env.WHATSAPP_TELEFONO_RESPALDO || '');

const obtenerAdminsTelefonos = () =>
  new Set(
    String(process.env.WHATSAPP_ADMINS_TELEFONOS || '')
      .split(',')
      .map((tel) => whatsappApiDefecto.normalizarUltimos10Digitos(tel))
      .filter((tel) => tel.length >= 7)
  );

const resolverTelefonoAnfitrion = (empleado) => {
  const telEmpleado = whatsappApiDefecto.normalizarTelefonoWhatsapp(empleado?.telefono || '');
  if (telEmpleado) return telEmpleado;
  return obtenerTelefonoRespaldo();
};

/**
 * Busca si el teléfono remitente pertenece a un Empleado registrado (id_rol = 2)
 * comparando los últimos 10 dígitos del número.
 */
const buscarEmpleadoPorTelefono = async (pool, telefono) => {
  const ult10 = whatsappApiDefecto.normalizarUltimos10Digitos(telefono);
  if (ult10.length < 7) return null;

  const [filas] = await pool.query(
    `SELECT cedula, nombre_completo, telefono
     FROM personas
     WHERE id_rol = 2
       AND telefono IS NOT NULL
       AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(telefono, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), 10) = ?
     LIMIT 1`,
    [ult10]
  );

  return filas[0] || null;
};

const enviarMenuAnfitrion = async (empleado, telefonoRemitente, clienteWa) => {
  const primerNombre = String(empleado?.nombre_completo || 'Empleado').trim().split(/\s+/)[0];
  await clienteWa.enviarBotonesWhatsapp(
    telefonoRemitente,
    `¡Hola ${primerNombre}! 👋\n` +
      'Como empleado anfitrión de Lira Seguridad puedes generar un enlace de invitación preaprobado para reenviar a tu invitado.\n\n' +
      '¿Qué deseas hacer?',
    [
      { id: 'invitar_visitante', title: 'Visitante' },
      { id: 'invitar_proveedor', title: 'Proveedor' },
      { id: 'modo_visitante', title: 'Modo Visitante' },
    ]
  );
};

const notificarAnfitrionSolicitud = async (pool, solicitud, motivo, clienteWa) => {
  await pool.query(
    `UPDATE solicitudes_visita_whatsapp
     SET motivo = ?, estado = 'PENDIENTE_APROBACION'
     WHERE id_solicitud = ?`,
    [motivo, solicitud.id_solicitud]
  );

  const textoAnfitrion =
    `🔔 Nueva solicitud de visita (#${solicitud.id_solicitud})\n\n` +
    `🏢 Anfitrión: ${solicitud.nombre_anfitrion}\n` +
    `👤 Visitante: ${solicitud.nombre_whatsapp_visitante || 'Visitante'} (+${solicitud.telefono_visitante})\n` +
    `📝 Motivo: ${motivo}\n\n` +
    '¿Autorizas el ingreso para enviarle el formulario de registro y generar su código QR?';

  try {
    await clienteWa.enviarBotonesWhatsapp(solicitud.telefono_anfitrion, textoAnfitrion, [
      { id: `aprobar_${solicitud.id_solicitud}`, title: '✅ Aprobar visita' },
      { id: `rechazar_${solicitud.id_solicitud}`, title: '❌ Rechazar' },
    ]);
  } catch (errorEnvioAnfitrion) {
    console.error(
      `[WhatsApp Bot] No se pudo notificar al anfitrión (${solicitud.telefono_anfitrion}):`,
      errorEnvioAnfitrion.message
    );
    const pista24h =
      errorEnvioAnfitrion.codigoMeta === 131047
        ? ' (El anfitrión debe haber enviado un mensaje al bot en las últimas 24h en modo prueba).'
        : '';
    await clienteWa.enviarTextoWhatsapp(
      solicitud.telefono_visitante,
      `⚠️ No se pudo contactar por WhatsApp a ${solicitud.nombre_anfitrion} en este momento${pista24h}\n` +
        'Por favor avísale en recepción o intenta nuevamente escribiendo "cancelar".'
    );
    return;
  }

  await clienteWa.enviarTextoWhatsapp(
    solicitud.telefono_visitante,
    `⏳ Solicitud enviada a ${solicitud.nombre_anfitrion}.\n` +
      'Apenas apruebe tu visita, te enviaré aquí el enlace del formulario para generar tu código QR.'
  );
};

const manejarRespuestaInteractiva = async (
  pool,
  { telefonoRemitente, nombreRemitente, replyId },
  clienteWa
) => {
  const data = String(replyId || '').trim();

  // 1) Aprobación o rechazo por parte del anfitrión (flujo visitante espontáneo)
  const matchDecision = /^(aprobar|rechazar)_(\d+)$/.exec(data);
  if (matchDecision) {
    const accion = matchDecision[1];
    const idSolicitud = Number(matchDecision[2]);

    const [filas] = await pool.query(
      'SELECT * FROM solicitudes_visita_whatsapp WHERE id_solicitud = ? LIMIT 1',
      [idSolicitud]
    );
    if (filas.length === 0) {
      await clienteWa.enviarTextoWhatsapp(telefonoRemitente, 'No encontré esa solicitud de visita.');
      return;
    }

    const sol = filas[0];
    const ult10Remitente = whatsappApiDefecto.normalizarUltimos10Digitos(telefonoRemitente);
    const ult10Anfitrion = whatsappApiDefecto.normalizarUltimos10Digitos(sol.telefono_anfitrion);
    const ult10Respaldo = whatsappApiDefecto.normalizarUltimos10Digitos(obtenerTelefonoRespaldo());
    const admins = obtenerAdminsTelefonos();

    const autorizado =
      (ult10Remitente && ult10Remitente === ult10Anfitrion) ||
      (ult10Remitente && ult10Respaldo && ult10Remitente === ult10Respaldo) ||
      (ult10Remitente && admins.has(ult10Remitente));

    if (!autorizado) {
      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        `⛔ Solo ${sol.nombre_anfitrion || 'el anfitrión asignado'} puede aprobar o rechazar esta visita.`
      );
      return;
    }

    if (sol.estado !== 'PENDIENTE_APROBACION') {
      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        `ℹ️ La solicitud #${idSolicitud} ya fue procesada (${sol.estado}).`
      );
      return;
    }

    if (accion === 'aprobar') {
      const tokenFormulario = crypto.randomBytes(24).toString('hex');
      const minutosExp = obtenerMinutosExpiracionFormulario();

      await pool.query(
        `UPDATE solicitudes_visita_whatsapp
         SET estado = 'APROBADA',
             token_formulario = ?,
             token_expira_en = DATE_ADD(NOW(), INTERVAL ? MINUTE)
         WHERE id_solicitud = ?`,
        [tokenFormulario, minutosExp, idSolicitud]
      );

      const urlFormulario = `${obtenerUrlPublicaApp()}/registro-visita/${tokenFormulario}`;

      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        `✅ Visita #${idSolicitud} aprobada (${nombreRemitente || sol.nombre_anfitrion}).\n` +
          `👤 Visitante: ${sol.nombre_whatsapp_visitante || 'Visitante'}\n` +
          `📝 Motivo: ${sol.motivo || 'Visita autorizada'}\n` +
          'Ya enviamos el formulario de registro al visitante.'
      );

      await clienteWa.enviarTextoWhatsapp(
        sol.telefono_visitante,
        `✅ ¡Tu visita con ${sol.nombre_anfitrion} fue aprobada!\n\n` +
          `Completa tus datos en el siguiente enlace para generar tu código QR de ingreso (válido por ${minutosExp} minutos, un solo uso):\n\n` +
          `${urlFormulario}`,
        { previewUrl: true }
      );
      return;
    }

    // Rechazar
    await pool.query(
      "UPDATE solicitudes_visita_whatsapp SET estado = 'RECHAZADA' WHERE id_solicitud = ?",
      [idSolicitud]
    );
    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `❌ Visita #${idSolicitud} rechazada.\n` +
        `👤 Visitante: ${sol.nombre_whatsapp_visitante || 'Visitante'}`
    );
    await clienteWa.enviarTextoWhatsapp(
      sol.telefono_visitante,
      `❌ Tu solicitud de visita con ${sol.nombre_anfitrion} no fue autorizada.\n` +
        'Si necesitas intentarlo con otra persona, escribe "Hola".'
    );
    return;
  }

  // 2) Visitante eligiendo un anfitrión de la lista de coincidencias
  const matchElegir = /^elegir_(\d+)_(\d+)$/.exec(data);
  if (matchElegir) {
    const idSolicitud = Number(matchElegir[1]);
    const indice = Number(matchElegir[2]);

    const [filas] = await pool.query(
      'SELECT * FROM solicitudes_visita_whatsapp WHERE id_solicitud = ? LIMIT 1',
      [idSolicitud]
    );
    if (filas.length === 0) {
      await clienteWa.enviarTextoWhatsapp(telefonoRemitente, 'Solicitud no encontrada.');
      return;
    }

    const sol = filas[0];
    if (
      String(sol.telefono_visitante) !== String(telefonoRemitente) ||
      sol.estado !== 'ELIGIENDO_ANFITRION'
    ) {
      await clienteWa.enviarTextoWhatsapp(telefonoRemitente, 'Esta selección ya no está vigente.');
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
      await clienteWa.enviarTextoWhatsapp(telefonoRemitente, 'Opción inválida.');
      return;
    }

    const telefonoAnfitrion = resolverTelefonoAnfitrion(elegido);
    if (!telefonoAnfitrion) {
      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        `⚠️ ${elegido.nombre_completo} no tiene número de celular registrado para recibir aprobaciones por WhatsApp.\n` +
          'Intenta con otro anfitrión o solicita ayuda en recepción.'
      );
      await pool.query(
        "UPDATE solicitudes_visita_whatsapp SET estado = 'ESPERANDO_ANFITRION', candidatos_json = NULL WHERE id_solicitud = ?",
        [idSolicitud]
      );
      return;
    }

    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET cedula_anfitrion = ?, nombre_anfitrion = ?, telefono_anfitrion = ?,
           candidatos_json = NULL, estado = 'ESPERANDO_MOTIVO'
       WHERE id_solicitud = ?`,
      [elegido.cedula, elegido.nombre_completo, telefonoAnfitrion, idSolicitud]
    );

    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `👤 Anfitrión seleccionado: ${elegido.nombre_completo}\n📝 ¿Cuál es el motivo de tu visita?`
    );
    return;
  }

  // 3) Empleado eligiendo tipo de invitación en el Flujo Anfitrión
  if (data === 'invitar_visitante' || data === 'invitar_proveedor') {
    const empleado = await buscarEmpleadoPorTelefono(pool, telefonoRemitente);
    if (!empleado) {
      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        'Esta opción es exclusiva para empleados registrados. Escribe "Hola" para solicitar una visita.'
      );
      return;
    }

    const rolInvitado = data === 'invitar_proveedor' ? 3 : 1;
    const etiquetaRol = rolInvitado === 3 ? 'Proveedor' : 'Visitante';

    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET estado = 'EXPIRADA'
       WHERE telefono_anfitrion = ? AND origen = 'ANFITRION' AND estado IN (?, ?)`,
      [telefonoRemitente, ...ESTADOS_BORRADOR_ANFITRION]
    );
    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET estado = 'EXPIRADA'
       WHERE telefono_visitante = ? AND origen = 'VISITANTE' AND estado IN (?, ?, ?, ?, ?)`,
      [telefonoRemitente, ...ESTADOS_ACTIVOS_VISITANTE]
    );

    await pool.query(
      `INSERT INTO solicitudes_visita_whatsapp (
        origen, rol_invitado, telefono_visitante, cedula_anfitrion, nombre_anfitrion, telefono_anfitrion, estado
      ) VALUES ('ANFITRION', ?, NULL, ?, ?, ?, 'ANFITRION_ESPERANDO_NOMBRE')`,
      [rolInvitado, empleado.cedula, empleado.nombre_completo, telefonoRemitente]
    );

    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `Perfecto, crearemos una invitación preaprobada de tipo *${etiquetaRol}*.\n\n` +
        `👤 ¿Cuál es el nombre completo del ${etiquetaRol.toLowerCase()}?`
    );
    return;
  }

  // 4) Empleado optando por entrar al flujo normal de visitante espontáneo
  if (data === 'modo_visitante') {
    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET estado = 'EXPIRADA'
       WHERE telefono_anfitrion = ? AND origen = 'ANFITRION' AND estado IN (?, ?)`,
      [telefonoRemitente, ...ESTADOS_BORRADOR_ANFITRION]
    );
    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET estado = 'EXPIRADA'
       WHERE telefono_visitante = ? AND origen = 'VISITANTE' AND estado IN (?, ?, ?, ?, ?)`,
      [telefonoRemitente, ...ESTADOS_ACTIVOS_VISITANTE]
    );

    await pool.query(
      `INSERT INTO solicitudes_visita_whatsapp (
        origen, rol_invitado, telefono_visitante, nombre_whatsapp_visitante, estado
      ) VALUES ('VISITANTE', 1, ?, ?, 'ESPERANDO_ANFITRION')`,
      [telefonoRemitente, nombreRemitente || 'Visitante']
    );

    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      'Has entrado en modo visitante.\n\n' +
        '👤 ¿A qué empleado de la empresa vienes a visitar? (Escribe su nombre o apellido)'
    );
  }
};

const manejarFlujoAnfitrionTexto = async (
  pool,
  { empleado, telefonoRemitente, textoLimpio },
  clienteWa
) => {
  const [borradores] = await pool.query(
    `SELECT *
     FROM solicitudes_visita_whatsapp
     WHERE telefono_anfitrion = ?
       AND origen = 'ANFITRION'
       AND estado IN (?, ?)
     ORDER BY id_solicitud DESC
     LIMIT 1`,
    [telefonoRemitente, ...ESTADOS_BORRADOR_ANFITRION]
  );

  const esComandoMenuExplicito = /^\/?(start|menu|menú)$/i.test(textoLimpio);
  const esSaludoOInvitar = /^\/?(start|hola|inicio|menu|menú|invitar|visita|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches)$/i.test(
    textoLimpio
  );

  if (borradores.length === 0 || esComandoMenuExplicito || (esSaludoOInvitar && borradores[0].estado !== 'ANFITRION_ESPERANDO_MOTIVO')) {
    if (borradores.length > 0) {
      await pool.query(
        "UPDATE solicitudes_visita_whatsapp SET estado = 'EXPIRADA' WHERE id_solicitud = ?",
        [borradores[0].id_solicitud]
      );
    }
    await enviarMenuAnfitrion(empleado, telefonoRemitente, clienteWa);
    return;
  }

  const borrador = borradores[0];
  const etiquetaRol = Number(borrador.rol_invitado) === 3 ? 'Proveedor' : 'Visitante';

  if (borrador.estado === 'ANFITRION_ESPERANDO_NOMBRE') {
    if (textoLimpio.length < 2) {
      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        `Por favor escribe el nombre completo del ${etiquetaRol.toLowerCase()} (mínimo 2 caracteres).`
      );
      return;
    }

    const nombreInvitado = textoLimpio.slice(0, 120);
    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET nombre_whatsapp_visitante = ?, estado = 'ANFITRION_ESPERANDO_MOTIVO'
       WHERE id_solicitud = ?`,
      [nombreInvitado, borrador.id_solicitud]
    );

    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `👤 ${etiquetaRol}: *${nombreInvitado}*\n` +
        '📝 ¿Cuál es el motivo de la visita? (o escribe *Omitir* para dejar "Visita programada")'
    );
    return;
  }

  if (borrador.estado === 'ANFITRION_ESPERANDO_MOTIVO') {
    const motivoFinal = /^omitir$/i.test(textoLimpio)
      ? 'Visita programada'
      : textoLimpio.slice(0, 250);

    const tokenFormulario = crypto.randomBytes(24).toString('hex');
    const horasExp = obtenerHorasExpiracionAnfitrion();

    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET motivo = ?,
           estado = 'APROBADA',
           token_formulario = ?,
           token_expira_en = DATE_ADD(NOW(), INTERVAL ? HOUR)
       WHERE id_solicitud = ?`,
      [motivoFinal, tokenFormulario, horasExp, borrador.id_solicitud]
    );

    const urlFormulario = `${obtenerUrlPublicaApp()}/registro-visita/${tokenFormulario}`;
    const nombreInvitado = borrador.nombre_whatsapp_visitante || etiquetaRol;

    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `✅ Invitación preaprobada creada (#${borrador.id_solicitud})\n` +
        `👤 ${etiquetaRol}: ${nombreInvitado}\n` +
        `📝 Motivo: ${motivoFinal}\n` +
        `⏰ Vigencia del enlace: ${horasExp} horas (un solo uso).\n\n` +
        'Reenvía el siguiente mensaje a tu invitado 👇'
    );

    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `¡Hola ${nombreInvitado}! 👋\n` +
        `${empleado.nombre_completo} te ha invitado a visitar Lira Seguridad (${motivoFinal}).\n\n` +
        'Completa tus datos en este enlace para generar tu código QR de ingreso:\n' +
        `${urlFormulario}`,
      { previewUrl: true }
    );
  }
};

const manejarMensajeTexto = async (
  pool,
  { telefonoRemitente, nombreRemitente, texto },
  clienteWa
) => {
  const textoLimpio = String(texto || '').trim();
  const nombrePerfil = nombreRemitente || 'Visitante';

  // 1) Cancelar / reiniciar cualquier flujo activo (anfitrión o visitante)
  if (/^\/?(cancelar|reiniciar)\b/i.test(textoLimpio)) {
    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET estado = 'EXPIRADA'
       WHERE telefono_anfitrion = ? AND origen = 'ANFITRION' AND estado IN (?, ?)`,
      [telefonoRemitente, ...ESTADOS_BORRADOR_ANFITRION]
    );
    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET estado = 'EXPIRADA'
       WHERE telefono_visitante = ? AND origen = 'VISITANTE' AND estado IN (?, ?, ?, ?, ?)`,
      [telefonoRemitente, ...ESTADOS_ACTIVOS_VISITANTE]
    );
    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      'Solicitud cancelada. Cuando quieras iniciar de nuevo escribe "Hola".'
    );
    return;
  }

  // 2) Enrutamiento dual: verificar si el remitente es Empleado registrado (id_rol = 2)
  const empleado = await buscarEmpleadoPorTelefono(pool, telefonoRemitente);

  // Buscar si tiene una sesión activa de visitante espontáneo
  const [activasVisitante] = await pool.query(
    `SELECT *
     FROM solicitudes_visita_whatsapp
     WHERE telefono_visitante = ?
       AND origen = 'VISITANTE'
       AND estado IN (?, ?, ?, ?, ?)
     ORDER BY id_solicitud DESC
     LIMIT 1`,
    [telefonoRemitente, ...ESTADOS_ACTIVOS_VISITANTE]
  );

  const esSaludoOInicio = /^\/?(start|hola|inicio|menu|invitar|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|visita)$/i.test(
    textoLimpio
  );

  // Si es Empleado: priorizar borrador activo de anfitrión sobre cualquier sesión previa de visitante
  if (empleado) {
    const [borradoresAnfitrion] = await pool.query(
      `SELECT id_solicitud
       FROM solicitudes_visita_whatsapp
       WHERE telefono_anfitrion = ?
         AND origen = 'ANFITRION'
         AND estado IN (?, ?)
       ORDER BY id_solicitud DESC
       LIMIT 1`,
      [telefonoRemitente, ...ESTADOS_BORRADOR_ANFITRION]
    );

    const enFlujoVisitanteActivo =
      borradoresAnfitrion.length === 0 &&
      activasVisitante.length > 0 &&
      activasVisitante[0].estado !== 'APROBADA' &&
      !esSaludoOInicio;

    if (!enFlujoVisitanteActivo) {
      await manejarFlujoAnfitrionTexto(
        pool,
        { empleado, telefonoRemitente, textoLimpio },
        clienteWa
      );
      return;
    }
  }

  // 3) Flujo Visitante espontáneo (sin cambios en lógica de negocio)
  if (
    activasVisitante.length === 0 ||
    (esSaludoOInicio && activasVisitante[0].estado !== 'ESPERANDO_MOTIVO')
  ) {
    if (activasVisitante.length > 0) {
      await pool.query(
        "UPDATE solicitudes_visita_whatsapp SET estado = 'EXPIRADA' WHERE id_solicitud = ?",
        [activasVisitante[0].id_solicitud]
      );
    }

    await pool.query(
      `INSERT INTO solicitudes_visita_whatsapp (
        origen, rol_invitado, telefono_visitante, nombre_whatsapp_visitante, estado
      ) VALUES ('VISITANTE', 1, ?, ?, 'ESPERANDO_ANFITRION')`,
      [telefonoRemitente, nombrePerfil]
    );

    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `¡Hola ${nombrePerfil}! Bienvenido al sistema de ingreso de Lira Seguridad.\n\n` +
        '👤 ¿A qué empleado de la empresa vienes a visitar? (Escribe su nombre o apellido)'
    );
    return;
  }

  const sol = activasVisitante[0];

  if (sol.estado === 'ESPERANDO_ANFITRION') {
    if (textoLimpio.length < 2) {
      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        'Por favor escribe al menos 2 letras del nombre o apellido de la persona a la que visitas.'
      );
      return;
    }

    const [coincidencias] = await pool.query(
      `SELECT cedula, nombre_completo, telefono
       FROM personas
       WHERE id_rol = 2 AND nombre_completo LIKE ?
       ORDER BY nombre_completo ASC
       LIMIT 5`,
      [`%${textoLimpio}%`]
    );

    if (coincidencias.length === 0) {
      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        `No encontré ningún empleado que coincida con "${textoLimpio}". Intenta con otro nombre o apellido (o escribe "cancelar").`
      );
      return;
    }

    if (coincidencias.length === 1) {
      const emp = coincidencias[0];
      const telefonoAnfitrion = resolverTelefonoAnfitrion(emp);
      if (!telefonoAnfitrion) {
        await clienteWa.enviarTextoWhatsapp(
          telefonoRemitente,
          `⚠️ Encontré a ${emp.nombre_completo}, pero no tiene un número de celular registrado para recibir aprobaciones por WhatsApp.\n` +
            'Verifica el teléfono del empleado en el Dashboard o configura WHATSAPP_TELEFONO_RESPALDO.'
        );
        return;
      }

      await pool.query(
        `UPDATE solicitudes_visita_whatsapp
         SET cedula_anfitrion = ?, nombre_anfitrion = ?, telefono_anfitrion = ?, estado = 'ESPERANDO_MOTIVO'
         WHERE id_solicitud = ?`,
        [emp.cedula, emp.nombre_completo, telefonoAnfitrion, sol.id_solicitud]
      );

      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        `👤 Anfitrión: ${emp.nombre_completo}\n📝 ¿Cuál es el motivo de tu visita?`
      );
      return;
    }

    // Múltiples coincidencias -> lista interactiva de WhatsApp
    await pool.query(
      `UPDATE solicitudes_visita_whatsapp
       SET candidatos_json = ?, estado = 'ELIGIENDO_ANFITRION'
       WHERE id_solicitud = ?`,
      [JSON.stringify(coincidencias), sol.id_solicitud]
    );

    await clienteWa.enviarListaWhatsapp(
      telefonoRemitente,
      'Encontré varias personas con ese nombre. Selecciona de la lista a la persona a la que visitas:',
      'Elegir anfitrión',
      'Empleados',
      coincidencias.map((emp, idx) => ({
        id: `elegir_${sol.id_solicitud}_${idx}`,
        title: emp.nombre_completo,
        description: emp.nombre_completo.length > 24 ? emp.nombre_completo : undefined,
      }))
    );
    return;
  }

  if (sol.estado === 'ELIGIENDO_ANFITRION') {
    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      'Por favor selecciona una persona de la lista anterior (o escribe "cancelar" para buscar otro nombre).'
    );
    return;
  }

  if (sol.estado === 'ESPERANDO_MOTIVO') {
    if (textoLimpio.length < 2) {
      await clienteWa.enviarTextoWhatsapp(
        telefonoRemitente,
        'Por favor indícame brevemente el motivo de tu visita.'
      );
      return;
    }
    await notificarAnfitrionSolicitud(pool, sol, textoLimpio.slice(0, 250), clienteWa);
    return;
  }

  if (sol.estado === 'PENDIENTE_APROBACION') {
    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `⏳ Tu solicitud aún está esperando la aprobación de ${sol.nombre_anfitrion}. ` +
        'Te avisaré en cuanto responda (escribe "cancelar" si deseas iniciar otra solicitud).'
    );
    return;
  }

  if (sol.estado === 'APROBADA' && sol.token_formulario) {
    const urlFormulario = `${obtenerUrlPublicaApp()}/registro-visita/${sol.token_formulario}`;
    await clienteWa.enviarTextoWhatsapp(
      telefonoRemitente,
      `✅ Tu visita con ${sol.nombre_anfitrion} ya está aprobada.\n` +
        `Completa tus datos aquí para recibir tu código QR:\n${urlFormulario}`,
      { previewUrl: true }
    );
  }
};

/**
 * Procesa el payload completo recibido en POST /api/whatsapp/webhook desde Meta Cloud API.
 */
const procesarWebhookWhatsapp = async (
  pool,
  payload,
  clienteWa = whatsappApiDefecto
) => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entry)) {
    return;
  }

  for (const entrada of payload.entry) {
    const cambios = Array.isArray(entrada?.changes) ? entrada.changes : [];
    for (const cambio of cambios) {
      const valor = cambio?.value;
      if (!valor || !Array.isArray(valor.messages)) continue;

      const contactos = Array.isArray(valor.contacts) ? valor.contacts : [];
      const nombresPorWaId = new Map();
      for (const c of contactos) {
        if (c?.wa_id) {
          nombresPorWaId.set(String(c.wa_id), String(c?.profile?.name || '').trim());
        }
      }

      for (const mensaje of valor.messages) {
        const messageId = mensaje?.id ? String(mensaje.id) : '';
        if (messageId && !registrarMensajeProcesado(messageId)) {
          continue;
        }

        const telefonoRemitente = whatsappApiDefecto.normalizarTelefonoWhatsapp(mensaje?.from || '');
        if (!telefonoRemitente) continue;

        const nombreRemitente = nombresPorWaId.get(String(mensaje.from)) || 'Visitante';

        if (messageId && typeof clienteWa.marcarMensajeLeidoWhatsapp === 'function') {
          clienteWa.marcarMensajeLeidoWhatsapp(messageId).catch(() => {});
        }

        try {
          if (mensaje.type === 'interactive') {
            const replyId =
              mensaje.interactive?.button_reply?.id ||
              mensaje.interactive?.list_reply?.id ||
              '';
            if (replyId) {
              await manejarRespuestaInteractiva(
                pool,
                { telefonoRemitente, nombreRemitente, replyId },
                clienteWa
              );
            }
          } else if (mensaje.type === 'text') {
            const texto = String(mensaje.text?.body || '').trim();
            if (texto) {
              await manejarMensajeTexto(
                pool,
                { telefonoRemitente, nombreRemitente, texto },
                clienteWa
              );
            }
          } else if (mensaje.type === 'button') {
            // Soporte para respuestas rápidas de plantillas (Quick Reply)
            const replyId = String(mensaje.button?.payload || '').trim();
            if (replyId) {
              await manejarRespuestaInteractiva(
                pool,
                { telefonoRemitente, nombreRemitente, replyId },
                clienteWa
              );
            }
          }
        } catch (errorMensaje) {
          console.error(
            `[WhatsApp Bot] Error procesando mensaje ${messageId || 'sin-id'}:`,
            errorMensaje.message
          );
        }
      }
    }
  }
};

const limpiarCacheMensajesProcesados = () => {
  mensajesProcesados.clear();
};

module.exports = {
  procesarWebhookWhatsapp,
  limpiarCacheMensajesProcesados,
  buscarEmpleadoPorTelefono,
};
