/** Prueba rápida de búsqueda sobre el catálogo: npm run catalog:search -- ibuprofeno 400 */
import { join } from 'node:path';
import { openCatalog } from '../src/catalog.ts';
import { env } from '../src/config.ts';

const query = process.argv.slice(2).join(' ');
if (!query) {
  console.error('Uso: npm run catalog:search -- <texto a buscar>');
  process.exit(1);
}

const catalog = openCatalog(process.env.CATALOG_DB || join(env.dataDir, 'catalog.db'), true);
const results = catalog.search(query, 8);
if (!results.length) console.log('Sin resultados.');
for (const p of results) {
  const price = p.price == null ? 's/precio' : `$${p.price.toLocaleString('es-AR')}`;
  console.log(`${p.name}  —  ${price}  [${p.sale_type}]  ${p.ingredients ? `(${p.ingredients})` : ''}`);
}
catalog.close();
