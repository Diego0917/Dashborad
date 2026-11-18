const crypto = require('crypto');

// Valores que han estado publicados en el código o en las plantillas .env.example: nunca son válidos.
const VALORES_CONOCIDOS = new Set([
  'clave_secreta_desarrollo_lira_seguridad_2026',
  'cambia_esta_clave_secreta_en_produccion',
  'cambia_esta_contrasena',
  'admin123',
  'admin',
]);

const LONGITUD_MINIMA_JWT = 16;
const LONGITUD_MINIMA_ADMIN = 8;

const esProduccion = () =>
  String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

/**
 * Devuelve el motivo por el que un secreto no es aceptable, o null si es válido.
 */
const motivoInvalido = (valor, longitudMinima) => {
  if (!valor) return 'no está definida';
  if (VALORES_CONOCIDOS.has(valor)) return 'usa un valor por defecto conocido';
  if (valor.length < longitudMinima) {
    return `debe tener al menos ${longitudMinima} caracteres`;
  }
  return null;
};

/**
 * Devuelve el secreto para firmar JWT.
 * - Producción: lanza Error si falta, es conocido o es demasiado corto.
 * - Desarrollo: genera un secreto aleatorio temporal y avisa por consola.
 */
const obtenerSecretoJwt = () => {
  const valor = String(process.env.JWT_SECRET || '').trim();
  const motivo = motivoInvalido(valor, LONGITUD_MINIMA_JWT);
  if (!motivo) return valor;

  if (esProduccion()) {
    throw new Error(
      `JWT_SECRET ${motivo}. El servidor no arranca en producción sin un secreto seguro. ` +
        `Genera uno con: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`
    );
  }

  console.warn(
    `[Seguridad] JWT_SECRET ${motivo}: usando un secreto aleatorio temporal ` +
      '(las sesiones se cerrarán al reiniciar el servidor).'
  );
  return crypto.randomBytes(48).toString('base64');
};

/**
 * Devuelve la contraseña para crear el administrador inicial (solo se llama si no hay usuarios).
 * - Producción: lanza Error si falta, es conocida o es demasiado corta.
 * - Desarrollo: genera una contraseña aleatoria y la muestra una única vez por consola.
 */
const obtenerContrasenaAdminInicial = () => {
  const valor = String(process.env.CONTRASENA_ADMIN_INICIAL || '');
  const motivo = motivoInvalido(valor, LONGITUD_MINIMA_ADMIN);
  if (!motivo) return valor;

  if (esProduccion()) {
    throw new Error(
      `CONTRASENA_ADMIN_INICIAL ${motivo}. Es obligatoria para crear el administrador inicial en producción.`
    );
  }

  const aleatoria = crypto.randomBytes(12).toString('base64url');
  console.warn(
    `[Seguridad] CONTRASENA_ADMIN_INICIAL ${motivo}. Contraseña generada para el admin inicial ` +
      `(se muestra solo esta vez, cámbiala después): ${aleatoria}`
  );
  return aleatoria;
};

module.exports = {
  obtenerSecretoJwt,
  obtenerContrasenaAdminInicial,
  esProduccion,
  LONGITUD_MINIMA_JWT,
  LONGITUD_MINIMA_ADMIN,
};
