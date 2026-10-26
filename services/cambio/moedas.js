import httpClient from '@/lib/http/client';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';

export const getCurrency = async () => {
  const resp = await httpClient.get(
    'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/Moedas?$top=100&$format=json',
    { cache: CACHE_CATEGORY.CAMBIO }
  );

  return new Map(
    resp.data.value.map((currency) => [
      currency.simbolo,
      {
        simbolo: currency.simbolo,
        nome: currency.nomeFormatado,
        tipo_moeda: currency.tipoMoeda,
      },
    ])
  );
};
