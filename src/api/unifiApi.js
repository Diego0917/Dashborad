import axios from 'axios';

const URL_BASE_API = import.meta.env.VITE_UNIFI_API_BASE_URL || 'http://localhost:3001';

const api = axios.create({
  baseURL: URL_BASE_API,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para añadir token si existe
api.interceptors.request.use((configuracion) => {
  const claveApi = import.meta.env.VITE_UNIFI_API_KEY;
  if (claveApi) {
    configuracion.headers['X-API-KEY'] = claveApi;
  }
  return configuracion;
});

export const obtenerVisitas = async (filtros = {}) => {
  try {
    //ajustar dependiendo dependiendo de API unifi
    const respuesta = await api.get('/visitas', { params: filtros });
    return respuesta.data;
  } catch (error) {
    console.error('Error al obtener visitas:', error);
    throw error;
  }
};

export default api;
