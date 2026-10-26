import httpClient from '@/lib/http/client';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';

export const getDddsData = async () => {
  const url =
    'https://www.anatel.gov.br/dadosabertos/PDA/Codigo_Nacional/PGCN.csv';
  const LINE_BREAK = '\r\n';

  const response = await httpClient.get(url, {
    responseType: 'text',
    encoding: 'binary',
    cache: CACHE_CATEGORY.DDD,
  });

  const body = response.data;

  const lines = body.split(LINE_BREAK);

  lines.shift();

  return lines
    .map((line) => line.split(';'))
    .map(([ibgeCode, state, city, ddd]) => {
      return {
        ibgeCode,
        state,
        city,
        ddd,
      };
    });
};
