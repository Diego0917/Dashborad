import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import logoLira from '../assets/logo-lira.png';
import './Login.css';

const Login = () => {
  const [usuario, setUsuario] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);
  const { iniciarSesion } = useAuth();
  const navegar = useNavigate();

  const manejarEnvio = async (e) => {
    e.preventDefault();
    setError('');

    if (!usuario.trim() || !contrasena) {
      setError('Usuario y contraseña son obligatorios');
      return;
    }

    setEnviando(true);
    try {
      const exito = await iniciarSesion(usuario.trim(), contrasena);
      if (exito) {
        navegar('/dashboard');
      } else {
        setError('Credenciales inválidas');
      }
    } catch (errorLogin) {
      const mensajeServidor = errorLogin?.response?.data?.error;
      if (mensajeServidor) {
        setError(mensajeServidor);
      } else {
        setError('No se pudo conectar con el servidor de autenticación');
      }
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <div className="logo-container">
          <img src={logoLira} alt="Lira Seguridad" className="logo" />
        </div>
        <form onSubmit={manejarEnvio} className="login-form">
          <div className="form-group">
            <label htmlFor="usuario">Usuario</label>
            <input
              type="text"
              id="usuario"
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="contrasena">Contraseña</label>
            <input
              type="password"
              id="contrasena"
              value={contrasena}
              onChange={(e) => setContrasena(e.target.value)}
              required
            />
          </div>
          {error && <div className="error-message">{error}</div>}
          <button type="submit" className="login-button" disabled={enviando}>
            {enviando ? 'Iniciando sesión...' : 'Iniciar Sesión'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
