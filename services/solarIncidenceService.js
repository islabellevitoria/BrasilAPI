import httpClient from '@/lib/http/client';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';

// Geocoding via Open-Meteo (gratuito, sem key, sem rate-limit agressivo).
// O Nominatim do OpenStreetMap rate-limita IPs compartilhados (429) —
// os IPs da Vercel estouravam o limite de 1 req/s.
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

export class LocationNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocationNotFoundError';
  }
}

// Função para converter localização em coordenadas
const getCoordinates = async (location) => {
  const response = await httpClient.get(GEOCODE_URL, {
    params: {
      name: location,
      count: 1,
      language: 'pt',
      format: 'json',
    },
    timeout: 10000,
    cache: CACHE_CATEGORY.GEOCODING,
  });

  const result = response.data?.results?.[0];

  if (!result) {
    throw new LocationNotFoundError('Localização não encontrada');
  }

  return { lat: result.latitude, lon: result.longitude };
};

export const getSolarIncidence = async (location) => {
  const { lat, lon } = await getCoordinates(location);
  const response = await httpClient.get(
    `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`,
    { timeout: 10000, cache: CACHE_CATEGORY.SOLAR }
  );

  return response.data.results;
};
