import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  iniciarSesionUsuario,
  CLAVE_STORAGE_TOKEN,
  CLAVE_STORAGE_USUARIO,
  EVENTO_SESION_EXPIRADA,
} from '../api/unifiApi';

const AuthContext = createContext();

export const useAuth = () => {
  const contexto = useContext(AuthContext);
  if (!contexto) {
    throw new Error('useAuth debe usarse dentro de AuthProvider');
  }
  return contexto;
};

export const AuthProvider = ({ children }) => {
  const [usuario, setUsuario] = useState(() => {
    const tokenGuardado = localStorage.getItem(CLAVE_STORAGE_TOKEN);
    const usuarioGuardado = localStorage.getItem(CLAVE_STORAGE_USUARIO);
    if (!tokenGuardado || !usuarioGuardado) {
      return null;
    }
    try {
      return JSON.parse(usuarioGuardado);
    } catch {
      return null;
    }
  });

  const cerrarSesion = useCallback(() => {
    setUsuario(null);
    localStorage.removeItem(CLAVE_STORAGE_TOKEN);
    localStorage.removeItem(CLAVE_STORAGE_USUARIO);
  }, []);

  useEffect(() => {
    const manejarSesionExpirada = () => {
      cerrarSesion();
    };

    window.addEventListener(EVENTO_SESION_EXPIRADA, manejarSesionExpirada);
    return () => {
      window.removeEventListener(EVENTO_SESION_EXPIRADA, manejarSesionExpirada);
    };
  }, [cerrarSesion]);

  const iniciarSesion = async (nombreUsuario, contrasena) => {
    const datosRespuesta = await iniciarSesionUsuario({
      nombreUsuario,
      contrasena,
    });

    if (datosRespuesta?.token && datosRespuesta?.usuario) {
      localStorage.setItem(CLAVE_STORAGE_TOKEN, datosRespuesta.token);
      localStorage.setItem(
        CLAVE_STORAGE_USUARIO,
        JSON.stringify(datosRespuesta.usuario)
      );
      setUsuario(datosRespuesta.usuario);
      return true;
    }

    return false;
  };

  return (
    <AuthContext.Provider
      value={{
        usuario,
        iniciarSesion,
        cerrarSesion,
        estaAutenticado: Boolean(usuario && localStorage.getItem(CLAVE_STORAGE_TOKEN)),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
