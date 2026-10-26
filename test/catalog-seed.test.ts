import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { openCatalog } from '../src/catalog.ts';
import type { CatalogProduct } from '../src/catalog.ts';
import { exportSeed, importSeed, seedCatalogIfMissing } from '../src/catalog-seed.ts';

const product = (id: string, name: string, extra: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id, name, brand: 'Marca', category: 'Farmacia', categories: 'Farmacia', ingredients: 'Paracetamol', presentation: null,
  dose: null, sale_type: 'libre', ean: null, price: 1000, list_price: 1000, description: 'd', url: `https://example.test/${id}`,
  image_url: null, scraped_at: '2026-03-04T00:00:00.000Z', ...extra,
});

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'farmacia-seed-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('exportar e importar conserva los productos y la búsqueda funciona', () => {
  withTempDir((dir) => {
    const source = openCatalog(join(dir, 'a.db'));
    source.upsert(product('1', 'Paracetamol 500 mg x 20 Comp'));
    source.upsert(product('2', 'Termómetro Digital', { ingredients: null, sale_type: 'otro' }));
    source.reindex();
    source.close();

    assert.equal(exportSeed(join(dir, 'a.db'), join(dir, 'seed', 'catalog.json.gz')), 2);
    assert.equal(importSeed(join(dir, 'seed', 'catalog.json.gz'), join(dir, 'data', 'b.db')), 2);

    const copy = openCatalog(join(dir, 'data', 'b.db'), true);
    try {
      assert.equal(copy.count(), 2);
      assert.equal(copy.search('paracetamol')[0].id, '1');
      assert.equal(copy.search('termometro')[0].id, '2');
    } finally {
      copy.close();
    }
    assert.equal(existsSync(join(dir, 'data', 'b.db.importing')), false, 'no queda el archivo temporal');
  });
});

test('seedCatalogIfMissing solo importa cuando falta el catálogo', () => {
  withTempDir((dir) => {
    const source = openCatalog(join(dir, 'a.db'));
    source.upsert(product('1', 'Paracetamol 500 mg'));
    source.reindex();
    source.close();
    exportSeed(join(dir, 'a.db'), join(dir, 'seed.gz'));

    assert.equal(seedCatalogIfMissing(join(dir, 'b.db'), join(dir, 'no-existe.gz')), undefined, 'sin semilla no hace nada');
    assert.equal(seedCatalogIfMissing(join(dir, 'b.db'), join(dir, 'seed.gz')), 1);
    assert.equal(seedCatalogIfMissing(join(dir, 'b.db'), join(dir, 'seed.gz')), undefined, 'si ya hay catálogo no lo pisa');
  });
});

test('una semilla dañada o vacía falla sin dejar un catálogo a medias', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'vacia.gz'), gzipSync(JSON.stringify([{ cualquier: 'cosa' }])));
    assert.throws(() => importSeed(join(dir, 'vacia.gz'), join(dir, 'b.db')), /no tiene productos válidos/);
    writeFileSync(join(dir, 'rota.gz'), 'esto no es gzip');
    assert.throws(() => importSeed(join(dir, 'rota.gz'), join(dir, 'b.db')));
    assert.equal(existsSync(join(dir, 'b.db')), false);
    assert.equal(existsSync(join(dir, 'b.db.importing')), false);
  });
});
