import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import './Dashboard.css';

const URL_BASE_API = import.meta.env.VITE_UNIFI_API_BASE_URL || 'http://localhost:3006/api';

const RegistroVisitantePublico = () => {
  const { token } = useParams();
  const [cargandoToken, setCargandoToken] = useState(true);
  const [errorToken, setErrorToken] = useState('');
  const [infoInvitacion, setInfoInvitacion] = useState(null);

  const [formulario, setFormulario] = useState({
    cedula: '',
    nombre_completo: '',
    id_rol: '1',
    telefono: '',
    eps: '',
    arl: '',
  });

  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState('');
  const [qrGenerado, setQrGenerado] = useState(null);

  useEffect(() => {
    let cancelado = false;
    const validarToken = async () => {
      setCargandoToken(true);
      setErrorToken('');
      try {
        const resp = await axios.get(
          `${URL_BASE_API}/invitaciones-publicas/${encodeURIComponent(token || '')}`
        );
        if (!cancelado) {
          setInfoInvitacion(resp.data);
          if (resp.data?.nombre_sugerido) {
            setFormulario((prev) => ({
              ...prev,
              nombre_completo: prev.nombre_completo || resp.data.nombre_sugerido,
            }));
          }
        }
      } catch (err) {
        if (!cancelado) {
          setErrorToken(
            err?.response?.data?.error ||
              'Este enlace de invitación no es válido, ya fue utilizado o ha expirado.'
          );
        }
      } finally {
        if (!cancelado) setCargandoToken(false);
      }
    };

    validarToken();
    return () => {
      cancelado = true;
    };
  }, [token]);

  const manejarCambio = (campo, valor) => {
    setFormulario((prev) => ({ ...prev, [campo]: valor }));
  };

  const manejarEnvio = async (evento) => {
    evento.preventDefault();
    setErrorEnvio('');

    if (
      !formulario.cedula.trim() ||
      !formulario.nombre_completo.trim() ||
      !formulario.telefono.trim() ||
      !formulario.eps.trim() ||
      !formulario.arl.trim()
    ) {
      setErrorEnvio('Todos los campos marcados con * son obligatorios.');
      return;
    }

    setEnviando(true);
    try {
      const resp = await axios.post(
        `${URL_BASE_API}/invitaciones-publicas/${encodeURIComponent(token || '')}/completar`,
        {
          cedula: formulario.cedula.trim(),
          nombre_completo: formulario.nombre_completo.trim(),
          id_rol: Number(formulario.id_rol) === 3 ? 3 : 1,
          telefono: formulario.telefono.trim(),
          eps: formulario.eps.trim(),
          arl: formulario.arl.trim(),
        }
      );
      setQrGenerado(resp.data);
    } catch (err) {
      setErrorEnvio(
        err?.response?.data?.error ||
          'No se pudo completar el registro ni generar el código QR. Intenta nuevamente.'
      );
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Registro de Visitante — Control de Acceso</h1>
      </header>

      <main className="dashboard-content" style={{ maxWidth: '640px', margin: '0 auto' }}>
        {cargandoToken ? (
          <section className="invitacion-card">
            <p>Verificando enlace de invitación...</p>
          </section>
        ) : errorToken ? (
          <section className="invitacion-card">
            <div className="error-banner">{errorToken}</div>
            <p className="stats-subtitle">
              Si necesitas un nuevo enlace, vuelve al chat de Telegram y escribe <strong>/start</strong>.
            </p>
          </section>
        ) : qrGenerado ? (
          <section className="invitacion-card">
            <h2 className="stats-title">¡Tu código QR de ingreso está listo!</h2>
            <div className="success-banner" style={{ marginTop: '0.75rem' }}>
              {qrGenerado.telegram?.enviado
                ? 'También te enviamos este código QR directamente a tu chat de Telegram.'
                : 'Presenta este código QR en el lector de entrada del edificio.'}
            </div>

            <div className="invitacion-qr-box">
              {qrGenerado.qr_base64 && (
                <div className="invitacion-qr-img-container">
                  <img
                    src={qrGenerado.qr_base64}
                    alt={`Código QR de ${qrGenerado.nombre_completo}`}
                    className="invitacion-qr-img"
                  />
                </div>
              )}

              <div className="modal-body" style={{ width: '100%', padding: 0 }}>
                <div className="modal-detail-item">
                  <span className="modal-detail-label">Visitante</span>
                  <p className="modal-detail-value">
                    {qrGenerado.nombre_completo} (C.C. {qrGenerado.cedula})
                  </p>
                </div>
                <div className="modal-detail-item">
                  <span className="modal-detail-label">Anfitrión / Motivo</span>
                  <p className="modal-detail-value">
                    {infoInvitacion?.nombre_anfitrion} — {qrGenerado.motivo}
                  </p>
                </div>
                <div className="modal-detail-item">
                  <span className="modal-detail-label">Vigencia del pase</span>
                  <p className="modal-detail-value">
                    Hasta las{' '}
                    {new Date(Number(qrGenerado.fin_timestamp) * 1000).toLocaleTimeString('es-CO', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · {qrGenerado.max_usos} accesos permitidos
                  </p>
                </div>
              </div>

              {qrGenerado.qr_base64 && (
                <a
                  href={qrGenerado.qr_base64}
                  download={`pase_qr_${qrGenerado.cedula}.png`}
                  className="download-qr-button"
                >
                  Descargar Código QR (PNG)
                </a>
              )}
            </div>
          </section>
        ) : (
          <section className="invitacion-card">
            <h2 className="stats-title">Completa tus datos para generar tu pase QR</h2>
            <p className="stats-subtitle" style={{ marginBottom: '1rem' }}>
              Visita aprobada por <strong>{infoInvitacion?.nombre_anfitrion}</strong> · Motivo:{' '}
              <strong>{infoInvitacion?.motivo}</strong>
            </p>

            {errorEnvio && <div className="error-banner">{errorEnvio}</div>}

            <form onSubmit={manejarEnvio} className="invitacion-form-grid">
              <div className="filter-group">
                <label htmlFor="pub-cedula">Número de Documento (Cédula) *</label>
                <input
                  id="pub-cedula"
                  type="text"
                  placeholder="Ej. 1001234567"
                  value={formulario.cedula}
                  onChange={(e) => manejarCambio('cedula', e.target.value)}
                  required
                />
              </div>

              <div className="filter-group">
                <label htmlFor="pub-nombre">Nombre completo *</label>
                <input
                  id="pub-nombre"
                  type="text"
                  placeholder="Nombres y apellidos completos"
                  value={formulario.nombre_completo}
                  onChange={(e) => manejarCambio('nombre_completo', e.target.value)}
                  required
                />
              </div>

              <div className="filter-group">
                <label htmlFor="pub-rol">Tipo de ingreso *</label>
                <select
                  id="pub-rol"
                  value={formulario.id_rol}
                  onChange={(e) => manejarCambio('id_rol', e.target.value)}
                >
                  <option value="1">Visitante</option>
                  <option value="3">Proveedor</option>
                </select>
              </div>

              <div className="filter-group">
                <label htmlFor="pub-telefono">Celular *</label>
                <input
                  id="pub-telefono"
                  type="tel"
                  placeholder="Ej. 3001234567"
                  value={formulario.telefono}
                  onChange={(e) => manejarCambio('telefono', e.target.value)}
                  required
                />
              </div>

              <div className="filter-group">
                <label htmlFor="pub-eps">EPS *</label>
                <input
                  id="pub-eps"
                  type="text"
                  placeholder="Entidad promotora de salud"
                  value={formulario.eps}
                  onChange={(e) => manejarCambio('eps', e.target.value)}
                  required
                />
              </div>

              <div className="filter-group">
                <label htmlFor="pub-arl">ARL *</label>
                <input
                  id="pub-arl"
                  type="text"
                  placeholder="Aseguradora de riesgos laborales"
                  value={formulario.arl}
                  onChange={(e) => manejarCambio('arl', e.target.value)}
                  required
                />
              </div>

              <div className="invitacion-actions invitacion-full">
                <button
                  type="submit"
                  className="apply-filters-button"
                  disabled={enviando}
                >
                  {enviando ? 'Generando tu código QR...' : 'Registrarme y Generar Código QR'}
                </button>
              </div>
            </form>
          </section>
        )}
      </main>
    </div>
  );
};

export default RegistroVisitantePublico;
