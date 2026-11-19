/**
 * Limitador progresivo de intentos fallidos de inicio de sesión (POST /api/auth/login).
 *
 * - Permite hasta `maxIntentosUsuario` (5) fallos antes del primer bloqueo.
 * - 1.er bloqueo: 1 minuto (`bloqueoInicialMs = 60_000`).
 * - Si tras cumplirse el minuto vuelve a fallar, el bloqueo sube a 5 minutos (`bloqueoReincidenteMs = 300_000`).
 * - Un inicio de sesión exitoso reinicia el contador y el nivel de bloqueo del usuario.
 */

const obtenerIpSolicitud = (solicitud) => {
  return String(solicitud?.ip || solicitud?.socket?.remoteAddress || 'desconocida').trim();
};

const normalizarClaveUsuario = (nombreUsuario) => {
  return String(nombreUsuario ?? '').trim().toLowerCase();
};

const crearLimitadorLogin = ({
  maxIntentosUsuario = Math.max(Number(process.env.LOGIN_MAX_INTENTOS) || 5, 1),
  maxIntentosIp = Math.max(Number(process.env.LOGIN_MAX_INTENTOS_IP) || 15, 1),
  bloqueoInicialMs = Math.max(
    Number(process.env.LOGIN_VENTANA_MS) || 60 * 1000,
    1000
  ),
  bloqueoReincidenteMs = Math.max(
    Number(process.env.LOGIN_BLOQUEO_REINCIDENTE_MS) || 5 * 60 * 1000,
    1000
  ),
  reloj = () => Date.now(),
} = {}) => {
  // clave: `${ip}|${usuario}` -> { conteo, nivelBloqueo, bloqueadoHasta, limpiarEn }
  const fallosPorUsuario = new Map();
  // clave: `${ip}` -> { conteo, nivelBloqueo, bloqueadoHasta, limpiarEn }
  const fallosPorIp = new Map();

  const limpiarExpirados = (ahora) => {
    for (const [clave, reg] of fallosPorUsuario.entries()) {
      if (ahora >= reg.limpiarEn) fallosPorUsuario.delete(clave);
    }
    for (const [clave, reg] of fallosPorIp.entries()) {
      if (ahora >= reg.limpiarEn) fallosPorIp.delete(clave);
    }
  };

  const obtenerRegistroVigente = (mapa, clave, ahora) => {
    const reg = mapa.get(clave);
    if (!reg) return null;
    if (ahora >= reg.limpiarEn) {
      mapa.delete(clave);
      return null;
    }
    return reg;
  };

  const registrarFalloEnMapa = (mapa, clave, maxIntentos, ahora) => {
    const actual = obtenerRegistroVigente(mapa, clave, ahora);

    // Si ya había cumplido un primer bloqueo de 1 min y vuelve a fallar, se bloquea por 5 min
    if (actual && actual.nivelBloqueo >= 1 && ahora >= actual.bloqueadoHasta) {
      actual.conteo += 1;
      actual.nivelBloqueo += 1;
      actual.bloqueadoHasta = ahora + bloqueoReincidenteMs;
      actual.limpiarEn = actual.bloqueadoHasta + bloqueoReincidenteMs;
      return actual;
    }

    const reg = actual || {
      conteo: 0,
      nivelBloqueo: 0,
      bloqueadoHasta: 0,
      limpiarEn: ahora + bloqueoReincidenteMs,
    };

    reg.conteo += 1;

    if (reg.conteo >= maxIntentos && reg.bloqueadoHasta <= ahora) {
      reg.nivelBloqueo += 1;
      const duracion =
        reg.nivelBloqueo === 1 ? bloqueoInicialMs : bloqueoReincidenteMs;
      reg.bloqueadoHasta = ahora + duracion;
      reg.limpiarEn = reg.bloqueadoHasta + bloqueoReincidenteMs;
    } else if (reg.bloqueadoHasta <= ahora) {
      reg.limpiarEn = ahora + bloqueoReincidenteMs;
    }

    mapa.set(clave, reg);
    return reg;
  };

  const middlewareVerificarBloqueoLogin = (solicitud, respuesta, siguiente) => {
    const ahora = reloj();
    if (fallosPorUsuario.size > 200 || fallosPorIp.size > 200) {
      limpiarExpirados(ahora);
    }

    const ip = obtenerIpSolicitud(solicitud);
    const usuario = normalizarClaveUsuario(solicitud?.body?.nombreUsuario);

    const regIp = obtenerRegistroVigente(fallosPorIp, ip, ahora);
    const regUsuario = usuario
      ? obtenerRegistroVigente(fallosPorUsuario, `${ip}|${usuario}`, ahora)
      : null;

    const bloqueadoPorUsuario = regUsuario && regUsuario.bloqueadoHasta > ahora;
    const bloqueadoPorIp = regIp && regIp.bloqueadoHasta > ahora;

    if (bloqueadoPorUsuario || bloqueadoPorIp) {
      const expiraEn = bloqueadoPorUsuario
        ? regUsuario.bloqueadoHasta
        : regIp.bloqueadoHasta;
      const segundosRestantes = Math.max(Math.ceil((expiraEn - ahora) / 1000), 1);
      const minutosRestantes = Math.max(Math.ceil(segundosRestantes / 60), 1);

      respuesta.set('Retry-After', String(segundosRestantes));
      return respuesta.status(429).json({
        error: `Demasiados intentos fallidos de inicio de sesión. Intenta nuevamente en ${minutosRestantes} ${minutosRestantes === 1 ? 'minuto' : 'minutos'}.`,
        retryAfterSegundos: segundosRestantes,
      });
    }

    return siguiente();
  };

  const registrarFalloLogin = (solicitud, nombreUsuario) => {
    const ahora = reloj();
    const ip = obtenerIpSolicitud(solicitud);
    const usuario = normalizarClaveUsuario(
      nombreUsuario ?? solicitud?.body?.nombreUsuario
    );

    registrarFalloEnMapa(fallosPorIp, ip, maxIntentosIp, ahora);
    if (usuario) {
      registrarFalloEnMapa(fallosPorUsuario, `${ip}|${usuario}`, maxIntentosUsuario, ahora);
    }
  };

  const limpiarIntentosLogin = (solicitud, nombreUsuario) => {
    const ip = obtenerIpSolicitud(solicitud);
    const usuario = normalizarClaveUsuario(
      nombreUsuario ?? solicitud?.body?.nombreUsuario
    );
    if (usuario) {
      fallosPorUsuario.delete(`${ip}|${usuario}`);
    }
  };

  return {
    middlewareVerificarBloqueoLogin,
    registrarFalloLogin,
    limpiarIntentosLogin,
  };
};

module.exports = {
  crearLimitadorLogin,
};
