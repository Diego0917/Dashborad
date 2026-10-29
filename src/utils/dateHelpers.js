import { 
  startOfDay, 
  endOfDay, 
  subDays, 
  startOfWeek, 
  endOfWeek, 
  subWeeks, 
  startOfMonth, 
  endOfMonth 
} from 'date-fns';

export const obtenerRangoFechas = (periodo, fechaInicioPersonalizada = null, fechaFinPersonalizada = null) => {
  const hoy = new Date();
  
  switch (periodo) {
    case 'hoy':
      return {
        inicio: startOfDay(hoy),
        fin: endOfDay(hoy)
      };
    case 'ayer': {
      const ayer = subDays(hoy, 1);
      return {
        inicio: startOfDay(ayer),
        fin: endOfDay(ayer)
      };
    }
    case 'anteayer': {
      const anteayer = subDays(hoy, 2);
      return {
        inicio: startOfDay(anteayer),
        fin: endOfDay(anteayer)
      };
    }
    case '7dias': {
      const haceSieteDias = subDays(hoy, 6);
      return {
        inicio: startOfDay(haceSieteDias),
        fin: endOfDay(hoy)
      };
    }
    case 'semana': {
      return {
        inicio: startOfWeek(hoy, { weekStartsOn: 1 }),
        fin: endOfWeek(hoy, { weekStartsOn: 1 })
      };
    }
    case 'semanapasada': {
      const semanaPasada = subWeeks(hoy, 1);
      return {
        inicio: startOfWeek(semanaPasada, { weekStartsOn: 1 }),
        fin: endOfWeek(semanaPasada, { weekStartsOn: 1 })
      };
    }
    case '30dias': {
      const haceTreintaDias = subDays(hoy, 29);
      return {
        inicio: startOfDay(haceTreintaDias),
        fin: endOfDay(hoy)
      };
    }
    case 'mes': {
      return {
        inicio: startOfMonth(hoy),
        fin: endOfMonth(hoy)
      };
    }
    case 'personalizado': {
      if (fechaInicioPersonalizada && fechaFinPersonalizada) {
        return {
          inicio: startOfDay(new Date(fechaInicioPersonalizada)),
          fin: endOfDay(new Date(fechaFinPersonalizada))
        };
      }
      return {
        inicio: startOfDay(hoy),
        fin: endOfDay(hoy)
      };
    }
    default:
      return {
        inicio: startOfDay(hoy),
        fin: endOfDay(hoy)
      };
  }
};

export const formatearFechaParaAPI = (fecha) => {
  return fecha.toISOString();
};
