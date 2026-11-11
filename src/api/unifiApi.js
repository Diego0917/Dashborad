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

export default api;