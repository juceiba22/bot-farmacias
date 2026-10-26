import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

export type SaleType = 'libre' | 'receta' | 'otro';

export type CatalogProduct = {
  id: string;
  name: string;
  brand: string | null;
  category: string;
  categories: string;
  ingredients: string | null;
  presentation: string | null;
  dose: string | null;
  sale_type: SaleType;
  ean: string | null;
  price: number | null;
  list_price: number | null;
  description: string;
  url: string;
  image_url: string | null;
  scraped_at: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT NOT NULL,
  categories TEXT NOT NULL,
  ingredients TEXT,
  presentation TEXT,
  dose TEXT,
  sale_type TEXT NOT NULL CHECK (sale_type IN ('libre', 'receta', 'otro')),
  ean TEXT,
  price REAL,
  list_price REAL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  image_url TEXT,
  scraped_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name, brand, ingredients, categories,
  content = 'products', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export function openCatalog(file: string, readOnly = false) {
  const db = new DatabaseSync(file, { readOnly });
  if (!readOnly) db.exec(SCHEMA);
  const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as T[];

  return {
    close: () => db.close(),

    upsert(p: CatalogProduct) {
      db.prepare(
        `INSERT INTO products (id, name, brand, category, categories, ingredients, presentation, dose, sale_type,
           ean, price, list_price, description, url, image_url, scraped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, brand = excluded.brand, category = excluded.category,
           categories = excluded.categories, ingredients = excluded.ingredients, presentation = excluded.presentation,
           dose = excluded.dose, sale_type = excluded.sale_type, ean = excluded.ean, price = excluded.price,
           list_price = excluded.list_price, description = excluded.description, url = excluded.url,
           image_url = excluded.image_url, scraped_at = excluded.scraped_at`,
      ).run(
        p.id, p.name, p.brand, p.category, p.categories, p.ingredients, p.presentation, p.dose, p.sale_type,
        p.ean, p.price, p.list_price, p.description, p.url, p.image_url, p.scraped_at,
      );
    },

    /** Reconstruye el índice de búsqueda; se llama al terminar de cargar. */
    reindex() {
      db.exec("INSERT INTO products_fts (products_fts) VALUES ('rebuild')");
    },

    get: (id: string) => all<CatalogProduct>('SELECT * FROM products WHERE id = ?', id).map((row) => ({ ...row }))[0],

    all: () => all<CatalogProduct>('SELECT * FROM products ORDER BY id').map((row) => ({ ...row })),

    count: () => (db.prepare('SELECT COUNT(*) AS n FROM products').get() as unknown as { n: number }).n,

    stats: () =>
      all<{ category: string; sale_type: SaleType; n: number }>(
        'SELECT category, sale_type, COUNT(*) AS n FROM products GROUP BY category, sale_type ORDER BY n DESC'),

    /** Busca por nombre, marca, principio activo o categoría. Primero exige todas las palabras; si no hay nada, acepta cualquiera. */
    search(query: string, limit = 5): CatalogProduct[] {
      const tokens = query.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
      if (!tokens.length) return [];
      const run = (joiner: string) =>
        all<CatalogProduct>(
          `SELECT p.* FROM products_fts f JOIN products p ON p.rowid = f.rowid
           WHERE products_fts MATCH ? ORDER BY bm25(products_fts, 10, 3, 5, 1) LIMIT ?`,
          tokens.map((t) => `"${t}"*`).join(joiner), limit,
        ).map((row) => ({ ...row }));
      const strict = run(' AND ');
      return strict.length || tokens.length === 1 ? strict : run(' OR ');
    },
  };
}

export type Catalog = ReturnType<typeof openCatalog>;
