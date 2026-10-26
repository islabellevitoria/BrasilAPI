import httpClient from '@/lib/http/client';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';

const BASE_URL = 'https://api.universities.com.br';

const filterUniversitiesResponse = (university) => {
  const {
    id,
    full_name: fullName,
    name,
    ibge,
    city,
    uf,
    zipcode,
    street,
    number,
    neighborhood,
    phone,
  } = university;

  return {
    id,
    full_name: fullName,
    name,
    ibge,
    city,
    uf,
    zipcode,
    street,
    number,
    neighborhood,
    phone,
  };
};

export const getUniversities = async () => {
  const endpoint = '/universities';

  const { data: body } = await httpClient.get(BASE_URL + endpoint, {
    cache: CACHE_CATEGORY.UNIVERSITIES,
  });

  return body.map(filterUniversitiesResponse);
};

export const getUniversitiesById = async (id) => {
  const endpoint = `/universities/${id}`;

  const { data: body } = await httpClient.get(BASE_URL + endpoint, {
    cache: CACHE_CATEGORY.UNIVERSITIES,
  });

  const data = filterUniversitiesResponse(body);

  if (JSON.stringify(data) === '{}' || !data) {
    return null;
  }

  return data;
};
