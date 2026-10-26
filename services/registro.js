import httpClient from '@/lib/http/client';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';

/**
 * ### Avalia o dominio no registro.br
 * @see https://registro.br/dominio/regras/
 * @param {string} domain
 * @author Guilherme Neves <guilhermeasn@yahoo.com.br>
 */
export default function getRegistroBrAvail(domain) {
  if (
    typeof domain !== 'string' ||
    !domain.length ||
    /[^A-Za-z0-9àáâãéêíóôõúüç.-]/.test(domain)
  )
    throw new Error('O domínio não foi informado corretamente!');
  return httpClient.get(`https://registro.br/v2/ajax/avail/raw/${domain}`, {
    cache: CACHE_CATEGORY.REGISTROBR,
  });
}
