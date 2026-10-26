import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { openCatalog } from './catalog.ts';
import type { CatalogProduct } from './catalog.ts';

/** Guarda todo el catálogo en un solo archivo comprimido (JSON), apto para versionar junto con el código. */
export function exportSeed(catalogFile: string, seedFile: string): number {
  const catalog = openCatalog(catalogFile, true);
  try {
    const products = catalog.all();
    mkdirSync(dirname(seedFile), { recursive: true });
    writeFileSync(seedFile, gzipSync(JSON.stringify(products)));
    return products.length;
  } finally {
    catalog.close();
  }
}

const isProduct = (p: unknown): p is CatalogProduct =>
  typeof p === 'object' && p !== null &&
  typeof (p as CatalogProduct).id === 'string' &&
  typeof (p as CatalogProduct).name === 'string' &&
  typeof (p as CatalogProduct).url === 'string';

/**
 * Crea el catálogo desde el archivo semilla. Se arma en un archivo temporal y se renombra al final,
 * así un corte a mitad de camino no deja un catálogo incompleto que impida reintentar.
 */
export function importSeed(seedFile: string, catalogFile: string): number {
  const products = JSON.parse(gunzipSync(readFileSync(seedFile)).toString('utf8')) as unknown;
  if (!Array.isArray(products)) throw new Error('El archivo semilla no tiene el formato esperado');

  mkdirSync(dirname(catalogFile), { recursive: true });
  const tmp = `${catalogFile}.importing`;
  rmSync(tmp, { force: true });

  const catalog = openCatalog(tmp);
  let count = 0;
  try {
    for (const p of products) {
      if (!isProduct(p)) continue;
      catalog.upsert(p);
      count++;
    }
    catalog.reindex();
  } finally {
    catalog.close();
  }
  if (count === 0) {
    rmSync(tmp, { force: true });
    throw new Error('El archivo semilla no tiene productos válidos');
  }
  renameSync(tmp, catalogFile);
  return count;
}

/** Si todavía no hay catálogo y existe la semilla, la importa. Devuelve la cantidad importada. */
export function seedCatalogIfMissing(catalogFile: string, seedFile: string): number | undefined {
  if (existsSync(catalogFile) || !existsSync(seedFile)) return undefined;
  return importSeed(seedFile, catalogFile);
}
