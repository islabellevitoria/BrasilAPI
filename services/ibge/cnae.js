import httpClient from '@/lib/http/client';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';

const CNAE_URL = 'https://servicodados.ibge.gov.br/api/v2/cnae';

export const getCNAEClasses = () => httpClient.get(`${CNAE_URL}/classes`, { cache: CACHE_CATEGORY.IBGE });

export const getCNAEClassById = (id) => httpClient.get(`${CNAE_URL}/classes/${id}`, { cache: CACHE_CATEGORY.IBGE });

export const getCNAEClassesByDivision = (division) =>
  httpClient.get(`${CNAE_URL}/divisoes/${division}/classes`, { cache: CACHE_CATEGORY.IBGE });

export const getCNAEClassesByGroup = (group) =>
  httpClient.get(`${CNAE_URL}/grupos/${group}/classes`, { cache: CACHE_CATEGORY.IBGE });
