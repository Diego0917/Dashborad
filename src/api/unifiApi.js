import axios from 'axios';

const URL_BASE_API = import.meta.env.VITE_UNIFI_API_BASE_URL || 'http://localhost:3006/api';

const api = axios.create({
  baseURL: URL_BASE_API,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const CLAVE_STORAGE_TOKEN = 'lira_token';
export const CLAVE_STORAGE_USUARIO = 'lira_usuario';
export const EVENTO_SESION_EXPIRADA = 'lira:sesion-expirada';

api.interceptors.request.use((configuracion) => {
  const claveApi = import.meta.env.VITE_UNIFI_API_KEY;
  if (claveApi) {
    configuracion.headers['X-API-KEY'] = claveApi;
  }

  const tokenJwt = localStorage.getItem(CLAVE_STORAGE_TOKEN);
  if (tokenJwt) {
    configuracion.headers.Authorization = `Bearer ${tokenJwt}`;
  }

  return configuracion;
});

api.interceptors.response.use(
  (respuesta) => respuesta,
  (error) => {
    const estadoHttp = error?.response?.status;
    const urlPeticion = error?.config?.url || '';

    // Si el token expiró o es inválido en una ruta protegida, limpiamos sesión
    if (estadoHttp === 401 && !urlPeticion.includes('/auth/login')) {
      localStorage.removeItem(CLAVE_STORAGE_TOKEN);
      localStorage.removeItem(CLAVE_STORAGE_USUARIO);
      window.dispatchEvent(new Event(EVENTO_SESION_EXPIRADA));
    }

    return Promise.reject(error);
  }
);

/**
 * INICIAR SESIÓN (JWT)
 * Envía { nombreUsuario, contrasena } y devuelve { token, usuario }
 */
export const iniciarSesionUsuario = async (credenciales) => {
  const respuesta = await api.post('/auth/login', credenciales);
  return respuesta.data;
};

/**
 * OBTENER VISITAS
 * Consulta los registros de ingreso enriquecidos con nombre, cédula y rol mediante JOIN
 */
export const obtenerVisitas = async (filtros = {}) => {
  try {
    const respuesta = await api.get('/visitas', { params: filtros });
    return respuesta.data;
  } catch (error) {
    console.error('Error al obtener visitas:', error);
    throw error;
  }
};

/**
 * OBTENER ESTADÍSTICAS DE VISITAS
 * Consulta métricas y agrupaciones desde el servidor respetando los filtros aplicados
 */
export const obtenerEstadisticasVisitas = async (filtros = {}) => {
  try {
    const respuesta = await api.get('/visitas/estadisticas', { params: filtros });
    return respuesta.data;
  } catch (error) {
    console.error('Error al obtener estadísticas de visitas:', error);
    throw error;
  }
};

/**
 * REGISTRAR INGRESO
 * Recibe { cedula, motivo } para guardar un nuevo evento
 */
export const registrarIngreso = async (datosIngreso) => {
  try {
    const respuesta = await api.post('/visitas', datosIngreso);
    return respuesta.data;
  } catch (error) {
    console.error('Error al registrar ingreso:', error);
    throw error;
  }
};

/**
 * REGISTRAR PERSONA NUEVA (Opcional)
 * Recibe { cedula, nombre_completo, telefono, eps, arl, id_rol }
 */
export const crearPersona = async (datosPersona) => {
  try {
    const respuesta = await api.post('/personas', datosPersona);
    return respuesta.data;
  } catch (error) {
    console.error('Error al guardar la persona:', error);
    throw error;
  }
};

/**
 * BUSCAR PERSONA POR CÉDULA
 * Permite autocompletar datos si la persona ya existe en la BD
 */
export const buscarPersonaPorCedula = async (cedula) => {
  const respuesta = await api.get(`/personas/${encodeURIComponent(cedula)}`);
  return respuesta.data;
};

/**
 * LISTAR PUERTAS DE UNIFI ACCESS
 */
export const obtenerPuertasUnifi = async () => {
  const respuesta = await api.get('/unifi/puertas');
  return respuesta.data;
};

/**
 * REGISTRAR INGRESO Y GENERAR CÓDIGO QR EN UNIFI ACCESS
 */
export const registrarIngresoConQr = async (datosIngresoQr) => {
  const respuesta = await api.post('/visitas/con-qr', datosIngresoQr);
  return respuesta.data;
};

/**
 * OBTENER DETALLE E IMAGEN DEL QR DE UNA VISITA
 */
export const obtenerDetalleQrVisita = async (idRegistro) => {
  const respuesta = await api.get(`/visitas/${idRegistro}/qr`);
  return respuesta.data;
};

/**
 * ENVIAR O REENVIAR CÓDIGO QR POR CORREO ELECTRÓNICO
 */
export const enviarQrVisitaCorreo = async (idRegistro, correo) => {
  const respuesta = await api.post(`/visitas/${idRegistro}/qr/correo`, { correo });
  return respuesta.data;
};

/**
 * REVOCAR MANUALMENTE UN CÓDIGO QR ACTIVO EN UNIFI ACCESS
 */
export const revocarQrVisita = async (idRegistro) => {
  const respuesta = await api.delete(`/visitas/${idRegistro}/qr`);
  return respuesta.data;
};

/**
 * BUSCAR USUARIOS / EMPLEADOS REGISTRADOS CON ROSTRO EN UNIFI ACCESS
 * Consume GET /api/v1/developer/users/search a través del backend
 */
export const buscarUsuariosUnifiApi = async (keyword = '') => {
  const respuesta = await api.get('/unifi/usuarios/buscar', {
    params: { keyword },
  });
  return respuesta.data;
};

/**
 * SINCRONIZAR EMPLEADOS DESDE UNIFI ACCESS HACIA LA TABLA PERSONAS DE MYSQL
 */
export const sincronizarEmpleadosUnifi = async () => {
  const respuesta = await api.post('/unifi/usuarios/sincronizar');
  return respuesta.data;
};

export default api;