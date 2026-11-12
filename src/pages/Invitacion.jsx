import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  buscarPersonaPorCedula,
  obtenerPuertasUnifi,
  registrarIngresoConQr,
  enviarQrVisitaCorreo,
} from '../api/unifiApi';
import './Dashboard.css';

const PUERTA_UNIFI_POR_DEFECTO = 'e38b8776-8756-4817-8569-6ef2aafb69c7';

const FORMULARIO_INICIAL = {
  cedula: '',
  nombre_completo: '',
  id_rol: '1',
  telefono: '',
  eps: '',
  arl: '',
  correo: '',
  motivo: '',
  puertaId: PUERTA_UNIFI_POR_DEFECTO,
  modoActivacion: 'ambos',
  ventanaSegundos: '3600',
  maxUsos: '2',
};

const Invitacion = () => {
  const navegar = useNavigate();
  const [formulario, setFormulario] = useState(FORMULARIO_INICIAL);
  const [personaExistente, setPersonaExistente] = useState(false);
  const [buscandoCedula, setBuscandoCedula] = useState(false);
  const [puertasUnifi, setPuertasUnifi] = useState([
    {
      id: PUERTA_UNIFI_POR_DEFECTO,
      nombre: 'Puerta Gestión Humana (Por defecto)',
    },
  ]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const [mensajeExito, setMensajeExito] = useState('');
  const [qrGenerado, setQrGenerado] = useState(null);
  const [correoReenvio, setCorreoReenvio] = useState('');
  const [enviandoCorreo, setEnviandoCorreo] = useState(false);

  useEffect(() => {
    let cancelado = false;
    const cargarPuertas = async () => {
      try {
        const datos = await obtenerPuertasUnifi();
        if (!cancelado && Array.isArray(datos?.puertas) && datos.puertas.length > 0) {
          setPuertasUnifi(datos.puertas);
          if (datos.puertaDefecto) {
            setFormulario((prev) => ({
              ...prev,
              puertaId: prev.puertaId || datos.puertaDefecto,
            }));
          }
        }
      } catch {
        // Conserva puerta por defecto
      }
    };
    cargarPuertas();
    return () => {
      cancelado = true;
    };
  }, []);

  const manejarCambio = (campo, valor) => {
    setFormulario((prev) => ({ ...prev, [campo]: valor }));
    if (campo === 'cedula') {
      setPersonaExistente(false);
    }
  };

  const autocompletarPorCedula = async () => {
    const cedulaLimpia = formulario.cedula.trim();
    if (!cedulaLimpia) return;

    setBuscandoCedula(true);
    setError('');
    try {
      const persona = await buscarPersonaPorCedula(cedulaLimpia);
      if (persona) {
        setPersonaExistente(true);
        setFormulario((prev) => ({
          ...prev,
          nombre_completo: persona.nombre_completo || '',
          id_rol: String(persona.id_rol || '1'),
          telefono: persona.telefono || '',
          eps: persona.eps || '',
          arl: persona.arl || '',
        }));
      }
    } catch {
      setPersonaExistente(false);
    } finally {
      setBuscandoCedula(false);
    }
  };

  const manejarEnvio = async (evento) => {
    evento.preventDefault();
    setError('');
    setMensajeExito('');

    if (!formulario.cedula.trim() || !formulario.nombre_completo.trim()) {
      setError('La cédula y el nombre completo son obligatorios.');
      return;
    }

    setEnviando(true);
    try {
      const esSoloTiempo = formulario.modoActivacion === 'tiempo';
      const resultado = await registrarIngresoConQr({
        cedula: formulario.cedula.trim(),
        nombre_completo: formulario.nombre_completo.trim(),
        id_rol: Number(formulario.id_rol) || 1,
        telefono: formulario.telefono.trim() || null,
        eps: formulario.eps.trim() || null,
        arl: formulario.arl.trim() || null,
        correo: formulario.correo.trim() || '',
        motivo: formulario.motivo.trim() || 'Visita autorizada',
        puertas: [formulario.puertaId || PUERTA_UNIFI_POR_DEFECTO],
        modoActivacion: formulario.modoActivacion,
        ventanaSegundos: Number(formulario.ventanaSegundos) || 3600,
        maxUsos: esSoloTiempo ? 0 : Math.max(1, Number(formulario.maxUsos) || 2),
      });

      setQrGenerado(resultado);
      setCorreoReenvio(formulario.correo.trim() || '');

      let textoExito =
        'Ingreso registrado en la base de datos y código QR generado exitosamente.';
      if (resultado.correo?.enviado) {
        textoExito += ` ${resultado.correo.mensaje}.`;
      } else if (resultado.correo?.mensaje) {
        textoExito += ` (${resultado.correo.mensaje})`;
      }
      setMensajeExito(textoExito);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err.message ||
          'No se pudo registrar el ingreso ni generar el código QR.'
      );
    } finally {
      setEnviando(false);
    }
  };

  const manejarEnviarPorCorreo = async () => {
    if (!qrGenerado?.id_registro || !correoReenvio.trim()) return;
    setEnviandoCorreo(true);
    setError('');
    setMensajeExito('');
    try {
      const respuesta = await enviarQrVisitaCorreo(
        qrGenerado.id_registro,
        correoReenvio.trim()
      );
      setMensajeExito(respuesta.mensaje || 'Código QR enviado al correo electrónico.');
    } catch (errCorreo) {
      setError(
        errCorreo?.response?.data?.error || 'No se pudo enviar el código QR por correo.'
      );
    } finally {
      setEnviandoCorreo(false);
    }
  };

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Registro de Ingreso e Invitación QR — Lira Seguridad</h1>
        <div className="header-actions">
          <button
            type="button"
            className="clear-filters-button"
            onClick={() => navegar('/dashboard')}
          >
            ← Volver al Dashboard
          </button>
        </div>
      </header>

      <main className="dashboard-content">
        {error && <div className="error-banner">{error}</div>}
        {mensajeExito && <div className="success-banner">{mensajeExito}</div>}

        <div className="invitacion-grid">
          <section className="invitacion-card">
            <h2 className="stats-title">Datos de Ingreso de la Persona</h2>
            <p className="stats-subtitle">
              Ingresa el número de documento para autocompletar si la persona ya existe, o
              completa el formulario para registrarla, generar su código QR en pantalla y
              enviarlo opcionalmente por correo electrónico.
            </p>

            <form onSubmit={manejarEnvio} className="invitacion-form-grid">
              <div className="filter-group">
                <label htmlFor="inv-cedula">Número de Documento (Cédula) *</label>
                <div className="invitacion-cedula-row">
                  <input
                    id="inv-cedula"
                    type="text"
                    placeholder="Ej. 1001234567"
                    value={formulario.cedula}
                    onChange={(e) => manejarCambio('cedula', e.target.value)}
                    onBlur={autocompletarPorCedula}
                    required
                  />
                  <button
                    type="button"
                    className="clear-filters-button"
                    onClick={autocompletarPorCedula}
                    disabled={buscandoCedula}
                  >
                    {buscandoCedula ? 'Buscando...' : 'Buscar'}
                  </button>
                </div>
                {personaExistente && (
                  <span className="invitacion-badge-ok">
                    ✓ Persona registrada en la base de datos (datos autocompletados)
                  </span>
                )}
              </div>

              <div className="filter-group">
                <label htmlFor="inv-nombre">Nombre completo *</label>
                <input
                  id="inv-nombre"
                  type="text"
                  placeholder="Nombres y apellidos completos"
                  value={formulario.nombre_completo}
                  onChange={(e) => manejarCambio('nombre_completo', e.target.value)}
                  required
                />
              </div>

              <div className="filter-group">
                <label htmlFor="inv-rol">Rol *</label>
                <select
                  id="inv-rol"
                  value={formulario.id_rol}
                  onChange={(e) => manejarCambio('id_rol', e.target.value)}
                >
                  <option value="1">Visitante</option>
                  <option value="2">Empleado</option>
                  <option value="3">Proveedor</option>
                </select>
              </div>

              <div className="filter-group">
                <label htmlFor="inv-telefono">Teléfono</label>
                <input
                  id="inv-telefono"
                  type="text"
                  placeholder="Ej. 3001234567"
                  value={formulario.telefono}
                  onChange={(e) => manejarCambio('telefono', e.target.value)}
                />
              </div>

              <div className="filter-group">
                <label htmlFor="inv-eps">EPS</label>
                <input
                  id="inv-eps"
                  type="text"
                  placeholder="Entidad promotora de salud"
                  value={formulario.eps}
                  onChange={(e) => manejarCambio('eps', e.target.value)}
                />
              </div>

              <div className="filter-group">
                <label htmlFor="inv-arl">ARL</label>
                <input
                  id="inv-arl"
                  type="text"
                  placeholder="Aseguradora de riesgos laborales"
                  value={formulario.arl}
                  onChange={(e) => manejarCambio('arl', e.target.value)}
                />
              </div>

              <div className="filter-group">
                <label htmlFor="inv-correo">Correo electrónico (Opcional, para enviar QR)</label>
                <input
                  id="inv-correo"
                  type="email"
                  placeholder="visitante@correo.com"
                  value={formulario.correo}
                  onChange={(e) => manejarCambio('correo', e.target.value)}
                />
              </div>

              <div className="filter-group">
                <label htmlFor="inv-motivo">Motivo de la visita *</label>
                <input
                  id="inv-motivo"
                  type="text"
                  placeholder="Ej. Reunión con Gestión Humana"
                  value={formulario.motivo}
                  onChange={(e) => manejarCambio('motivo', e.target.value)}
                  required
                />
              </div>

              <div className="filter-group">
                <label htmlFor="inv-puerta">Puerta UniFi Access</label>
                <select
                  id="inv-puerta"
                  value={formulario.puertaId}
                  onChange={(e) => manejarCambio('puertaId', e.target.value)}
                >
                  {puertasUnifi.map((puerta) => (
                    <option key={puerta.id} value={puerta.id}>
                      {puerta.nombre}
                    </option>
                  ))}
                </select>
              </div>

              <div className="filter-group">
                <label htmlFor="inv-modo">Modo de activación del QR *</label>
                <select
                  id="inv-modo"
                  value={formulario.modoActivacion}
                  onChange={(e) => manejarCambio('modoActivacion', e.target.value)}
                >
                  <option value="ambos">Por Tiempo de vida y Cantidad de usos</option>
                  <option value="tiempo">Solo por Tiempo de vida (Sin límite de usos)</option>
                  <option value="usos">Solo por Cantidad de usos</option>
                </select>
              </div>

              {(formulario.modoActivacion === 'tiempo' ||
                formulario.modoActivacion === 'ambos') && (
                <div className="filter-group">
                  <label htmlFor="inv-ventana">Tiempo de vida del QR</label>
                  <select
                    id="inv-ventana"
                    value={formulario.ventanaSegundos}
                    onChange={(e) => manejarCambio('ventanaSegundos', e.target.value)}
                  >
                    <option value="1800">30 minutos</option>
                    <option value="3600">1 hora (Por defecto)</option>
                    <option value="7200">2 horas</option>
                    <option value="14400">4 horas</option>
                    <option value="28800">8 horas (Jornada completa)</option>
                    <option value="86400">24 horas (1 día)</option>
                  </select>
                </div>
              )}

              {(formulario.modoActivacion === 'usos' ||
                formulario.modoActivacion === 'ambos') && (
                <div className="filter-group">
                  <label htmlFor="inv-usos">Cantidad de usos permitidos</label>
                  <input
                    id="inv-usos"
                    type="number"
                    min="1"
                    max="50"
                    value={formulario.maxUsos}
                    onChange={(e) => manejarCambio('maxUsos', e.target.value)}
                    placeholder="Ej. 2 (1 entrada + 1 salida)"
                    required
                  />
                  <small style={{ color: '#718096', fontSize: '0.78rem', marginTop: '0.2rem' }}>
                    Ej: 1 uso (solo entrada), 2 usos (1 entrada + 1 salida), 4 usos, etc.
                  </small>
                </div>
              )}

              <div className="invitacion-actions invitacion-full">
                <button
                  type="submit"
                  className="apply-filters-button"
                  disabled={enviando}
                >
                  {enviando
                    ? 'Registrando y generando QR...'
                    : 'Registrar Ingreso y Generar Código QR'}
                </button>
                <button
                  type="button"
                  className="clear-filters-button"
                  onClick={() => {
                    setFormulario(FORMULARIO_INICIAL);
                    setPersonaExistente(false);
                    setError('');
                    setMensajeExito('');
                  }}
                >
                  Limpiar Formulario
                </button>
              </div>
            </form>
          </section>

          <section className="invitacion-card">
            <h3 className="chart-title">Código QR Generado</h3>
            {!qrGenerado ? (
              <p className="chart-empty">
                Completa el formulario de la izquierda y pulsa{' '}
                <strong>&quot;Registrar Ingreso y Generar Código QR&quot;</strong> para ver el
                pase aquí mismo o enviarlo por correo electrónico.
              </p>
            ) : (
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
                    <span className="modal-detail-label">Estado de conexión con UniFi Access</span>
                    <p className="modal-detail-value">
                      {String(qrGenerado.unifi_visitor_id || '').startsWith('sim-')
                        ? '⚠️ Modo de prueba local (Sin conexión a 192.168.40.178:12445 — este QR no abrirá la puerta física hasta conectar a la red .40.x)'
                        : `✅ QR Oficial de UniFi Access (ID: ${qrGenerado.unifi_visitor_id}) — Listo para lector G3 Reader Pro`}
                    </p>
                  </div>
                  <div className="modal-detail-item">
                    <span className="modal-detail-label">Persona registrada</span>
                    <p className="modal-detail-value">
                      {qrGenerado.nombre_completo} (C.C. {qrGenerado.cedula})
                    </p>
                  </div>
                  <div className="modal-detail-item">
                    <span className="modal-detail-label">Motivo de la visita</span>
                    <p className="modal-detail-value">{qrGenerado.motivo}</p>
                  </div>
                  <div className="modal-detail-item">
                    <span className="modal-detail-label">Vigencia configurada del QR</span>
                    <p className="modal-detail-value">
                      {Number(qrGenerado.max_usos) === 0 ? (
                        <>
                          Solo por Tiempo de vida (Sin límite de usos) · Vence a las{' '}
                          {new Date(Number(qrGenerado.fin_timestamp) * 1000).toLocaleTimeString(
                            'es-CO',
                            { hour: '2-digit', minute: '2-digit' }
                          )}
                        </>
                      ) : qrGenerado.modo_activacion === 'usos' ? (
                        <>
                          Solo por Cantidad de usos ({qrGenerado.usos_actuales} de{' '}
                          {qrGenerado.max_usos}{' '}
                          {Number(qrGenerado.max_usos) === 1 ? 'uso configurado' : 'usos configurados'}
                          )
                        </>
                      ) : (
                        <>
                          {qrGenerado.usos_actuales} de {qrGenerado.max_usos}{' '}
                          {Number(qrGenerado.max_usos) === 1 ? 'uso configurado' : 'usos configurados'}{' '}
                          · Vence a las{' '}
                          {new Date(Number(qrGenerado.fin_timestamp) * 1000).toLocaleTimeString(
                            'es-CO',
                            { hour: '2-digit', minute: '2-digit' }
                          )}
                        </>
                      )}
                    </p>
                  </div>
                </div>

                <div className="invitacion-email-row">
                  <input
                    type="email"
                    placeholder="Correo electrónico para enviar el QR..."
                    value={correoReenvio}
                    onChange={(e) => setCorreoReenvio(e.target.value)}
                  />
                  <button
                    type="button"
                    className="apply-filters-button"
                    onClick={manejarEnviarPorCorreo}
                    disabled={enviandoCorreo || !correoReenvio.trim()}
                  >
                    {enviandoCorreo ? 'Enviando...' : 'Enviar al Correo'}
                  </button>
                </div>

                {qrGenerado.qr_base64 && (
                  <a
                    href={qrGenerado.qr_base64}
                    download={`qr_ingreso_${qrGenerado.cedula}.png`}
                    className="download-qr-button"
                  >
                    Descargar Código QR (PNG)
                  </a>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
};

export default Invitacion;
