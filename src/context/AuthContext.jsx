import { createContext, useContext, useState } from 'react';

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
    const usuarioGuardado = localStorage.getItem('lira_usuario');
    return usuarioGuardado ? JSON.parse(usuarioGuardado) : null;
  });

  const iniciarSesion = (nombreUsuario, contrasena) => {
    // Autenticación básica - ajustar según API
    if (nombreUsuario && contrasena) {
      const datosUsuario = { nombreUsuario };
      setUsuario(datosUsuario);
      localStorage.setItem('lira_usuario', JSON.stringify(datosUsuario));
      return true;
    }
    return false;
  };

  const cerrarSesion = () => {
    setUsuario(null);
    localStorage.removeItem('lira_usuario');
  };

  return (
    <AuthContext.Provider value={{ usuario, iniciarSesion, cerrarSesion, estaAutenticado: !!usuario }}>
      {children}
    </AuthContext.Provider>
  );
};
