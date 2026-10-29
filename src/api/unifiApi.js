import axios from 'axios';

const URL_BASE_API = import.meta.env.VITE_UNIFI_API_BASE_URL || 'http://localhost:3006/api';

const api = axios.create({
  baseURL: URL_BASE_API,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((configuracion) => {
  const claveApi = import.meta.env.VITE_UNIFI_API_KEY;
  if (claveApi) {
    configuracion.headers['X-API-KEY'] = claveApi;
  }
  return configuracion;
});

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