import httpClient from '@/lib/http/client';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';

const URL_UF = 'http://educacao.dadosabertosbr.com/api/cidades';

export const getCities = async (uf) => {
  const { data } = await httpClient.get(`${URL_UF}/${uf}`, {
    cache: CACHE_CATEGORY.IBGE,
  });

  return data.map((item) => {
    const [ibgeCode, name] = item.split(':');
    return { nome: name, codigo_ibge: ibgeCode };
  });
};
