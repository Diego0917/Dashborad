const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  normalizarTelefonoWhatsapp,
  normalizarUltimos10Digitos,
  verificarFirmaMeta,
} = require('../whatsappApi');
const {
  procesarWebhookWhatsapp,
  limpiarCacheMensajesProcesados,
} = require('../flujoWhatsapp');

const crearPayloadMensaje = ({
  from,
  nombre = 'Juan Visitante',
  id,
  type = 'text',
  text,
  interactive,
}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_TEST',
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ wa_id: from, profile: { name: nombre } }],
            messages: [
              {
                from,
                id,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type,
                ...(text ? { text: { body: text } } : {}),
                ...(interactive ? { interactive } : {}),
              },
            ],
          },
        },
      ],
    },
  ],
});

const crearEntornoMock = () => {
  const enviados = [];
  const clienteMock = {
    enviarTextoWhatsapp: async (to, text) => enviados.push({ tipo: 'text', to, text }),
    enviarBotonesWhatsapp: async (to, text, buttons) =>
      enviados.push({ tipo: 'buttons', to, text, buttons }),
    enviarListaWhatsapp: async (to, text, buttonText, sectionTitle, rows) =>
      enviados.push({ tipo: 'list', to, text, buttonText, sectionTitle, rows }),
    marcarMensajeLeidoWhatsapp: async () => null,
  };

  const solicitudes = [];
  let seq = 1;
  const empleados = [
    { cedula: '101', nombre_completo: 'Carlos Pérez', telefono: '3001112222' },
    { cedula: '102', nombre_completo: 'Carlos Gómez', telefono: '3003334444' },
  ];

  const poolMock = {
    query: async (sql, params = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();

      // Lookup de empleado por últimos 10 dígitos del teléfono
      if (q.includes('FROM personas') && q.includes('RIGHT(REPLACE(')) {
        const ult10 = String(params[0] || '');
        const match = empleados.find(
          (e) => normalizarUltimos10Digitos(e.telefono) === ult10
        );
        return [match ? [match] : []];
      }

      // Búsqueda de empleados por nombre
      if (q.startsWith('SELECT cedula, nombre_completo, telefono FROM personas')) {
        const patron = String(params[0] || '').replace(/%/g, '').toLowerCase();
        return [empleados.filter((e) => e.nombre_completo.toLowerCase().includes(patron))];
      }

      // Sesiones activas de visitante
      if (q.includes("FROM solicitudes_visita_whatsapp WHERE telefono_visitante = ? AND origen = 'VISITANTE'")) {
        const tel = params[0];
        const estados = params.slice(1);
        const activas = solicitudes
          .filter(
            (s) =>
              s.telefono_visitante === tel &&
              s.origen === 'VISITANTE' &&
              estados.includes(s.estado)
          )
          .sort((a, b) => b.id_solicitud - a.id_solicitud);
        return [activas.slice(0, 1)];
      }

      // Borradores activos de anfitrión
      if (q.includes("FROM solicitudes_visita_whatsapp WHERE telefono_anfitrion = ? AND origen = 'ANFITRION'")) {
        const tel = params[0];
        const estados = params.slice(1);
        const activas = solicitudes
          .filter(
            (s) =>
              s.telefono_anfitrion === tel &&
              s.origen === 'ANFITRION' &&
              estados.includes(s.estado)
          )
          .sort((a, b) => b.id_solicitud - a.id_solicitud);
        return [activas.slice(0, 1)];
      }

      // Lookup por id_solicitud
      if (q.startsWith('SELECT * FROM solicitudes_visita_whatsapp WHERE id_solicitud = ?')) {
        const encontrada = solicitudes.find((s) => s.id_solicitud === Number(params[0]));
        return [encontrada ? [encontrada] : []];
      }

      // INSERT flujo anfitrión
      if (q.includes("VALUES ('ANFITRION', ?, NULL, ?, ?, ?, 'ANFITRION_ESPERANDO_NOMBRE')")) {
        const nueva = {
          id_solicitud: seq++,
          origen: 'ANFITRION',
          rol_invitado: Number(params[0]),
          telefono_visitante: null,
          nombre_whatsapp_visitante: null,
          cedula_anfitrion: params[1],
          nombre_anfitrion: params[2],
          telefono_anfitrion: params[3],
          estado: 'ANFITRION_ESPERANDO_NOMBRE',
          candidatos_json: null,
          motivo: null,
          token_formulario: null,
        };
        solicitudes.push(nueva);
        return [{ insertId: nueva.id_solicitud }];
      }

      // INSERT flujo visitante
      if (q.includes("VALUES ('VISITANTE', 1, ?, ?, 'ESPERANDO_ANFITRION')")) {
        const nueva = {
          id_solicitud: seq++,
          origen: 'VISITANTE',
          rol_invitado: 1,
          telefono_visitante: params[0],
          nombre_whatsapp_visitante: params[1],
          estado: 'ESPERANDO_ANFITRION',
          candidatos_json: null,
          cedula_anfitrion: null,
          nombre_anfitrion: null,
          telefono_anfitrion: null,
          motivo: null,
          token_formulario: null,
        };
        solicitudes.push(nueva);
        return [{ insertId: nueva.id_solicitud }];
      }

      // Expirar sesiones
      if (q.startsWith("UPDATE solicitudes_visita_whatsapp SET estado = 'EXPIRADA'")) {
        if (q.includes("WHERE telefono_visitante = ? AND origen = 'VISITANTE'")) {
          const tel = params[0];
          const estados = params.slice(1);
          for (const s of solicitudes) {
            if (s.telefono_visitante === tel && s.origen === 'VISITANTE' && estados.includes(s.estado)) {
              s.estado = 'EXPIRADA';
            }
          }
        } else if (q.includes("WHERE telefono_anfitrion = ? AND origen = 'ANFITRION'")) {
          const tel = params[0];
          const estados = params.slice(1);
          for (const s of solicitudes) {
            if (s.telefono_anfitrion === tel && s.origen === 'ANFITRION' && estados.includes(s.estado)) {
              s.estado = 'EXPIRADA';
            }
          }
        }
        return [{ affectedRows: 1 }];
      }

      if (q.includes("SET nombre_whatsapp_visitante = ?, estado = 'ANFITRION_ESPERANDO_MOTIVO'")) {
        const sol = solicitudes.find((s) => s.id_solicitud === Number(params[1]));
        sol.nombre_whatsapp_visitante = params[0];
        sol.estado = 'ANFITRION_ESPERANDO_MOTIVO';
        return [{ affectedRows: 1 }];
      }

      if (q.includes("SET motivo = ?, estado = 'APROBADA', token_formulario = ?")) {
        const sol = solicitudes.find((s) => s.id_solicitud === Number(params[3]));
        sol.motivo = params[0];
        sol.estado = 'APROBADA';
        sol.token_formulario = params[1];
        return [{ affectedRows: 1 }];
      }

      if (q.includes("SET candidatos_json = ?, estado = 'ELIGIENDO_ANFITRION'")) {
        const sol = solicitudes.find((s) => s.id_solicitud === Number(params[1]));
        sol.candidatos_json = params[0];
        sol.estado = 'ELIGIENDO_ANFITRION';
        return [{ affectedRows: 1 }];
      }

      if (
        q.includes("SET cedula_anfitrion = ?, nombre_anfitrion = ?, telefono_anfitrion = ?, estado = 'ESPERANDO_MOTIVO'") ||
        q.includes("candidatos_json = NULL, estado = 'ESPERANDO_MOTIVO'")
      ) {
        const sol = solicitudes.find((s) => s.id_solicitud === Number(params[3]));
        sol.cedula_anfitrion = params[0];
        sol.nombre_anfitrion = params[1];
        sol.telefono_anfitrion = params[2];
        sol.candidatos_json = null;
        sol.estado = 'ESPERANDO_MOTIVO';
        return [{ affectedRows: 1 }];
      }

      if (q.includes("SET motivo = ?, estado = 'PENDIENTE_APROBACION'")) {
        const sol = solicitudes.find((s) => s.id_solicitud === Number(params[1]));
        sol.motivo = params[0];
        sol.estado = 'PENDIENTE_APROBACION';
        return [{ affectedRows: 1 }];
      }

      if (q.includes("SET estado = 'APROBADA', token_formulario = ?")) {
        const sol = solicitudes.find((s) => s.id_solicitud === Number(params[2]));
        sol.estado = 'APROBADA';
        sol.token_formulario = params[0];
        return [{ affectedRows: 1 }];
      }

      return [[]];
    },
  };

  return { enviados, clienteMock, solicitudes, poolMock };
};

test('normalizarTelefonoWhatsapp formatea números locales y E.164', () => {
  assert.equal(normalizarTelefonoWhatsapp('300 123-4567', '57'), '573001234567');
  assert.equal(normalizarTelefonoWhatsapp('+57 310 999 8888', '57'), '573109998888');
  assert.equal(normalizarUltimos10Digitos('+57 310 999 8888'), '3109998888');
  assert.equal(normalizarTelefonoWhatsapp('', '57'), '');
});

test('verificarFirmaMeta valida firma HMAC-SHA256 correctamente', () => {
  const raw = Buffer.from('{"entry":[]}', 'utf8');
  const secreto = 'mi_app_secret_test';
  const firmaValida =
    'sha256=' + crypto.createHmac('sha256', secreto).update(raw).digest('hex');

  assert.equal(verificarFirmaMeta(raw, firmaValida, secreto), true);
  assert.equal(verificarFirmaMeta(raw, 'sha256=0000', secreto), false);
  assert.equal(verificarFirmaMeta(raw, undefined, secreto), false);
  assert.equal(verificarFirmaMeta(raw, undefined, ''), true);
});

test('flujo visitante espontáneo: saludo -> lista de anfitriones -> motivo -> aprobación', async () => {
  limpiarCacheMensajesProcesados();
  const { enviados, clienteMock, solicitudes, poolMock } = crearEntornoMock();

  // 1) Visitante (no empleado) saluda
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({ from: '573205550000', id: 'wamid.1', text: 'Hola' }),
    clienteMock
  );
  assert.equal(solicitudes.length, 1);
  assert.equal(solicitudes[0].origen, 'VISITANTE');
  assert.equal(solicitudes[0].estado, 'ESPERANDO_ANFITRION');

  // Reintento duplicado del mismo wamid.1 debe ignorarse
  const conteoAntes = enviados.length;
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({ from: '573205550000', id: 'wamid.1', text: 'Hola' }),
    clienteMock
  );
  assert.equal(enviados.length, conteoAntes);

  // 2) Visitante busca "Carlos" -> recibe lista interactiva con 2 opciones
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({ from: '573205550000', id: 'wamid.2', text: 'Carlos' }),
    clienteMock
  );
  assert.equal(solicitudes[0].estado, 'ELIGIENDO_ANFITRION');
  const ultimoMsg = enviados[enviados.length - 1];
  assert.equal(ultimoMsg.tipo, 'list');
  assert.equal(ultimoMsg.rows.length, 2);

  // 3) Visitante selecciona "Carlos Pérez" (índice 0)
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({
      from: '573205550000',
      id: 'wamid.3',
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'elegir_1_0', title: 'Carlos Pérez' } },
    }),
    clienteMock
  );
  assert.equal(solicitudes[0].estado, 'ESPERANDO_MOTIVO');
  assert.equal(solicitudes[0].telefono_anfitrion, '573001112222');

  // 4) Visitante escribe motivo -> anfitrión recibe botones Aprobar / Rechazar
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({ from: '573205550000', id: 'wamid.4', text: 'Reunión de soporte' }),
    clienteMock
  );
  assert.equal(solicitudes[0].estado, 'PENDIENTE_APROBACION');
  const msgBotones = enviados.find((m) => m.tipo === 'buttons');
  assert.ok(msgBotones);
  assert.equal(msgBotones.to, '573001112222');
  assert.equal(msgBotones.buttons[0].id, 'aprobar_1');

  // 5) Anfitrión pulsa "Aprobar visita" -> visitante recibe enlace con token
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({
      from: '573001112222',
      nombre: 'Carlos Pérez',
      id: 'wamid.5',
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'aprobar_1', title: 'Aprobar visita' },
      },
    }),
    clienteMock
  );
  assert.equal(solicitudes[0].estado, 'APROBADA');
  assert.ok(solicitudes[0].token_formulario && solicitudes[0].token_formulario.length === 48);
  const msgEnlace = enviados[enviados.length - 1];
  assert.equal(msgEnlace.to, '573205550000');
  assert.match(msgEnlace.text, /\/registro-visita\/[a-f0-9]{48}/);
});

test('flujo anfitrión (empleado): saludo -> botones -> invitar proveedor -> enlace preaprobado', async () => {
  limpiarCacheMensajesProcesados();
  const { enviados, clienteMock, solicitudes, poolMock } = crearEntornoMock();

  // 1) Empleado (Carlos Pérez, 573001112222) escribe "Hola" -> recibe menú de 3 botones
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({
      from: '573001112222',
      nombre: 'Carlos Pérez',
      id: 'wamid.emp.1',
      text: 'Hola',
    }),
    clienteMock
  );
  assert.equal(solicitudes.length, 0);
  const msgMenu = enviados[enviados.length - 1];
  assert.equal(msgMenu.tipo, 'buttons');
  assert.equal(msgMenu.buttons.length, 3);
  assert.equal(msgMenu.buttons[0].id, 'invitar_visitante');
  assert.equal(msgMenu.buttons[1].id, 'invitar_proveedor');
  assert.equal(msgMenu.buttons[2].id, 'modo_visitante');

  // 2) Empleado elige "Proveedor"
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({
      from: '573001112222',
      nombre: 'Carlos Pérez',
      id: 'wamid.emp.2',
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'invitar_proveedor', title: 'Proveedor' },
      },
    }),
    clienteMock
  );
  assert.equal(solicitudes.length, 1);
  assert.equal(solicitudes[0].origen, 'ANFITRION');
  assert.equal(solicitudes[0].rol_invitado, 3);
  assert.equal(solicitudes[0].telefono_visitante, null);
  assert.equal(solicitudes[0].estado, 'ANFITRION_ESPERANDO_NOMBRE');

  // 3) Empleado escribe nombre del proveedor
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({
      from: '573001112222',
      nombre: 'Carlos Pérez',
      id: 'wamid.emp.3',
      text: 'María Rodríguez',
    }),
    clienteMock
  );
  assert.equal(solicitudes[0].nombre_whatsapp_visitante, 'María Rodríguez');
  assert.equal(solicitudes[0].estado, 'ANFITRION_ESPERANDO_MOTIVO');

  // 4) Empleado escribe "Visita" como motivo -> NO debe reiniciar menú, debe generar enlace APROBADA
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({
      from: '573001112222',
      nombre: 'Carlos Pérez',
      id: 'wamid.emp.4',
      text: 'Visita',
    }),
    clienteMock
  );
  assert.equal(solicitudes[0].estado, 'APROBADA');
  assert.equal(solicitudes[0].motivo, 'Visita');
  assert.ok(solicitudes[0].token_formulario && solicitudes[0].token_formulario.length === 48);
  const msgReenviable = enviados[enviados.length - 1];
  assert.equal(msgReenviable.to, '573001112222');
  assert.match(msgReenviable.text, /María Rodríguez/);
  assert.match(msgReenviable.text, /\/registro-visita\/[a-f0-9]{48}/);
});

test('empleado puede elegir Modo Visitante y buscar otro anfitrión', async () => {
  limpiarCacheMensajesProcesados();
  const { enviados, clienteMock, solicitudes, poolMock } = crearEntornoMock();

  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({
      from: '573001112222',
      nombre: 'Carlos Pérez',
      id: 'wamid.mod.1',
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'modo_visitante', title: 'Modo Visitante' },
      },
    }),
    clienteMock
  );
  assert.equal(solicitudes.length, 1);
  assert.equal(solicitudes[0].origen, 'VISITANTE');
  assert.equal(solicitudes[0].estado, 'ESPERANDO_ANFITRION');

  // Siguiente texto continúa en flujo visitante (no regresa al menú de anfitrión)
  await procesarWebhookWhatsapp(
    poolMock,
    crearPayloadMensaje({
      from: '573001112222',
      nombre: 'Carlos Pérez',
      id: 'wamid.mod.2',
      text: 'Gómez',
    }),
    clienteMock
  );
  assert.equal(solicitudes[0].estado, 'ESPERANDO_MOTIVO');
  assert.equal(solicitudes[0].nombre_anfitrion, 'Carlos Gómez');
  assert.match(enviados[enviados.length - 1].text, /Carlos Gómez/);
});
