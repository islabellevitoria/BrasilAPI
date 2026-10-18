/**
 * lib/http/cache/categories.js
 * Constantes de categoria derivadas do categories.json.
 */

import categoriesData from './categories.json';

const { categories } = categoriesData;

export const CACHE_CATEGORY = Object.freeze(
  categories.reduce((acc, cat) => {
    const key = cat.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    acc[key] = cat.name;
    return acc;
  }, {})
);
