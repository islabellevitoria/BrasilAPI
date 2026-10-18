import httpClient from '@/lib/http/client';
import { ELECTIONS_API_URL, ELECTIONS_YEARS_URL } from './constants';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';

export const listElectionYears = async () => {
  try {
    const response = await httpClient.get(
      `${ELECTIONS_API_URL}${ELECTIONS_YEARS_URL}`,
      { cache: CACHE_CATEGORY.ELEICOES }
    );

    return response.data;
  } catch (error) {
    const err = new Error('Falha ao buscar anos eleitorais.');
    err.name = 'ElectionYearsPromiseError';
    err.original = error;
    throw err;
  }
};
