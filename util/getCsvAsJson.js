import httpClient from '@/lib/http/client';
import Papa from 'papaparse';

export default async function getCsvAsJson(url, cacheCategory) {
  const body = await httpClient.get(url, {
    responseType: 'text',
    ...(cacheCategory ? { cache: cacheCategory } : {}),
  });

  return Papa.parse(body.data).data;
}
